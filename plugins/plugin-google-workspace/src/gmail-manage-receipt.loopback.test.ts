/**
 * Gmail MESSAGE mutations through the production adapter and googleapis HTTP
 * client against a loopback provider. A provider rejection must remain a
 * failure all the way back to the shared messaging action.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { Auth } from "googleapis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("Gmail adapter mutation receipts", () => {
  let server: Server;
  let runtime: IAgentRuntime;
  let providerRequests: Array<{ method: string; path: string }>;

  beforeAll(async () => {
    providerRequests = [];
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://loopback.invalid");
      providerRequests.push({
        method: request.method ?? "GET",
        path: url.pathname,
      });
      if (request.method === "GET" && url.pathname === "/gmail/v1/users/me/messages") {
        writeJson(response, 200, {
          messages: [{ id: "msg-fail", threadId: "thread-fail" }],
          resultSizeEstimate: 1,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/gmail/v1/users/me/messages/msg-fail") {
        writeJson(response, 200, {
          id: "msg-fail",
          threadId: "thread-fail",
          historyId: "1",
          internalDate: "1760558400000",
          labelIds: ["INBOX", "UNREAD"],
          snippet: "Trash this message",
          payload: {
            headers: [
              { name: "Subject", value: "Provider failure" },
              { name: "From", value: "Sender <sender@example.test>" },
              { name: "To", value: "owner@example.test" },
              { name: "Date", value: "Wed, 15 Oct 2026 20:00:00 +0000" },
            ],
          },
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/gmail/v1/users/me/messages/msg-fail/trash"
      ) {
        writeJson(response, 503, {
          error: { code: 503, message: "Provider unavailable" },
        });
        return;
      }
      writeJson(response, 404, { error: { code: 404 } });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const service = new GoogleWorkspaceService(undefined, {
      credentialResolver: new LoopbackCredentialResolver(),
      apiRootUrl: `http://127.0.0.1:${address.port}/`,
    });
    runtime = {
      agentId: "00000000-0000-4000-8000-000000000001",
      getService: (name: string) => (name === "google" ? service : null),
    } as unknown as IAgentRuntime;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("returns failure when Gmail rejects a trash operation", async () => {
    const adapter = new GoogleGmailAdapter();
    const [message] = await adapter.listMessages(runtime, { limit: 1 });
    if (!message) throw new Error("Gmail message did not load");

    const result = await adapter.manageMessage(runtime, message.id, {
      kind: "trash",
    });

    expect(providerRequests).toEqual([
      { method: "GET", path: "/gmail/v1/users/me/messages" },
      { method: "GET", path: "/gmail/v1/users/me/messages/msg-fail" },
      {
        method: "POST",
        path: "/gmail/v1/users/me/messages/msg-fail/trash",
      },
    ]);
    expect(result).toEqual({
      ok: false,
      reason:
        "Gmail did not complete trash for message 00000000-0000-4000-8000-000000000001:default:gmail:msg-fail (provider status 503; retryable).",
    });
  });
});
