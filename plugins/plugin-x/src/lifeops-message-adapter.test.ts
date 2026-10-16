/**
 * MESSAGE list_inbox sends a conversation-scoped request (`channelIds`) to the
 * live adapter pull; the X adapter owns that scope (`channels: "implicit"`).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { XDmAdapter } from "./lifeops-message-adapter";

function dm(id: string, conversationId: string, text: string, at: number) {
  return {
    id,
    entityId: `sender-${id}`,
    roomId: conversationId,
    createdAt: at,
    content: { text },
    metadata: { x: { dmEventId: id, conversationId, senderId: `user-${id}` } },
  };
}

const xService = {
  fetchDirectMessagesForAccount: async () => [
    dm("e1", "conv-A", "hi from A", 1_000),
    dm("e2", "conv-B", "hi from B", 2_000),
  ],
};
const runtime = {
  agentId: "agent",
  getService: (name: string) => (name === "x" ? xService : null),
} as unknown as IAgentRuntime;

describe("XDmAdapter listMessages", () => {
  it("lists only the requested conversations", async () => {
    const refs = await new XDmAdapter().listMessages(runtime, {
      channelIds: ["conv-A"],
    });
    expect(refs.map((ref) => [ref.id, ref.channelId])).toEqual([
      ["twitter:e1", "conv-A"],
    ]);
  });

  it("lists every conversation without a channel scope", async () => {
    const refs = await new XDmAdapter().listMessages(runtime, {});
    expect(refs.map((ref) => ref.channelId)).toEqual(["conv-B", "conv-A"]);
  });

  it("lists direct messages from every connected account by default", async () => {
    const calls: Array<string | undefined> = [];
    const multiAccountService = {
      getAccountIds: () => ["personal", "work"],
      fetchDirectMessagesForAccount: async (accountId: string | undefined) => {
        calls.push(accountId);
        const message = dm(
          `event-${accountId}`,
          `conversation-${accountId}`,
          `message for ${accountId}`,
          accountId === "work" ? 2_000 : 1_000,
        );
        return [
          {
            ...message,
            metadata: { ...message.metadata, accountId },
          },
        ];
      },
    };
    const multiAccountRuntime = {
      agentId: "agent",
      getService: (name: string) => (name === "x" ? multiAccountService : null),
    } as unknown as IAgentRuntime;

    const refs = await new XDmAdapter().listMessages(multiAccountRuntime, {});

    expect(calls).toEqual(["personal", "work"]);
    expect(refs.map((ref) => ref.worldId)).toEqual(["work", "personal"]);
  });

  it("keeps messages from a healthy account when another account fails", async () => {
    const reported: unknown[] = [];
    const partialService = {
      getAccountIds: () => ["expired", "work"],
      fetchDirectMessagesForAccount: async (accountId: string | undefined) => {
        if (accountId === "expired") throw new Error("token expired");
        const message = dm("event-work", "conversation-work", "ready", 2_000);
        return [
          {
            ...message,
            metadata: { ...message.metadata, accountId },
          },
        ];
      },
    };
    const partialRuntime = {
      agentId: "agent",
      getService: (name: string) => (name === "x" ? partialService : null),
      reportError: (_source: string, error: unknown) => reported.push(error),
    } as unknown as IAgentRuntime;

    const refs = await new XDmAdapter().listMessages(partialRuntime, {});

    expect(refs.map((ref) => ref.worldId)).toEqual(["work"]);
    expect(reported).toHaveLength(1);
  });
});
