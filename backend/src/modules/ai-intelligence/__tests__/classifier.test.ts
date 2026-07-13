import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../classifier";

test("routes an order-tracking question to the order specialist", () => {
  const result = classifyIntent("وين طلبي رقم 1234؟");
  assert.equal(result.primary, "order");
});

test("routes a product-availability question to the product specialist", () => {
  const result = classifyIntent("هل هذا المنتج متوفر بمقاس L؟");
  assert.equal(result.primary, "product");
});

test("routes a complaint to the ticket specialist", () => {
  const result = classifyIntent("عندي مشكلة وأبي أتحدث مع موظف");
  assert.equal(result.primary, "ticket");
});

test("falls back to the knowledge specialist for an unmatched question", () => {
  const result = classifyIntent("ما هي ساعات العمل الرسمية؟");
  assert.equal(result.primary, "knowledge");
  assert.deepEqual(result.matched, ["knowledge"]);
});

test("falls back to the knowledge specialist for an empty string", () => {
  const result = classifyIntent("");
  assert.equal(result.primary, "knowledge");
});

test("picks the specialist with the most keyword hits when a question mixes topics", () => {
  // Two "order" keywords ("طلبي", "تتبع") vs one "product" keyword ("سعر").
  const result = classifyIntent("أبي أتتبع طلبي، وكم سعره؟");
  assert.equal(result.primary, "order");
  assert.ok(result.matched.includes("product"));
});
