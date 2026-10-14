/** Google Chat account switches saved in Settings or the character file take effect. */
import { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveGoogleChatAccountSettings } from "./accounts.ts";

function runtime(settings: Record<string, string> = {}) {
  return new AgentRuntime({ character: { name: "ChatSettings", settings } });
}

describe("resolveGoogleChatAccountSettings", () => {
  it("honors switches turned off in Settings", () => {
    const rt = runtime();
    // The Settings UI saves strings; the runtime reads them back as booleans.
    rt.setSetting("GOOGLE_CHAT_ENABLED", "false");
    rt.setSetting("GOOGLE_CHAT_REQUIRE_MENTION", "false");
    expect(rt.getSetting("GOOGLE_CHAT_ENABLED")).toBe(false);

    expect(resolveGoogleChatAccountSettings(rt)).toMatchObject({
      enabled: false,
      requireMention: false,
    });
  });

  it("honors switches turned off in the character file", () => {
    const rt = runtime({
      GOOGLE_CHAT_ENABLED: "false",
      GOOGLE_CHAT_REQUIRE_MENTION: "false",
    });
    expect(resolveGoogleChatAccountSettings(rt)).toMatchObject({
      enabled: false,
      requireMention: false,
    });
  });

  it("keeps the defaults when nothing is set", () => {
    expect(resolveGoogleChatAccountSettings(runtime())).toMatchObject({
      enabled: true,
      requireMention: true,
    });
  });
});
