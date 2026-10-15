/**
 * MESSAGE list_inbox sends a conversation-scoped request (`channelIds`) to the
 * live adapter pull; the X adapter owns that scope (`channels: "implicit"`).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
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
});

describe("XDmAdapter sendDraft", () => {
  it("does not mark an accepted send as delivered without a provider receipt", async () => {
    const sendDirectMessageForAccount = vi.fn(async () => ({
      ok: true,
      status: 201,
      messageId: null,
    }));
    const sendRuntime = {
      agentId: "agent",
      getService: (name: string) =>
        name === "x" ? { sendDirectMessageForAccount } : null,
    } as unknown as IAgentRuntime;
    const adapter = new XDmAdapter();
    const draft = await adapter.createDraft(sendRuntime, {
      to: [{ identifier: "123" }],
      body: "hello",
    });

    await expect(
      adapter.sendDraft(sendRuntime, draft.draftId),
    ).rejects.toMatchObject({
      code: "X_DM_RECEIPT_INDETERMINATE",
      context: {
        providerAccepted: true,
        retrySafe: false,
      },
    });
    expect(sendDirectMessageForAccount).toHaveBeenCalledOnce();
  });
});
