/**
 * GET /api/v1/documents reports `total` as the number of documents in the
 * scope, not the size of the page it returned. Real route, real document
 * repository over PGlite; authentication and rate limiting are stubbed.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const DOCUMENTS = 350;

const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
const authedUser = {
  id: USER,
  organization_id: ORG,
  organization: { id: ORG, name: "Documents org", is_active: true },
  is_active: true,
};
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKey: async () => authedUser,
  requireUserOrApiKeyWithOrg: async () => authedUser,
}));
const realRateLimit = {
  ...(await import(
    "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare"
  )),
};
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    ...realRateLimit,
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  }),
);

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { agentTable, entityTable, memoryTable, roomTable } = await import(
  "@elizaos/cloud-shared/db/schemas"
);
const { memoriesRepository } = await import(
  "@elizaos/cloud-shared/db/repositories/agents/memories"
);
const { Hono } = await import("hono");
const { default: documentsRoute } = await import("../v1/documents/route");

const app = new Hono();
app.route("/api/v1/documents", documentsRoute);
const workerEnv = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };

async function list(query: string) {
  const response = await app.request(
    `/api/v1/documents${query}`,
    { method: "GET" },
    workerEnv,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { documents: unknown[]; total: number };
}

beforeAll(async () => {
  const { apply } = await pushSchema(
    { agentTable, entityTable, roomTable, memoryTable } as never,
    dbWrite as never,
  );
  await apply();
  // Documents are memories of the user's own agent, in the user's own room.
  await dbWrite
    .insert(agentTable)
    .values({ id: USER, name: "Documents agent" });
  await dbWrite.insert(entityTable).values({ id: USER, agentId: USER });
  await dbWrite
    .insert(roomTable)
    .values({ id: USER, agentId: USER, source: "test", type: "DM" });
  for (let index = 0; index < DOCUMENTS; index += 1) {
    await memoriesRepository.create({
      id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
      roomId: USER,
      entityId: USER,
      agentId: USER,
      type: "documents",
      content: { text: `document ${index}` },
      metadata: { filename: `doc-${index}.txt` },
    });
  }
}, 120_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

test("total is the number of documents in the scope on every page", async () => {
  const first = await list("?limit=100&offset=0");
  expect(first.documents).toHaveLength(100);
  expect(first.total).toBe(DOCUMENTS);

  const last = await list("?limit=100&offset=300");
  expect(last.documents).toHaveLength(50);
  expect(last.total).toBe(DOCUMENTS);

  const tail = await list("?limit=10&offset=345");
  expect(tail.documents).toHaveLength(5);
  expect(tail.total).toBe(DOCUMENTS);
});
