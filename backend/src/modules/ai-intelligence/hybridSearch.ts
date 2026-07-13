import { Prisma } from "@prisma/client";
import { tokenize } from "../knowledge/retrieval";
import { requireTenant } from "./tenantGuard";

export interface HybridSearchResult {
  id: string;
  content: string;
  keywordScore: number;
  ftsScore: number;
  combinedScore: number;
}

interface ChunkRow {
  id: string;
  content: string;
}

function keywordScores(chunks: ChunkRow[], query: string): Map<string, number> {
  const queryTokens = tokenize(query);
  const scores = new Map<string, number>();
  if (queryTokens.size === 0) return scores;
  for (const chunk of chunks) {
    const chunkTokens = tokenize(chunk.content);
    const overlap = [...queryTokens].filter((t) => chunkTokens.has(t)).length;
    const score = overlap / queryTokens.size;
    if (score > 0) scores.set(chunk.id, score);
  }
  return scores;
}

// 'simple' config (no stemming) is deliberate — Postgres ships no Arabic
// text-search dictionary out of the box, and forcing a mismatched
// English/generic config against Arabic content would silently
// under-match rather than fail loudly. Documented limitation, not an
// oversight (see docs/13-ai-engine-architecture.md §3.3). It still adds
// real value here as an exact-substring-tolerant complement to the
// token-overlap keyword score above.
//
// Runs through `tx` — the same Postgres transaction/connection that
// withStoreContext.ts already applied `SET LOCAL app.accessible_store_ids`
// on, so RLS from prisma/rls.sql still applies to this raw query exactly
// as it does to every Prisma-generated one. The explicit `store_id = ...`
// filter below is defense-in-depth on top of that, matching every other
// query in this codebase.
async function fullTextScores(
  tx: Prisma.TransactionClient,
  storeId: string,
  query: string
): Promise<Map<string, number>> {
  const rows = await tx.$queryRaw<Array<{ id: string; rank: number }>>`
    select id, ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', ${query})) as rank
    from knowledge_chunks
    where store_id = ${storeId}::uuid
      and to_tsvector('simple', content) @@ plainto_tsquery('simple', ${query})
    order by rank desc
    limit 50
  `;
  return new Map(rows.map((r) => [r.id, Number(r.rank)]));
}

/**
 * Combines keyword-overlap and Postgres full-text search into one ranked
 * list. A third branch — cosine similarity over knowledge_chunks.embedding
 * (already `vector(1536)` in the schema, per docs/01-database-design.md §5)
 * — is intentionally not implemented: it needs an embeddings-capable API
 * key, which nothing in this project currently requires (Claude, the only
 * LLM wired up in src/lib/llm.ts, has no embeddings endpoint). This is the
 * pluggable seam for that: add a third Map<string, number> here and fold
 * it into the weighted merge below, same shape as the two already present.
 * See docs/13-ai-engine-architecture.md §3.3 for the target design.
 */
export async function hybridSearchKnowledge(
  tx: Prisma.TransactionClient,
  storeId: string,
  query: string,
  options?: { limit?: number }
): Promise<HybridSearchResult[]> {
  requireTenant(storeId, "hybridSearchKnowledge");
  const limit = options?.limit ?? 5;

  const chunks = await tx.knowledgeChunk.findMany({ where: { storeId }, select: { id: true, content: true } });
  if (chunks.length === 0) return [];

  const [kwScores, ftsScoresRaw] = await Promise.all([
    Promise.resolve(keywordScores(chunks, query)),
    fullTextScores(tx, storeId, query),
  ]);

  const maxFts = Math.max(1e-9, ...Array.from(ftsScoresRaw.values()));
  const contentById = new Map(chunks.map((c) => [c.id, c.content]));
  const ids = new Set([...kwScores.keys(), ...ftsScoresRaw.keys()]);

  const results: HybridSearchResult[] = [];
  for (const id of ids) {
    const content = contentById.get(id);
    if (!content) continue;
    const keywordScore = kwScores.get(id) ?? 0;
    const ftsScore = (ftsScoresRaw.get(id) ?? 0) / maxFts;
    // 0.6/0.4 weighting: keyword-overlap stays primary because its scale
    // (0..1, coverage-of-question-words) is exactly what the existing
    // confidence gate in aiPipeline.ts already calibrates thresholds
    // against; FTS is a complement, not a replacement, given the Arabic
    // dictionary caveat above.
    const combinedScore = keywordScore * 0.6 + ftsScore * 0.4;
    results.push({ id, content, keywordScore, ftsScore, combinedScore });
  }

  results.sort((a, b) => b.combinedScore - a.combinedScore);
  return results.slice(0, limit);
}
