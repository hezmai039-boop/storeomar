import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecordingTx } from "./testUtils";
import { hybridSearchKnowledge } from "../hybridSearch";

const STORE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

test("returns nothing when the store has no knowledge chunks at all", async () => {
  const { tx } = createRecordingTx({ knowledgeChunk: { findMany: () => [] } });
  const result = await hybridSearchKnowledge(tx, STORE_A, "سياسة الاسترجاع");
  assert.deepEqual(result, []);
});

test("ranks a chunk matched by both keyword overlap and full-text search above a keyword-only match", async () => {
  const chunks = [
    { id: "chunk-both", content: "سياسة الاسترجاع خلال 14 يومًا من الاستلام" },
    { id: "chunk-keyword-only", content: "الاسترجاع متاح لكل المنتجات غير المستخدمة" },
  ];
  const { tx } = createRecordingTx(
    { knowledgeChunk: { findMany: () => chunks } },
    [{ id: "chunk-both", rank: 0.9 }]
  );

  const results = await hybridSearchKnowledge(tx, STORE_A, "سياسة الاسترجاع", { limit: 5 });

  assert.ok(results.length >= 2);
  assert.equal(results[0].id, "chunk-both");
  assert.ok(results[0].combinedScore > results[1].combinedScore);
});

test("still returns keyword-only matches when the raw FTS query finds nothing", async () => {
  const chunks = [{ id: "chunk-1", content: "ساعات العمل من 9 صباحًا حتى 11 مساءً" }];
  const { tx } = createRecordingTx({ knowledgeChunk: { findMany: () => chunks } }, []);

  const results = await hybridSearchKnowledge(tx, STORE_A, "ساعات العمل");

  assert.equal(results.length, 1);
  assert.ok(results[0].keywordScore > 0);
  assert.equal(results[0].ftsScore, 0);
});

test("respects the limit option", async () => {
  const chunks = Array.from({ length: 10 }, (_, i) => ({ id: `chunk-${i}`, content: "منتج منتج منتج" }));
  const { tx } = createRecordingTx({ knowledgeChunk: { findMany: () => chunks } });
  const results = await hybridSearchKnowledge(tx, STORE_A, "منتج", { limit: 3 });
  assert.equal(results.length, 3);
});
