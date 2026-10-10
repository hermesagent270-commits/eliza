/**
 * GET /api/conversations/messages/search through the real route handler with
 * a minimal runtime: the snippet never splits a surrogate pair, and a missing
 * runtime is reported instead of shown as "no matches".
 */

import { describe, expect, it } from "vitest";
import { handleConversationRoutes } from "../src/api/conversation-routes";

const roomId = "11111111-1111-4111-8111-111111111111";

async function search(runtime: unknown, text = "") {
  let out: { status: number; body?: unknown; error?: string } | null = null;
  const url = "/api/conversations/messages/search?q=budget";
  const ctx = {
    req: { headers: {}, url, socket: { remoteAddress: "127.0.0.1" } },
    res: {},
    method: "GET",
    pathname: "/api/conversations/messages/search",
    state: {
      runtime: runtime
        ? {
            agentId: "22222222-2222-4222-8222-222222222222",
            searchMessages: async () => [
              {
                memory: {
                  id: "33333333-3333-4333-8333-333333333333",
                  roomId,
                  entityId: "44444444-4444-4444-8444-444444444444",
                  content: { text },
                  createdAt: 1,
                },
                ftsRank: 1,
                trigramSimilarity: 0,
              },
            ],
          }
        : null,
      conversations: new Map([
        ["c1", { id: "c1", roomId, title: "t", createdAt: "", updatedAt: "" }],
      ]),
      deletedConversationIds: new Set(),
      logBuffer: [],
    },
    json: (_res: unknown, body: unknown, status = 200) => {
      out = { status, body };
    },
    error: (_res: unknown, error: string, status = 500) => {
      out = { status, error };
    },
    readJsonBody: async () => null,
  };
  await handleConversationRoutes(ctx as never);
  return out as unknown as { status: number; body?: unknown; error?: string };
}

describe("conversation message search", () => {
  it("cuts the snippet on a whole emoji", async () => {
    const result = await search(
      true,
      `${"🎉".repeat(40)} budget review moved to Friday`,
    );
    const snippet = (result.body as { results: Array<{ snippet: string }> })
      .results[0]?.snippet;
    expect(snippet).toContain("budget");
    expect(snippet).toBe(snippet?.toWellFormed());
  });

  it("reports an unavailable runtime instead of an empty result", async () => {
    expect(await search(null)).toEqual({
      status: 503,
      error: "Agent runtime not available",
    });
  });
});
