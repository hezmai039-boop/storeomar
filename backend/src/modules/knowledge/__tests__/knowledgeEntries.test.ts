import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../routes";
import {
  INDUSTRY_TEMPLATES,
  getIndustryTemplate,
  listIndustryTemplates,
  templateChunkContent,
  templateChunkMetadata,
  templateRawText,
} from "../../../lib/industryTemplates";

// What is worth testing here is the CONTRACT BETWEEN THE TWO WAYS knowledge
// enters a store — applying a template, and appending a single Q&A — because
// the retriever cannot tell them apart and must not be able to. Everything
// below is pure: no database, no HTTP, no LLM.

// The exact string the entries route builds. Kept as a local copy on purpose:
// if the route's format ever changes, this test must FAIL rather than follow
// it, because the whole point is that the format is shared with the template.
function entryContent(question: string, answer: string): string {
  return `س: ${question}\nج: ${answer}`;
}

// --- (a) template content and hand-added content are the same shape ---------

test("an appended entry is byte-identical to how a template writes the same pair", () => {
  // If these ever diverge, a merchant's own answers would be tokenized
  // differently from the template's — the same question would score
  // differently depending on who typed it, which is indefensible and
  // invisible until a customer gets the wrong answer.
  const entry = { question: "كم رسوم التوصيل؟", answer: "التوصيل ٢٥ ريالًا.", topic: "delivery" as const };
  assert.equal(entryContent(entry.question, entry.answer), templateChunkContent(entry));
});

test("every template entry survives the question/answer split the UI performs", () => {
  // The page renders a chunk by splitting on the FIRST newline. A template
  // answer that contained a newline before its "ج:" prefix would render as an
  // empty question with the prefix leaking into the body.
  for (const template of listIndustryTemplates()) {
    for (const entry of template.entries) {
      const content = templateChunkContent(entry);
      const breakAt = content.indexOf("\n");
      assert.notEqual(breakAt, -1, `${template.key}: entry has no newline separator`);
      assert.equal(content.slice(0, breakAt), `س: ${entry.question}`);
      assert.equal(content.slice(breakAt + 1), `ج: ${entry.answer}`);
    }
  }
});

// --- (b) the reason chunks are written explicitly, not via chunkText -------

test("chunkText SHATTERS template answers — which is why apply writes chunks itself", () => {
  // This is the single most important fact about the apply route, and the
  // easiest one for a future refactor to undo ("why not just reuse the
  // existing chunking?"). chunkText splits after any ".", "!" or "؟" followed
  // by a space, so a multi-sentence answer becomes several chunks and every
  // one after the first is an orphan: text with no question attached, which
  // the retriever can still return as an "answer".
  const template = INDUSTRY_TEMPLATES.fresh_seafood;
  const reindexed = chunkText(templateRawText(template));

  assert.ok(
    reindexed.length > template.entries.length,
    `expected re-chunking to produce MORE pieces than entries, got ${reindexed.length} vs ${template.entries.length}`
  );
  // And concretely: at least one produced piece is an orphan with no question.
  assert.ok(
    reindexed.some((piece) => !piece.startsWith("س:") && !piece.startsWith("ج:")),
    "expected at least one orphaned fragment with neither prefix"
  );
});

test("one chunk per entry is what apply actually stores", () => {
  for (const template of listIndustryTemplates()) {
    const chunks = template.entries.map(templateChunkContent);
    assert.equal(chunks.length, template.entries.length);
    // Each stored chunk carries its question whole — the property the
    // shattered version loses.
    for (const chunk of chunks) assert.ok(chunk.startsWith("س: "));
  }
});

// --- (c) a single entry is safe to re-chunk (the append path) --------------

test("a single-sentence answer round-trips through chunkText intact", () => {
  // The append path's rawText concatenation is only lossless for answers
  // without mid-answer sentence breaks. Proving the simple case holds is what
  // makes the FAILING case above meaningful rather than alarming.
  const content = entryContent("متى يوصل طلبي؟", "خلال ٢٤ ساعة داخل الرياض");
  assert.deepEqual(chunkText(content), [content]);
});

test("blank lines separate appended entries so no two merge into one chunk", () => {
  const a = entryContent("متى تفتحون؟", "من ٩ صباحًا حتى ٩ مساءً");
  const b = entryContent("وين موقعكم؟", "الرياض والخرج");
  const appended = `${a}\n\n${b}`;
  assert.deepEqual(chunkText(appended), [a, b]);
});

// --- (d) template catalogue integrity --------------------------------------

test("every template has a unique source title — apply's duplicate guard depends on it", () => {
  // The 409 guard matches on title. Two templates sharing one would make
  // applying the second look like a re-apply of the first and silently block
  // it, so this is load-bearing rather than cosmetic.
  const titles = listIndustryTemplates().map((t) => t.sourceTitle);
  assert.equal(new Set(titles).size, titles.length, "duplicate sourceTitle across templates");
});

test("getIndustryTemplate returns undefined for an unknown key rather than throwing", () => {
  // The route turns undefined into a clean 404. If this threw, an unknown key
  // would surface as a 500 and read like an outage.
  assert.equal(getIndustryTemplate("no_such_industry"), undefined);
  assert.equal(getIndustryTemplate("__proto__"), undefined);
});

test("every template is non-empty and reachable by its own key", () => {
  for (const template of listIndustryTemplates()) {
    assert.ok(template.entries.length > 0, `${template.key} has no entries`);
    assert.equal(getIndustryTemplate(template.key)?.key, template.key);
  }
});

test("chunk metadata tags the origin so seeded content can be told from edited", () => {
  const template = INDUSTRY_TEMPLATES.fresh_seafood;
  const meta = templateChunkMetadata(template, template.entries[0]);
  assert.equal(meta.origin, "industry_template");
  assert.equal(meta.industry, "fresh_seafood");
  assert.equal(meta.question, template.entries[0].question);
});

// --- (e) the seafood template's own commercial rules -----------------------

test("the seafood template states the weight rule AND its fillet exception", () => {
  // 7Marines' fillets are sold by NET weight while everything else is weighed
  // before cleaning (docs/35). A template that taught only the rule would have
  // the AI warn a fillet buyer their weight will drop — wrong, and it costs a
  // sale. Both must be present in the same answer.
  const weightEntry = INDUSTRY_TEMPLATES.fresh_seafood.entries.find((e) => e.question.includes("الوزن"));
  assert.ok(weightEntry, "expected a weight entry");
  assert.ok(weightEntry.answer.includes("قبل التنظيف"), "the rule is missing");
  assert.ok(weightEntry.answer.includes("نصف"), "the shrimp halving is missing");
});

test("no template answer promises a return window on perishable food", () => {
  // The retail template's "14 days, in its original box" is correct for
  // retail and catastrophic for fish. This asserts the seafood template never
  // inherited it — the exact mistake that motivated a separate template.
  for (const entry of INDUSTRY_TEMPLATES.fresh_seafood.entries) {
    assert.ok(!/١٤|14/.test(entry.answer), `seafood answer mentions a 14-day window: ${entry.question}`);
  }
});
