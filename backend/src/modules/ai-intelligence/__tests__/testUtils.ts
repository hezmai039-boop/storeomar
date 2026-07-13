// A minimal recording fake for Prisma.TransactionClient — NOT a real DB,
// NOT a substitute for the RLS integration test that needs a live Postgres
// (see docs/17-ai-intelligence-layer.md "حدود الاختبار"). What this DOES
// prove, deterministically and on every CI run with zero external
// dependency: every tool handler in this module passes storeId into every
// query it issues. A tool handler that forgot a storeId filter would fail
// these tests immediately.

export interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

type ModelHandlers = Record<string, (args: unknown) => unknown>;

export function createRecordingTx(
  overrides: Record<string, ModelHandlers> = {},
  queryRawResult: unknown[] = []
) {
  const calls: RecordedCall[] = [];

  function makeModel(model: string, handlers: ModelHandlers = {}) {
    return new Proxy(
      {},
      {
        get(_target, method: string) {
          return (args: unknown) => {
            calls.push({ model, method, args });
            if (handlers[method]) return handlers[method](args);
            if (method === "findMany") return [];
            if (method === "count") return 0;
            if (method.startsWith("find")) return null;
            return {};
          };
        },
      }
    );
  }

  const modelNames = [
    "syncedProduct",
    "syncedOrder",
    "customer",
    "ticket",
    "ticketEvent",
    "conversation",
    "knowledgeChunk",
    "storeDailyMetric",
    "auditLog",
    "aiSpecialist",
    "aiCustomerMemory",
    "aiConversationMemory",
    "aiBusinessMemory",
    "aiToolInvocation",
    "aiOrchestratorRun",
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {};
  for (const name of modelNames) {
    tx[name] = makeModel(name, overrides[name]);
  }

  // Tagged-template mock for hybridSearch's raw full-text query.
  tx.$queryRaw = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ model: "$raw", method: "queryRaw", args: values });
    return Promise.resolve(queryRawResult);
  };

  return { tx, calls };
}
