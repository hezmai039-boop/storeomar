// Pluggable LLM call for the AI agent's phrased replies. Returns null when
// no key is configured, so the confidence-gate pipeline (aiPipeline.ts)
// falls back to returning the retrieved knowledge-base text verbatim —
// the whole flow runs end-to-end with zero external keys, and upgrades to
// a properly phrased reply the moment ANTHROPIC_API_KEY is set. No other
// code changes when that key is added.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

export async function generateGroundedAnswer(params: {
  storeName: string;
  persona: unknown;
  knowledgeContext: string;
  question: string;
}): Promise<string | null> {
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
  const json = (await resp.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = json.content?.find((b) => b.type === "text")?.text;
  return text ?? null;
}
