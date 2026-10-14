import { afterEach, expect, spyOn, test } from "bun:test";
import { blueskyProvider } from "./bluesky";
import { linkedinProvider } from "./linkedin";
import { redditProvider } from "./reddit";
import { twitterProvider } from "./twitter";

/**
 * A create request whose outcome is unknown (the connection timed out after
 * the platform may have published) must not be sent again: none of these
 * platforms deduplicate a replayed create, so a replay publishes twice.
 */
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function timeout(): never {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** Routes every request; the first call matching `createPath` times out, later ones succeed. */
function stubPlatform(
  createPath: string,
  handlers: Record<string, (init?: RequestInit) => Response>,
): { creates: number } {
  const seen = { creates: 0 };
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.href.includes(createPath) && init?.method === "POST") {
        seen.creates += 1;
        if (seen.creates === 1) timeout();
        return handlers.create(init);
      }
      const handler = Object.entries(handlers).find(
        ([key]) => key !== "create" && url.href.includes(key),
      );
      if (!handler) throw new Error(`unexpected request ${url.href}`);
      return handler[1](init);
    }),
  );
  return seen;
}

test("bluesky sends createRecord once and reports the unknown outcome", async () => {
  const seen = stubPlatform("com.atproto.repo.createRecord", {
    "com.atproto.server.createSession": () =>
      json({ accessJwt: "jwt", refreshJwt: "r", did: "did:plc:app", handle: "app.bsky.social" }),
    create: () => json({ uri: "at://did:plc:app/app.bsky.feed.post/k2", cid: "cid" }),
  });

  const result = await blueskyProvider.createPost(
    { handle: "app.bsky.social", appPassword: "app-password" },
    { text: "Launch day" },
  );

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
});

test("reddit sends /api/submit once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/api/submit", {
    "/api/v1/access_token": () => json({ access_token: "token", expires_in: 3600 }),
    create: () =>
      json({ json: { data: { id: "t3_1", name: "t3_1", url: "https://reddit.com/r/x/1" } } }),
  });

  const result = await redditProvider.createPost(
    { apiKey: "id", apiSecret: "secret", username: "u", password: "p" },
    { text: "Launch day" },
    { reddit: { subreddit: "elizaos", title: "Launch day" } },
  );

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
});

test("linkedin sends /ugcPosts once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/ugcPosts", {
    create: () => json({}, 201, { "x-restli-id": "urn:li:share:1" }),
  });

  const result = await linkedinProvider.createPost(
    { accessToken: "token" },
    { text: "Launch day" },
    { linkedin: { organizationId: "123" } },
  );

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
});

test("twitter sends /tweets once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/tweets", {
    create: () => json({ data: { id: "1", text: "Launch day" } }),
  });

  const result = await twitterProvider.createPost({ accessToken: "token" }, { text: "Launch day" });

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
});
