import { Prisma } from "@prisma/client";

// Keyword-overlap retrieval — deliberately not real embeddings. This is
// the pluggable seam: swap this file's internals for a pgvector cosine
// search once an embeddings provider is wired up (the knowledge_chunks
// table already has the `embedding vector(1536)` column waiting for it,
// per docs/01-database-design.md §5). Every caller only sees
// `retrieveBestChunk(...)`, so that swap touches one file.

const STOPWORDS = new Set(["هل", "من", "في", "على", "و", "ما", "أي", "إلى", "عن", "لا", "أو"]);

// Light Arabic stemming (Larkey-style single-pass prefix/suffix strip) —
// added after a real store's confidence gate escalated 100% of questions
// that *were* covered in its knowledge base. Root cause: plain-string
// token matching treated "الداخلي" (in the stored policy text) and
// "داخل" (in the customer's actual question) as two unrelated tokens, so
// a clearly on-topic question like "كم تكلفة الشحن داخل السعودية؟"
// scored below the confidence threshold and escalated anyway. This does
// NOT fix true synonym mismatches (e.g. "السعودية" vs "المملكة" — those
// are different words, not different forms of the same word; that needs
// the knowledge text itself to use the customer's vocabulary), only
// same-root inflections, which is the bulk of what was breaking. Single
// prefix + single suffix pass, longest-match-first, and only when the
// remaining stem stays at least 3 characters — conservative on purpose,
// to avoid collapsing genuinely different short words into one token.
const PREFIXES = ["بال", "كال", "فال", "وال", "لل", "ال", "و", "ف", "ب", "ك", "ل"];
const SUFFIXES = ["ية", "ون", "ين", "ات", "ها", "هم", "هن", "كم", "نا", "تي", "وا", "ي", "ة", "ه"];

function stem(word: string): string {
  let w = word.replace(/[أإآ]/g, "ا").replace(/ى/g, "ي");
  for (const p of PREFIXES) {
    if (w.startsWith(p) && w.length - p.length >= 3) {
      w = w.slice(p.length);
      break;
    }
  }
  for (const s of SUFFIXES) {
    if (w.endsWith(s) && w.length - s.length >= 3) {
      w = w.slice(0, -s.length);
      break;
    }
  }
  return w;
}

// Exported (read-only widening, no behavior change to callers) so
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
      .map(stem)
  );
}

// Pure greetings/salutations ("السلام عليكم", "صباح الخير", "hi"...) carry
// no real question, so they always scored 0 under retrieveBestChunk below
// and escalated to a human ticket — even though there's nothing for a
// person to actually resolve. isGreeting recognizes that specific shape
// (every token in the message, after the same tokenize()/stem() used for
// retrieval, is a known greeting word) so the pipeline can reply directly
// instead of opening a ticket. Deliberately conservative: a real question
// that happens to open with a greeting ("مرحبا، وين طلبي؟") still has
// content tokens ("وين"/"طلبي") outside this set, so it's never
// misclassified — only messages made ENTIRELY of greeting words qualify.
const GREETING_STEMS = new Set([
  "سلام", "علي", "رحم", "الل", "بركات",
  "مرحبا", "اهلا", "سهلا", "هلا",
  "صباح", "مساء", "خير", "نور",
  "hi", "hii", "hello", "hey", "yo",
  "good", "morning", "evening",
]);

export function isGreeting(text: string): boolean {
  const tokens = tokenize(text);
  if (tokens.size === 0) return false;
  return [...tokens].every((t) => GREETING_STEMS.has(t));
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
