/**
 * Contract tests for the ENTITIES ("People in the Room") provider. Pins the
 * context gate: the provider must be visible on messaging turns — not only
 * contacts/memory — so the planner can see that an addressee is PRESENT in the
 * room and prefer a plain in-room reply over a contact search or DM lookup
 * (the "tell <name> …" over-routing family). Metadata preservation uses the
 * real runtime and in-memory storage; context-gate cases use a mocked runtime.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../database/inMemoryAdapter";
import { AgentRuntime } from "../../../runtime";
import { createMockRuntime } from "../../../testing/mock-runtime";
import type { IAgentRuntime, Memory, UUID } from "../../../types/index.ts";
import { entitiesProvider } from "./entities.ts";

describe("ENTITIES provider context gate", () => {
	it("is visible on messaging turns as well as contacts/memory", () => {
		expect(entitiesProvider.contexts).toContain("messaging");
		expect(entitiesProvider.contexts).toContain("contacts");
		expect(entitiesProvider.contexts).toContain("memory");
		const gate = entitiesProvider.contextGate as { anyOf?: string[] };
		expect(gate?.anyOf).toContain("messaging");
	});
});

describe("ENTITIES provider content", () => {
	it("preserves distinct relationship roles and complete default metadata from storage", async () => {
		const roomId = "00000000-0000-0000-0000-0000000000bb" as UUID;
		const entityId = "00000000-0000-0000-0000-0000000000e1" as UUID;
		const runtime = new AgentRuntime({
			character: { name: "MetadataAgent", bio: "test" },
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		const metadata = {
			guardian: "Alice",
			billingOwner: "Alice",
			default: { careInstructions: "Call the guardian before pickup." },
			avatarUrl: "https://example.test/alice.jpg",
			originalId: "connector-identity-42",
			nested: { labels: [{}, [], "Alice", "Alice"], empty: {} },
		};
		await runtime.createRooms([{ id: roomId, source: "test" }]);
		await runtime.createEntities([
			{ id: entityId, agentId: runtime.agentId, names: ["Alice"], metadata },
		]);
		await runtime.addParticipant(entityId, roomId);
		const result = await entitiesProvider.get(
			runtime,
			{ entityId, roomId, content: { text: "Who handles pickup?" } },
			{ values: {}, data: {}, text: "" },
		);
		const dataLine = result.text
			?.split("\n")
			.find((line) => line.startsWith("Data: "));
		if (!dataLine) throw new Error("Entity provider did not render metadata");
		expect(JSON.parse(dataLine.slice("Data: ".length))).toEqual(metadata);
		expect((await runtime.getEntityById(entityId))?.metadata).toEqual(metadata);
	});

	it("lists the people present in the room", async () => {
		const roomId = "00000000-0000-0000-0000-0000000000bb" as UUID;
		const runtime = createMockRuntime({
			agentId: "00000000-0000-0000-0000-000000000001" as UUID,
			getRoom: (async () => ({
				id: roomId,
				source: "discord",
				name: "#general",
			})) as IAgentRuntime["getRoom"],
			getEntitiesForRoom: (async () => [
				{
					id: "00000000-0000-0000-0000-0000000000e1" as UUID,
					agentId: "00000000-0000-0000-0000-000000000001" as UUID,
					names: ["Vega"],
					components: [],
				},
			]) as IAgentRuntime["getEntitiesForRoom"],
		});
		const message = {
			id: "00000000-0000-0000-0000-0000000000aa",
			roomId,
			entityId: "00000000-0000-0000-0000-0000000000cc",
			content: { text: "tell vega to take a break", source: "discord" },
		} as unknown as Memory;

		const result = await entitiesProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});
		expect(result.text).toContain("People in the Room");
		expect(result.text).toContain("Vega");
	});
});
