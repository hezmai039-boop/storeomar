/**
 * v1 intent classifier — deterministic Arabic keyword matching, zero cost,
 * zero external dependency, zero latency. This is a documented starting
 * point, not a claim of NLU sophistication: see
 * docs/13-ai-engine-architecture.md §3.5 for the upgrade path (embedding-
 * or LLM-based classification) once there is real conversation volume to
 * tune it against. The seam is this one function — nothing else in the
 * orchestrator needs to change when it's swapped.
 */

interface ClassificationRule {
  specialist: string;
  keywords: string[];
}

const RULES: ClassificationRule[] = [
  { specialist: "order", keywords: ["طلب", "طلبي", "شحنتي", "تتبع", "وين طلبي", "التوصيل", "الشحن", "وصل"] },
  { specialist: "product", keywords: ["منتج", "متوفر", "متوفره", "متوفرة", "سعر", "مقاس", "لون", "مخزون", "الكمية"] },
  { specialist: "ticket", keywords: ["شكوى", "مشكلة", "موظف", "تحدث مع", "مندوب", "بشري", "اتصل بي"] },
  { specialist: "customer", keywords: ["حسابي", "بياناتي", "نقاطي", "رصيدي", "طلباتي السابقة"] },
  { specialist: "analytics", keywords: ["تقرير", "إحصائي", "إحصائيات", "أداء المتجر", "أكثر مبيعا"] },
];

export interface ClassificationResult {
  primary: string;
  matched: string[];
}

export function classifyIntent(question: string): ClassificationResult {
  const normalized = question.trim();
  const scored = RULES.map((rule) => ({
    specialist: rule.specialist,
    count: rule.keywords.filter((k) => normalized.includes(k)).length,
  })).filter((r) => r.count > 0);

  scored.sort((a, b) => b.count - a.count);

  if (scored.length === 0) {
    // No confident keyword match — the "knowledge" specialist is the safe
    // general-purpose fallback (grounded-answer-or-say-so, same principle
    // as the existing confidence gate in aiPipeline.ts).
    return { primary: "knowledge", matched: ["knowledge"] };
  }
  return { primary: scored[0].specialist, matched: scored.map((s) => s.specialist) };
}
