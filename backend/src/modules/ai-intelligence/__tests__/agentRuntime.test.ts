import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { zodToJsonSchema } from "../agentRuntime";
import { TOOL_REGISTRY } from "../tools/registry";

test("converts a plain object schema with required and optional fields", () => {
  const schema = z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() });
  const result = zodToJsonSchema(schema);
  assert.equal(result.type, "object");
  assert.deepEqual(result.properties?.query, { type: "string" });
  assert.deepEqual(result.properties?.limit, { type: "number" });
  assert.deepEqual(result.required, ["query"]);
});

test("converts an enum field", () => {
  const schema = z.object({ priority: z.enum(["low", "medium", "high", "urgent"]).optional() });
  const result = zodToJsonSchema(schema);
  assert.deepEqual(result.properties?.priority, { type: "string", enum: ["low", "medium", "high", "urgent"] });
  assert.deepEqual(result.required, []);
});

test("unwraps a top-level .refine() to the underlying object shape", () => {
  const schema = z
    .object({ externalProductId: z.string().optional(), query: z.string().optional() })
    .refine((v) => Boolean(v.externalProductId || v.query));
  const result = zodToJsonSchema(schema);
  assert.equal(result.type, "object");
  assert.ok(result.properties?.externalProductId);
  assert.ok(result.properties?.query);
  // Both fields are optional in the base shape, even though .refine()
  // enforces "at least one" at runtime — the JSON Schema we hand to the
  // model doesn't need to express that, but the runtime zod check
  // (tool.inputSchema.safeParse in orchestrator.ts) still enforces it.
  assert.deepEqual(result.required, []);
});

test("every tool in the registry converts to a valid, non-empty JSON object schema", () => {
  for (const tool of TOOL_REGISTRY.values()) {
    const jsonSchema = zodToJsonSchema(tool.inputSchema);
    assert.equal(jsonSchema.type, "object", `tool ${tool.key} should convert to an object schema`);
    assert.ok(jsonSchema.properties, `tool ${tool.key} should have properties`);
  }
});
