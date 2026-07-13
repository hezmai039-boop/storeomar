import { Prisma } from "@prisma/client";

// Keyword-overlap retrieval — deliberately not real embeddings. This is
// the pluggable seam: swap this file's internals for a pgvector cosine
// search once an embeddings provider is wired up (the knowledge_chunks
// table already has the `embedding vector(1536)` column waiting for it,
// per docs/01-database-design.md §5). Every caller only sees
// `retrieveBestChunk(...)`, so that swap touches one file.

const STOPWORDS = new Set(["هل", "من", "في", "على", "و", "ما", "أي", "إلى", "عن", "لا", "أو"]);

// Exported (read-only widening, no behavior change) so
// src/modules/ai-intelligence/hybridSearch.ts can reuse the exact same
// tokenizer instead of drifting out of sync with a second copy — the
// production confidence-gate pipeline below is otherwise untouched.
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
  );
}

export interface RetrievedChunk {
  id: string;
  content: string;
  score: number; // 0..1, roughly "confidence" for the gate in aiPipeline.ts
}

export async function retrieveBestChunk(
  tx: Prisma.TransactionClient,
  storeId: string,
  question: string
): Promise<RetrievedChunk | null> {
  const chunks = await tx.knowledgeChunk.findMany({ where: { storeId }, select: { id: true, content: true } });
  if (chunks.length === 0) return null;

  const queryTokens = tokenize(question);
  if (queryTokens.size === 0) return null;

  let best: RetrievedChunk | null = null;
  for (const chunk of chunks) {
    const chunkTokens = tokenize(chunk.content);
    const overlap = [...queryTokens].filter((t) => chunkTokens.has(t)).length;
    // Coverage of the *question's* words, not Jaccard-over-the-union — a
    // short question matched entirely inside one clause of a much longer
    // policy paragraph should score as a strong match, and Jaccard
    // (overlap / union) unfairly tanks that score as the chunk gets longer.
    const score = overlap / queryTokens.size;
    if (!best || score > best.score) best = { id: chunk.id, content: chunk.content, score };
  }
  return best;
}
