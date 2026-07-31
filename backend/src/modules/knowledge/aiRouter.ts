import { Prisma } from "@prisma/client";
import { gatherAiContext, completeAiPipeline, buildEscalationAck, AiContext, AiPipelineResult } from "./aiPipeline";
import { gatherOrchestratorContext, completeOrchestratorRun, OrchestratorContext, OrchestratorResult } from "../ai-intelligence/orchestrator";
import { checkQuota, recordAiUsage } from "../billing/service";
import { QUOTA_KEYS } from "../../lib/permissions";

// Exported for testability — the only real branching logic in this file
// that doesn't require a DB transaction or a network call to exercise.
export function mapOrchestratorResultToPipelineResult(
  result: OrchestratorResult,
  storeName: string,
  persona?: Prisma.JsonValue
): AiPipelineResult {
  return {
    confidenceLevel: result.confidence,
    // When the advanced engine escalates without producing any text, fall
    // back to the same customer-facing acknowledgment the classic pipeline
    // sends — so a low-confidence escalation is never silent on either
    // engine. If the model did produce text (e.g. "لست متأكدًا"), keep it.
    replyText: result.replyText ?? (result.escalate ? buildEscalationAck(storeName, persona) : null),
    createTicket: result.escalate,
    escalationReason: result.escalate
      ? "ثقة منخفضة من طبقة الذكاء الاصطناعي المتقدمة — لا نتيجة مؤكدة من الأدوات أو قاعدة المعرفة"
      : undefined,
    // The advanced engine's cost, already summed across its whole tool loop
    // and priced by completeOrchestratorRun, lands on the SAME field the
    // classic path populates. That is the entire integration: everything
    // downstream (aiResponseLogUsageFields in webhook.ts and
    // simulation/publicRoutes.ts, and meter() below) already reads
    // AiPipelineResult.usage and needs no knowledge of which engine ran.
    //
    // Passed through as-is, including `undefined`: a run that spent nothing
    // knowable must leave the nullable ai_response_logs columns NULL rather
    // than writing a 0 that would read as "this expensive engine is free".
    usage: result.usage,
  };
}

export interface AiReplyContext {
  mode: "classic" | "advanced" | "paused" | "quota_exceeded";
  // Which of the three levels stopped the reply, when mode is "paused".
  // The caller shows a different thing for each — a store-wide pause is a
  // deliberate setting, a conversation takeover means a colleague is
  // already typing — so collapsing them into one "paused" would make the
  // inbox unable to explain itself.
  pausedAt?: "store" | "channel" | "conversation";
  classic?: AiContext;
  advanced?: OrchestratorContext;
  // Carried from the gather phase so completeAiReply can meter the reply
  // against the paying organization without re-opening a transaction to
  // look the store's org back up. Absent on "paused"/"quota_exceeded",
  // which by construction spend nothing.
  organizationId?: string;
  // The advanced engine's OrchestratorContext doesn't carry the agent
  // persona, but gatherAiReply already loaded the agent to read the
  // advancedIntelligenceEnabled switch — so we stash the persona here to let
  // the advanced escalation acknowledgment honor the store's custom/disabled
  // ack setting, exactly like the classic path does.
  persona?: Prisma.JsonValue;
}

export interface GatherAiReplyParams {
  storeId: string;
  // Needed to read the channel-level switch. Optional so the simulation
  // path — which has no real channel account behind it — keeps compiling
  // and keeps behaving as it does today.
  channelAccountId?: string;
  storeName: string;
  question: string;
  conversationId: string;
  customerId: string;
  organizationId: string;
}

/**
 * Single DB-only entry point webhook.ts and simulation/publicRoutes.ts both
 * call instead of aiPipeline.ts's gatherAiContext directly. Reads the
 * per-store advancedIntelligenceEnabled switch (ai_agents) and gathers
 * context from whichever engine is active for this store.
 *
 * Defaults to the classic knowledge-base confidence gate (single LLM call
 * per message). The AI Intelligence Layer's specialists/tools only run for
 * a store that has explicitly opted in via Settings — each of its tool
 * calls is a separate LLM round-trip on top of the classifier and final
 * answer, i.e. real additional Anthropic API cost per message. A store
 * that never opts in sees zero behavior or cost change from this router
 * existing at all.
 *
 * agent.status === "paused" is the store owner's kill switch (Settings →
 * "إيقاف الذكاء الاصطناعي"): checked first, before either engine touches
 * retrieval or the DB any further, so a paused store makes zero AI-related
 * queries and zero LLM calls per message — every inbound message just
 * lands in the inbox unanswered for staff to reply to manually through the
 * normal conversation screen, exactly like a channel that was never wired
 * to AI at all. Re-enabling flips agent.status back to "active" and the
 * very next message is answered automatically again — no redeploy, no
 * reconnecting channels.
 */
export async function gatherAiReply(tx: Prisma.TransactionClient, params: GatherAiReplyParams): Promise<AiReplyContext> {
  const agent = await tx.aiAgent.findUnique({ where: { storeId: params.storeId } });

  if (agent?.status === "paused") {
    return { mode: "paused", pausedAt: "store" };
  }

  // Level 2 and 3, checked in the same place and for the same reason as
  // level 1: BEFORE retrieval, before the quota lookup, before any LLM call.
  // A merchant who silenced the bot on this channel, or a colleague who took
  // over this one conversation, must cost the platform nothing per inbound
  // message — and must never be overridden by a reply that was already in
  // flight through a cheaper check order.
  //
  // Narrowest wins. The three are deliberately independent rather than a
  // single tri-state: turning the bot back on for a store must not silently
  // resume it inside a conversation a human is still handling.
  if (params.channelAccountId) {
    const channel = await tx.channelAccount.findUnique({
      where: { id: params.channelAccountId },
      select: { aiEnabled: true },
    });
    if (channel && !channel.aiEnabled) {
      return { mode: "paused", pausedAt: "channel" };
    }
  }

  const conversation = await tx.conversation.findUnique({
    where: { id: params.conversationId },
    select: { aiPaused: true },
  });
  if (conversation?.aiPaused) {
    return { mode: "paused", pausedAt: "conversation" };
  }

  // Plan quota is checked HERE — before either engine touches retrieval or
  // the LLM — for the same reason the pause switch is: an organization past
  // its monthly automated-reply limit must cost us nothing per inbound
  // message. Checking after the fact would still pay for the tokens of
  // every reply we then refuse to send, which is the exact expense the
  // quota exists to cap. It also means the advanced engine's multi-call
  // tool loop (several round-trips per message) never starts at all.
  const quota = await checkQuota(params.organizationId, QUOTA_KEYS.AI_REPLIES_MONTHLY);
  if (!quota.allowed) {
    return { mode: "quota_exceeded" };
  }

  if (agent?.advancedIntelligenceEnabled) {
    const advanced = await gatherOrchestratorContext(tx, {
      storeId: params.storeId,
      storeName: params.storeName,
      conversationId: params.conversationId,
      customerId: params.customerId,
      organizationId: params.organizationId,
      question: params.question,
    });
    return { mode: "advanced", advanced, persona: agent?.persona ?? {}, organizationId: params.organizationId };
  }

  const classic = await gatherAiContext(tx, { storeId: params.storeId, question: params.question });
  return { mode: "classic", classic, organizationId: params.organizationId };
}

/**
 * Network-phase counterpart. Normalizes both engines' results into the same
 * AiPipelineResult shape aiPipeline.ts already produced, so Phase 4 in
 * webhook.ts/publicRoutes.ts (persisting the reply, ai_response_logs,
 * ticket escalation) never needs to know which engine actually answered.
 */
export async function completeAiReply(
  context: AiReplyContext,
  params: { storeName: string; question: string }
): Promise<AiPipelineResult> {
  if (context.mode === "paused") {
    // No replyText → webhook.ts/publicRoutes.ts persist no AI message.
    // createTicket: false → no auto-escalation ticket either; the
    // inbound message they already persisted in Phase 1 is all that
    // happens, sitting in the inbox like any unanswered conversation.
    return { confidenceLevel: "low", replyText: null, createTicket: false };
  }

  if (context.mode === "quota_exceeded") {
    // THE CUSTOMER'S MESSAGE IS NEVER DROPPED BECAUSE OF BILLING.
    //
    // This deliberately reuses the exact shape of a low-confidence
    // escalation: replyText null (no automated answer is sent) but
    // createTicket true, so the conversation lands in front of a human on
    // the same path staff already work every day. The end customer is still
    // served — only the automation stops.
    //
    // Equally deliberately, this NEVER throws and never returns an error to
    // the channel. Throwing here would surface to WhatsApp/Instagram as a
    // failed webhook (retries, eventually a disabled subscription) and to a
    // simulation visitor as a 500 — i.e. our billing state would look like
    // an outage of the store's support line. A commercial limit is our
    // problem to solve with the store owner, not the shopper's.
    //
    // The store owner learns about it through billing/usage (the dashboard's
    // remaining-quota figure and the tickets suddenly arriving unanswered),
    // not by their customers hitting a wall.
    return {
      confidenceLevel: "low",
      replyText: null,
      createTicket: true,
      escalationReason: "تجاوز الحد الشهري للردود الآلية في الباقة الحالية",
    };
  }

  if (context.mode === "advanced" && context.advanced) {
    const result = await completeOrchestratorRun(context.advanced);
    return meter(context, mapOrchestratorResultToPipelineResult(result, params.storeName, context.persona));
  }

  // context.classic is always set when mode === "classic" — gatherAiReply
  // above is the only place AiReplyContext gets constructed.
  return meter(context, await completeAiPipeline(context.classic!, params));
}

/**
 * Bumps the organization's monthly usage counter for a reply that actually
 * spent provider tokens, then hands the result straight back.
 *
 * Intentionally NOT awaited. recordAiUsage never throws by contract, but it
 * is still a write to usage_counters, and this function sits between the
 * LLM answering and webhook.ts sending that answer to the customer — every
 * millisecond spent here is a millisecond of extra silence on the shopper's
 * screen for a number nobody reads in real time. Metering is allowed to
 * land a moment late; the reply is not. The .catch is belt-and-braces so a
 * contract violation can never become an unhandled rejection that takes the
 * process down mid-conversation.
 */
function meter(context: AiReplyContext, result: AiPipelineResult): AiPipelineResult {
  if (!context.organizationId) return result;

  // Counted whenever an automated reply was actually produced — NOT only
  // when the provider billed us for it.
  //
  // These had been the same condition, which quietly broke the plan's own
  // promise. `usage` is absent for a reply served without ANTHROPIC_API_KEY
  // (the documented key-less default), for the greeting shortcut, and for a
  // low-confidence escalation acknowledgment. So a deployment with no API
  // key never incremented aiReplies at all and maxAiRepliesMonthly never
  // bound — the free plan's "100 ردًا ذكيًا شهريًا" was unlimited — while
  // even with a key every greeting and every ack was a free automated
  // reply. The customer bought a number of replies, so that is what the
  // counter has to count; token cost is a separate fact about the same
  // event, and stays absent when it is genuinely unknown.
  const replied = !!result.replyText;
  if (!replied && !result.usage) return result;

  void recordAiUsage(context.organizationId, {
    countReply: replied,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    costMicroUsd: result.usage?.costMicroUsd ?? 0,
  }).catch((err) => console.error("[aiRouter] recordAiUsage failed:", err));

  return result;
}
