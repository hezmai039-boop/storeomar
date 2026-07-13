import { z } from "zod";
import { ToolDefinition } from "./tools/types";

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

export interface AgentRunResult {
  replyText: string | null;
  toolCalls: AgentToolCall[];
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
  if (!ANTHROPIC_API_KEY) return { replyText: null, toolCalls: [] };

  const toolCalls: AgentToolCall[] = [];
  const anthropicTools = params.tools.map((t) => ({
    name: t.key,
    description: t.description,
    input_schema: zodToJsonSchema(t.inputSchema),
  }));

  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: params.question },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
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

    if (!resp.ok) {
      console.error(`Anthropic API error (agent runtime): ${resp.status} ${await resp.text()}`);
      return { replyText: null, toolCalls };
    }

    const json = (await resp.json()) as { content: AnthropicContentBlock[] };
    const toolUseBlocks = json.content.filter((b): b is AnthropicToolUseBlock => b.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      const text = json.content.find((b): b is AnthropicTextBlock => b.type === "text")?.text ?? null;
      return { replyText: text, toolCalls };
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
  return { replyText: null, toolCalls };
}
