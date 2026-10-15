/**
 * Gmail sends through the production service, adapter, and googleapis HTTP
 * client against a loopback provider. A successful HTTP response without a
 * provider message identity must not become a fabricated delivery receipt.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { Auth } from "googleapis";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GoogleGmailAdapter } from "./lifeops-message-adapter.js";
import { GoogleWorkspaceService } from "./service.js";
import type { GoogleAuthClient, GoogleCredentialResolver } from "./types.js";

class LoopbackCredentialResolver implements GoogleCredentialResolver {
  async getAuthClient(): Promise<GoogleAuthClient> {
    const auth = new Auth.OAuth2Client();
    auth.setCredentials({
      access_token: "loopback-google-token",
      expiry_date: Date.now() + 60 * 60 * 1000,
    });
    return auth;
  }
}

let server: Server;
let runtime: IAgentRuntime;
let service: GoogleWorkspaceService;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  service = new GoogleWorkspaceService(undefined, {
    credentialResolver: new LoopbackCredentialResolver(),
    apiRootUrl: `http://127.0.0.1:${address.port}/`,
  });
  runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    getService: (name: string) => (name === "google" ? service : null),
  } as unknown as IAgentRuntime;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

it("rejects a Gmail send response without a provider identity", async () => {
  const adapter = new GoogleGmailAdapter();
  const draft = await adapter.createDraft(runtime, {
    source: "gmail",
    to: [{ identifier: "recipient@example.test" }],
    subject: "Receipt proof",
    body: "Hello",
  });
  const snapshot = draft.snapshot;
  if (!snapshot) throw new Error("Gmail draft did not retain its snapshot");

  await expect(
    adapter.sendDraft(runtime, draft.draftId, {
      snapshot,
    })
  ).rejects.toMatchObject({ code: "MESSAGE_PROVIDER_RECEIPT_MISSING" });
});

it("rejects direct and reply sends without a Gmail identity", async () => {
  const [direct, reply] = await Promise.allSettled([
    service.sendEmail({
      accountId: "default",
      to: ["recipient@example.test"],
      subject: "Receipt proof",
      text: "Hello",
    }),
    service.sendGmailReply({
      accountId: "default",
      to: ["recipient@example.test"],
      subject: "Re: Receipt proof",
      bodyText: "Hello",
      threadId: "thread-1",
    }),
  ]);

  expect([direct, reply]).toMatchObject([
    {
      status: "rejected",
      reason: { code: "MESSAGE_PROVIDER_RECEIPT_MISSING" },
    },
    {
      status: "rejected",
      reason: { code: "MESSAGE_PROVIDER_RECEIPT_MISSING" },
    },
  ]);
});
