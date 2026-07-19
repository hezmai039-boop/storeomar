import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, isGreeting } from "../retrieval";

function overlapScore(question: string, chunk: string): number {
  const q = tokenize(question);
  const c = tokenize(chunk);
  const overlap = [...q].filter((t) => c.has(t)).length;
  return overlap / q.size;
}

test("regression: real store's shipping question no longer scores below the confidence threshold", () => {
  // The exact case a live tester hit: 100% of questions escalated,
  // including ones the knowledge base actually answers. Root cause was
  // "داخل" (customer's word) vs "الداخلي" (stored policy's word) being
  // two unrelated tokens under plain string matching.
  const question = "كم تكلفة الشحن داخل السعودية؟";
  const chunk = "الشحن الداخلي (سمسا): تكلفة ثابتة 30 ريالاً لجميع مناطق المملكة.";
  const score = overlapScore(question, chunk);
  assert.ok(score >= 0.5, `expected score >= 0.5 (default confidenceThresholdLow), got ${score}`);
});

test("tokenize collapses 'الداخلي' and 'داخل' to the same stem", () => {
  const a = tokenize("الشحن الداخلي");
  const b = tokenize("الشحن داخل السعودية");
  assert.ok([...a].some((t) => b.has(t) && t !== "الشحن"), "expected a shared stem beyond 'الشحن' itself");
});

test("tokenize does not collapse genuinely different words to the same stem", () => {
  // Stemming must never manufacture false synonyms — "السعودية" and
  // "المملكة" are different words, not different forms of one word, and
  // should stay distinct even after stemming.
  const a = tokenize("السعودية");
  const b = tokenize("المملكة");
  assert.equal([...a].some((t) => b.has(t)), false);
});

test("tokenize leaves short roots (<=3 chars after stripping) unstemmed to avoid over-collapsing", () => {
  // "علم" has no valid prefix/suffix to strip without going under the
  // 3-character floor, so it must round-trip unchanged.
  const tokens = tokenize("علم");
  assert.ok(tokens.has("علم"));
});

test("tokenize still filters stopwords and single-character noise after stemming", () => {
  const tokens = tokenize("هل من الأسئلة الشائعة عن عسل النحل؟");
  assert.equal(tokens.has("هل"), false);
  assert.equal(tokens.has("من"), false);
  assert.equal(tokens.has("عن"), false);
});

test("isGreeting: recognizes a pure Arabic greeting", () => {
  assert.equal(isGreeting("السلام عليكم ورحمة الله وبركاته"), true);
  assert.equal(isGreeting("صباح الخير"), true);
  assert.equal(isGreeting("مساء النور"), true);
  assert.equal(isGreeting("اهلا وسهلا"), true);
});

test("isGreeting: recognizes a pure English greeting", () => {
  assert.equal(isGreeting("hi"), true);
  assert.equal(isGreeting("hello there"), false); // "there" isn't a known greeting stem — deliberately conservative
  assert.equal(isGreeting("good morning"), true);
});

test("isGreeting: a real question that opens with a greeting is never misclassified", () => {
  assert.equal(isGreeting("مرحبا، وين طلبي؟"), false);
  assert.equal(isGreeting("السلام عليكم، كم تكلفة الشحن؟"), false);
});

test("isGreeting: unrelated real questions are false", () => {
  assert.equal(isGreeting("كم تكلفة الشحن داخل السعودية؟"), false);
  assert.equal(isGreeting("متى يصل طلبي؟"), false);
});

test("isGreeting: empty or whitespace-only input is false", () => {
  assert.equal(isGreeting(""), false);
  assert.equal(isGreeting("   "), false);
  assert.equal(isGreeting("؟؟؟"), false);
});
