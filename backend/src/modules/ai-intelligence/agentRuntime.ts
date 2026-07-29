import { z } from "zod";
import { ToolDefinition } from "./tools/types";
import type { TokenUsage } from "../../lib/llmPricing";

// Same pluggable-LLM philosophy as src/lib/llm.ts: no key configured ->
// every function here returns a "no answer" result, and callers fall back
// exactly the way aiPipeline.ts already does. Deliberately a separate file
// from llm.ts rather than an edit to it — llm.ts's single-shot
// generateGroundedAnswer is still the only thing the live webhook path
// calls (src/modules/channels/webhook.ts), and stays untouched.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
const MAX_TOOL_ROUNDS = 4;

// ------------------------------------------------------------------
// Minimal zod -> JSON Schema conversion, covering only the shapes this
// module's tools actually use (object/string/number/boolean/optional/
// enum, plus unwrapping a top-level .refine()). Not a general-purpose
// converter — pulling in a "zod-to-json-schema" dependency for ~10 small,
// known-shape tool schemas would be more moving parts for less clarity
// than these ~20 lines, and this is covered directly by unit tests
// (see ai-intelligence/__tests__/agentRuntime.test.ts).
// ------------------------------------------------------------------

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
}

function isOptionalZodType(def: { typeName?: string }): boolean {
  return def.typeName === "ZodOptional";
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._def;
  switch (def.typeName) {
    case "ZodObject": {
      const shape = def.shape();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const v = value as z.ZodTypeAny;
        properties[key] = zodToJsonSchema(v);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!isOptionalZodType((v as any)._def)) required.push(key);
      }
      return { type: "object", properties, required };
    }
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodOptional":
      return zodToJsonSchema(def.innerType);
    case "ZodEnum":
      return { type: "string", enum: def.values };
    case "ZodEffects":
      // .refine()/.superRefine() wrap the base schema — the JSON Schema we
      // hand to the model only needs the underlying shape; the runtime
      // zod validation (which DOES enforce the refinement) still runs on
      // every tool call in orchestrator.ts before the handler executes.
      return zodToJsonSchema(def.schema);
    default:
      return {};
  }
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export interface AgentToolCall {
  toolKey: string;
  args: unknown;
  result: unknown;
}

// ------------------------------------------------------------------
// Usage metering for the tool loop.
//
// The single-shot path (src/lib/llm.ts) has always surfaced the provider's
// `usage` block; this loop used to throw it away, which made the ADVANCED
// engine — the expensive one, by construction — the only unmetered spend in
// the platform. A store on "الذكاء المتقدم" was therefore billed below its
// real cost, and the platform could not see its margin on precisely the
// customers costing it the most.
// ------------------------------------------------------------------

function isTokenCount(value: unknown): value is number {
  // Number.isFinite rather than a bare `typeof === "number"` because a NaN
  // admitted here poisons the WHOLE run's accumulated total, not just its
  // own turn. An unknown cost is recoverable (the column stays NULL and the
  // gap is visible); a silently wrong one is not.
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Reads one round-trip's `usage` block out of a raw Anthropic response.
 *
 * Defensive by contract, exactly like lib/llm.ts: metering is best-effort,
 * answering the customer is not. A response we can still read text or
 * tool_use blocks from, but whose usage block is missing or malformed, must
 * yield `null` — never an exception on the reply path.
 *
 * Exported for the unit tests (same reason zodToJsonSchema is).
 */
export function readTurnUsage(json: unknown): TokenUsage | null {
  const usage = (json as { usage?: unknown } | null | undefined)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const { input_tokens: input, output_tokens: output } = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
  if (!isTokenCount(input) || !isTokenCount(output)) return null;
  return { inputTokens: input, outputTokens: output };
}

/**
 * Folds one turn's usage into the running total for the whole agent run.
 *
 * WHY A SUM AND NOT THE LAST TURN: this engine is a multi-round tool loop —
 * one customer message costs one API call per round (up to
 * MAX_TOOL_ROUNDS), and every round re-sends the full, growing transcript
 * plus the accumulated tool results. Reporting only the final turn would
 * therefore understate the cost of exactly the conversations that cost the
 * most — the ones that needed the most tools — which is the opposite of
 * what per-store margin reporting exists to show.
 *
 * `null` stays `null` until some turn actually reports usage, because
 * absent must remain distinguishable from zero all the way down to the
 * nullable ai_response_logs columns: a run with no API key, or one that
 * fails before its first response, has to write NULL rather than a
 * misleading 0.
 */
export function addTurnUsage(total: TokenUsage | null, turn: TokenUsage | null): TokenUsage | null {
  if (!turn) return total;
  if (!total) return { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens };
  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
  };
}

export interface AgentRunResult {
  replyText: string | null;
  toolCalls: AgentToolCall[];
  /**
   * Tokens summed over EVERY round-trip this single customer message took.
   * Null (not zero) when nothing billable happened or when the provider
   * never gave us a usable usage block — see addTurnUsage.
   */
  usage: TokenUsage | null;
  /** The model actually billed, carried alongside usage so pricing never has to guess. */
  model: string;
  /**
   * How many provider round-trips this run actually made. Not billed off —
   * cost comes from `usage` — but it is the number that explains why an
   * advanced-engine reply costs several times a classic one, so it is worth
   * having at the call site rather than inferring it from toolCalls.length
   * (a single round can request several tools at once).
   */
  roundTrips: number;
}

/**
 * Runs a real multi-round Anthropic tool-use conversation: the model may
 * request 0+ tools, we execute them via `executeTool` and feed results
 * back, up to MAX_TOOL_ROUNDS, until it returns a final text answer.
 * Intentionally holds no database transaction open across these network
 * round-trips — see the comment on gatherOrchestratorContext in
 * orchestrator.ts for why (same reasoning aiPipeline.ts already documents
 * for the single-shot case).
 */
export async function runAgentWithTools(params: {
  systemPrompt: string;
  question: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: ToolDefinition<any, any>[];
  executeTool: (toolKey: string, args: unknown) => Promise<unknown>;
}): Promise<AgentRunResult> {
  // usage stays null here, never { 0, 0 }: no key means no call was ever
  // made, which is "we spent nothing knowable", not "we spent zero".
  if (!ANTHROPIC_API_KEY) return { replyText: null, toolCalls: [], usage: null, model: MODEL, roundTrips: 0 };

  const toolCalls: AgentToolCall[] = [];
  // Accumulated across the whole loop, not per turn — see addTurnUsage.
  let usage: TokenUsage | null = null;
  let roundTrips = 0;
  const anthropicTools = params.tools.map((t) => ({
    name: t.key,
    description: t.description,
    input_schema: zodToJsonSchema(t.inputSchema),
  }));

  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: params.question },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // The fetch and the body parse are both inside the try. Only an HTTP
    // error response was handled before, so a socket reset, DNS failure or
    // truncated body on round 3 rejected straight out of this function —
    // discarding the usage already accumulated from rounds 1 and 2, which
    // was real spend, and rejecting up through completeAiReply into webhook
    // Phase 3, which has no try/catch, so the channel got a 500 and the
    // platform started retrying. Both outcomes are worse than answering
    // nothing: return what the run cost and let the caller escalate.
    let resp: Response;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 700,
          system: params.systemPrompt,
          tools: anthropicTools,
          messages,
        }),
      });
    } catch (err) {
      console.error(`Anthropic transport error (agent runtime): ${(err as Error).message}`);
      return { replyText: null, toolCalls, usage, model: MODEL, roundTrips };
    }

    roundTrips++;

    if (!resp.ok) {
      console.error(`Anthropic API error (agent runtime): ${resp.status} ${await resp.text()}`);
      // A failed round is unbilled, but the rounds BEFORE it were real
      // spend — returning the accumulated total keeps a run that died
      // mid-loop from silently erasing what it had already cost.
      return { replyText: null, toolCalls, usage, model: MODEL, roundTrips };
    }

    let json: { content: AnthropicContentBlock[] };
    try {
      json = (await resp.json()) as { content: AnthropicContentBlock[] };
    } catch (err) {
      console.error(`Anthropic response parse failed (agent runtime): ${(err as Error).message}`);
      return { replyText: null, toolCalls, usage, model: MODEL, roundTrips };
    }

    // Metered immediately, before any branch below can return: every exit
    // path from this round onwards has already been paid for, so none of
    // them may drop the turn.
    usage = addTurnUsage(usage, readTurnUsage(json));

    const toolUseBlocks = json.content.filter((b): b is AnthropicToolUseBlock => b.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      const text = json.content.find((b): b is AnthropicTextBlock => b.type === "text")?.text ?? null;
      return { replyText: text, toolCalls, usage, model: MODEL, roundTrips };
    }

    messages.push({ role: "assistant", content: json.content });

    const toolResultBlocks = [];
    for (const block of toolUseBlocks) {
      let result: unknown;
      try {
        result = await params.executeTool(block.name, block.input);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : "فشل تنفيذ الأداة" };
      }
      toolCalls.push({ toolKey: block.name, args: block.input, result });
      toolResultBlocks.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: toolResultBlocks });
  }

  // Exhausted MAX_TOOL_ROUNDS without a final text answer — caller treats
  // a null replyText as low confidence and escalates, same as every other
  // "the model didn't give us something to say" path in this module.
  //
  // This is the single most expensive outcome the platform can have (the
  // full round limit, spent, with nothing to say to the customer), so it is
  // the last place that may go unmetered: the accumulated usage is returned
  // even though there is no reply to attribute it to.
  return { replyText: null, toolCalls, usage, model: MODEL, roundTrips };
}
