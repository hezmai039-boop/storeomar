// Pluggable LLM call for the AI agent's phrased replies. Returns null when
// no key is configured, so the confidence-gate pipeline (aiPipeline.ts)
// falls back to returning the retrieved knowledge-base text verbatim —
// the whole flow runs end-to-end with zero external keys, and upgrades to
// a properly phrased reply the moment ANTHROPIC_API_KEY is set. No other
// code changes when that key is added.

import type { TokenUsage } from "./llmPricing";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

/**
 * The provider returns token counts on every successful call, and they are
 * the ONLY trustworthy input to cost metering — estimating from string
 * length ignores the system prompt, the knowledge context, tokenizer
 * specifics and cache behavior, and drifts by tens of percent. Discarding
 * that block (as this module used to) makes real per-store AI cost
 * unknowable after the fact, since the request is never replayable.
 *
 * `usage` stays nullable so a response we could parse text from but not
 * usage from still answers the customer — metering is best-effort, replying
 * is not.
 */
export interface GroundedAnswer {
  text: string | null;
  usage: TokenUsage | null;
  /** The model actually billed, carried alongside usage so pricing never has to guess. */
  model: string;
}

export async function generateGroundedAnswer(params: {
  storeName: string;
  persona: unknown;
  knowledgeContext: string;
  question: string;
}): Promise<GroundedAnswer | null> {
  // Still `null` (not an empty GroundedAnswer) when unconfigured: callers
  // treat null as "no LLM available, use the fallback path", and that
  // key-less behavior must stay byte-for-byte unchanged.
  if (!ANTHROPIC_API_KEY) return null;

  const system = [
    `أنت وكيل خدمة عملاء لمتجر "${params.storeName}".`,
    `أجب بإيجاز وبأسلوب ودود، بالاعتماد حصرًا على المعلومات التالية من قاعدة معرفة هذا المتجر ولا شيء غيرها:`,
    params.knowledgeContext,
    `إن لم تكفِ هذه المعلومات للإجابة بثقة، قل ذلك صراحة بدل التخمين.`,
  ].join("\n\n");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: params.question }],
    }),
  });

  if (!resp.ok) {
    console.error(`Anthropic API error: ${resp.status} ${await resp.text()}`);
    return null;
  }
  const json = (await resp.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = json.content?.find((b) => b.type === "text")?.text;

  const inputTokens = json.usage?.input_tokens;
  const outputTokens = json.usage?.output_tokens;
  const usage: TokenUsage | null =
    typeof inputTokens === "number" && typeof outputTokens === "number" ? { inputTokens, outputTokens } : null;

  return { text: text ?? null, usage, model: MODEL };
}
