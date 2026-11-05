/**
 * DOCUMENT search, list and read render their result into the active room.
 * An owner-private document learned in a DM must not be surfaced when the
 * owner asks in a public group room, the same wall SEARCH_KNOWLEDGE applies.
 */
import {
  type ActionResult,
  ChannelType,
  type HandlerOptions,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import { documentAction } from "./actions.ts";
import { DocumentService } from "./service.ts";

const owner = "f4350000-0000-4000-8000-000000000021" as UUID;
const member = "f4350000-0000-4000-8000-000000000022" as UUID;
const dmRoom = "f4350000-0000-4000-8000-000000000023" as UUID;
const groupRoom = "f4350000-0000-4000-8000-000000000024" as UUID;
const world = "f4350000-0000-4000-8000-000000000025" as UUID;
const body =
  "Private launch notes. The launch date is March 3 and the codename is Bluebird.";
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let documentId: UUID;

beforeAll(async () => {
  fixture = await createTestRuntime({
    characterName: "DocumentRoomSurfacing",
    settings: { ELIZA_ADMIN_ENTITY_ID: owner, LOAD_DOCS_ON_STARTUP: false },
    plugins: [
      {
        name: "document-room-surfacing-fixture",
        description: "Real document service",
        services: [DocumentService],
      },
    ],
  });
  await fixture.runtime.ensureConnection({
    entityId: owner,
    roomId: dmRoom,
    worldId: world,
    worldName: "Surfacing",
    userName: "Owner",
    name: "Owner",
    source: "test",
    type: ChannelType.DM,
  });
  for (const entityId of [owner, member])
    await fixture.runtime.ensureConnection({
      entityId,
      roomId: groupRoom,
      worldId: world,
      worldName: "Surfacing",
      userName: entityId === owner ? "Owner" : "Member",
      name: "Team",
      source: "discord",
      type: ChannelType.GROUP,
    });
  const service = fixture.runtime.getService("documents") as DocumentService;
  const added = await service.addDocument({
    agentId: fixture.runtime.agentId,
    entityId: owner,
    addedBy: owner,
    roomId: dmRoom,
    worldId: world,
    clientDocumentId: "" as UUID,
    originalFilename: "launch-notes.txt",
    contentType: "text/plain",
    content: body,
    scope: "owner-private",
  });
  documentId = added.storedDocumentMemoryId as UUID;
}, 120_000);

afterAll(async () => {
  if (fixture) await fixture.cleanup();
}, 120_000);

async function dispatch(
  roomId: UUID,
  parameters: Record<string, unknown>,
): Promise<ActionResult> {
  const message: Memory = {
    id: crypto.randomUUID() as UUID,
    entityId: owner,
    agentId: fixture.runtime.agentId,
    roomId,
    worldId: world,
    content: { text: "what did we say about the launch?" },
  };
  const output = await documentAction.handler(
    fixture.runtime,
    message,
    undefined,
    { parameters } as HandlerOptions,
  );
  if (!output || typeof output !== "object" || !("success" in output))
    throw new Error("Missing action result");
  return output;
}

async function surfaced(roomId: UUID) {
  const search = await dispatch(roomId, {
    action: "search",
    query: "launch date codename",
  });
  const list = await dispatch(roomId, { action: "list" });
  const read = await dispatch(roomId, { action: "read", documentId });
  return {
    searchBody: (search.text ?? "").includes("Bluebird"),
    listTitle: (list.text ?? "").includes("launch-notes"),
    readBody: (read.text ?? "").includes("Bluebird"),
    readError: read.values?.error,
  };
}

it("keeps an owner-private document out of a public group room", async () => {
  expect({
    dm: await surfaced(dmRoom),
    group: await surfaced(groupRoom),
  }).toEqual({
    dm: {
      searchBody: true,
      listTitle: true,
      readBody: true,
      readError: undefined,
    },
    group: {
      searchBody: false,
      listTitle: false,
      readBody: false,
      readError: "private_in_public_room",
    },
  });
}, 120_000);
