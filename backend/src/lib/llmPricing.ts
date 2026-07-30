// Provider price table + cost maths for every LLM call Maysoor makes.
//
// WHY MICRO-USD INTEGERS (and not floats, and not cents):
// a single grounded reply is on the order of 900 input + 150 output tokens,
// i.e. roughly $0.0050 — a fraction of a cent. Stored in cents that rounds
// to 0 (or to 1, a 100% error), so a month of real traffic reports a cost of
// "zero" and the per-customer margin the whole plan pricing depends on
// becomes invisible. Stored as floats it accumulates binary rounding drift
// across hundreds of thousands of additions and stops reconciling against
// the provider's own invoice. Micro-USD (USD × 1_000_000) keeps a single
// reply at ~5000 — an exact integer, safely summable in Postgres BIGINT,
// and still four orders of magnitude of headroom before a plain JS Number
// loses precision.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
}

// Keyed by the exact model id we send to the provider, so a model swap in
// ANTHROPIC_MODEL / ai_agents.model_name is priced correctly with no code
// change as long as its row exists here.
const PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  "claude-opus-4-8": { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  "claude-haiku-4-5": { inputPerMillion: 1.0, outputPerMillion: 5.0 },
};

const DEFAULT_MODEL = "claude-sonnet-5";

// An unknown model must never break metering or throw in the reply path, so
// we fall back to the default rate. But warning per call would print once
// per inbound message forever; this set makes it exactly once per unknown
// model per process, which is enough to notice in logs and act on.
const warnedModels = new Set<string>();

function priceFor(model: string): ModelPrice {
  const price = PRICES[model];
  if (price) return price;
  if (!warnedModels.has(model)) {
    warnedModels.add(model);
    console.warn(`[llmPricing] unknown model "${model}" — billing it at the ${DEFAULT_MODEL} rate. Add it to PRICES.`);
  }
  return PRICES[DEFAULT_MODEL];
}

/**
 * Cost of one LLM call in micro-USD (USD × 1_000_000), rounded to an integer.
 * Never throws: a metering failure must not be able to take down a customer
 * reply, so non-finite/negative token counts are clamped to 0 rather than
 * propagating NaN into a BIGINT counter.
 */
export function costMicroUsd(model: string, usage: TokenUsage): number {
  const price = priceFor(model);
  const input = Number.isFinite(usage.inputTokens) ? Math.max(0, usage.inputTokens) : 0;
  const output = Number.isFinite(usage.outputTokens) ? Math.max(0, usage.outputTokens) : 0;
  const usd = (input / 1_000_000) * price.inputPerMillion + (output / 1_000_000) * price.outputPerMillion;
  return Math.round(usd * 1_000_000);
}

/** Exported for tests/diagnostics only — the runtime always goes through costMicroUsd. */
export function knownModels(): string[] {
  return Object.keys(PRICES);
}
