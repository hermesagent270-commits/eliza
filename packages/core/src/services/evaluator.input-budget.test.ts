/**
 * Complete post-turn input admission through the real runtime and in-memory
 * adapter with controlled provider/model responses. Oversized evidence fails
 * before inference, remains intact, and produces failed diagnostic artifacts.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { ElizaError } from "../errors";
import { AgentRuntime } from "../runtime";
import { estimateModelInputTokens } from "../runtime/model-input-budget";
import { runWithTrajectoryContext } from "../trajectory-context";
import { type Character, EventType, type Memory, type Service } from "../types";
import { conversationMessagesHeader } from "../utils";
import { EvaluatorService } from "./evaluator";

const BUDGET_TOKENS = 3_000;
const ENTITY_ID = "00000000-0000-0000-0000-000000000002";

function makeRuntime(): AgentRuntime {
	const runtime = new AgentRuntime({
		character: {
			name: "EvaluatorBudgetAgent",
			bio: "test",
			settings: {
				POST_TURN_EVALUATOR_MAX_PROMPT_TOKENS: String(BUDGET_TOKENS),
			},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
	runtime.evaluators.length = 0;
	runtime.composeState = vi.fn(async () => ({
		values: {},
		data: {},
		text: "",
	}));
	runtime.emitEvent = vi.fn(async () => {});
	runtime.registerEvaluator({
		name: "alpha",
		description: "alpha section",
		schema: {
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		},
		shouldRun: async () => true,
		prompt: () => "Extract alpha.",
		parse: (output) => output as never,
		processors: [
			{ name: "storeAlpha", process: async () => ({ success: true }) },
		],
	});
	return runtime;
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as Memory["id"],
		entityId: ENTITY_ID as Memory["entityId"],
		roomId: "00000000-0000-0000-0000-000000000003" as Memory["roomId"],
		content: { text: "hello", source: "test" },
	} as Memory;
}

/** Rows in the shape formatMessages renders: newest first, oldest last. */
function conversationBlock(rowCount: number): string {
	const rows = Array.from({ length: rowCount }, (_, index) => {
		const ordinal = rowCount - 1 - index;
		return `12:00 (2 hours ago) [${ENTITY_ID}] Nubs: row ${ordinal} ${"lorem ipsum dolor ".repeat(4)}`;
	});
	return `${conversationMessagesHeader(rowCount)}\n${rows.join("\n")}\n`;
}

function stateWithBlock(block: string) {
	const providerText = `${block}\n\n# Received Message\nNubs: hello\n`;
	return {
		values: {},
		data: { providers: { RECENT_MESSAGES: { text: providerText } } },
		text: `# Current Time\nnow\n${providerText}`,
	};
}

function captureModel(runtime: AgentRuntime): string[] {
	const prompts: string[] = [];
	runtime.useModel = vi.fn(async (_modelType, params) => {
		prompts.push(String(params.messages?.[0]?.content ?? ""));
		return { alpha: { ok: true } };
	}) as AgentRuntime["useModel"];
	return prompts;
}

function promptTokens(text: string): number {
	return estimateModelInputTokens({
		messages: [{ role: "user", content: text }],
	});
}

describe("post-turn evaluator input budget", () => {
	it("dispatches an under-budget prompt unchanged", async () => {
		const runtime = makeRuntime();
		const prompts = captureModel(runtime);
		const block = conversationBlock(5);

		const result = await new EvaluatorService(runtime).run(
			makeMessage(),
			stateWithBlock(block),
		);

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(result.skipped).toBe(false);
		expect(result.processedEvaluators).toEqual(["alpha"]);
		expect(result.errors).toEqual([]);
		expect(prompts[0]).toContain(block);
	});

	it("rejects oversized provider history without dropping its oldest evidence", async () => {
		const runtime = makeRuntime();
		const prompts = captureModel(runtime);
		const process = vi.spyOn(runtime.evaluators[0].processors[0], "process");
		const state = stateWithBlock(conversationBlock(400));
		const original = structuredClone(state);
		expect(promptTokens(state.text)).toBeGreaterThan(BUDGET_TOKENS);
		const result = await new EvaluatorService(runtime).run(
			makeMessage(),
			state,
		);
		expect(prompts).toEqual([]);
		expect(process).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			skipped: false,
			processedEvaluators: [],
			results: [],
		});
		expect(result.errors).toEqual([
			expect.objectContaining({
				evaluatorName: "post_turn",
				error: expect.stringContaining("complete input exceeds"),
			}),
		]);
		expect(state).toEqual(original);
		expect(state.text).toContain("Nubs: row 0 ");
		expect(state.text).toContain("Nubs: row 399 ");
	});

	it("retains stored transcript records when the complete transcript exceeds admission", async () => {
		const runtime = makeRuntime();
		const prompts = captureModel(runtime);
		const message = {
			...makeMessage(),
			agentId: runtime.agentId,
			createdAt: 2,
		};
		const earlier = {
			...message,
			id: ENTITY_ID,
			createdAt: 1,
			content: {
				text: `Standing constraint: ${"full evidence ".repeat(4_000)}`,
				source: "test",
			},
		};
		await runtime.upsertMemory(earlier, "messages");
		await runtime.upsertMemory(message, "messages");
		const result = await new EvaluatorService(runtime).run(message);
		expect(prompts).toEqual([]);
		expect(result.skipped).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		expect((await runtime.getMemoryById(earlier.id))?.content).toEqual(
			earlier.content,
		);
		expect((await runtime.getMemoryById(message.id))?.content).toEqual(
			message.content,
		);
	});

	it("rejects a complete oversized tool result despite a legacy prefix cap", async () => {
		const runtime = makeRuntime();
		runtime.setSetting("POST_TURN_EVALUATOR_RESULT_MAX_CHARS", "400");
		const prompts = captureModel(runtime);
		const process = vi.spyOn(runtime.evaluators[0].processors[0], "process");
		const state = {
			values: {},
			data: {
				actionResults: [
					{
						success: true,
						data: {
							actionName: "MEMORY",
							evidence: "complete evidence ".repeat(4_000),
							tail: "Do not treat the earlier mutation as committed.",
						},
					},
				],
			},
			text: "",
		};
		const original = structuredClone(state);
		const result = await new EvaluatorService(runtime).run(
			makeMessage(),
			state,
		);
		expect(prompts).toEqual([]);
		expect(process).not.toHaveBeenCalled();
		expect(result.errors).toContainEqual(
			expect.objectContaining({
				evaluatorName: "post_turn",
				error: expect.stringContaining("complete input exceeds"),
			}),
		);
		expect(runtime.getRecentReportedErrors()).toContainEqual(
			expect.objectContaining({
				code: "EVALUATOR_INPUT_BUDGET_EXCEEDED",
			}),
		);
		expect(state).toEqual(original);
	});

	it("still processes independently resolved output when fresh model input is oversized", async () => {
		const runtime = makeRuntime();
		captureModel(runtime);
		const process = vi.fn(async () => ({ success: true }));
		runtime.registerEvaluator({
			name: "captured",
			description: "Already captured",
			shouldRun: async () => true,
			schema: {
				type: "object",
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
			},
			resolveOutput: () => ({ ok: true }),
			processors: [{ process }],
		});
		const result = await new EvaluatorService(runtime).run(
			makeMessage(),
			stateWithBlock(conversationBlock(400)),
		);
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(process).toHaveBeenCalledTimes(1);
		expect(result.processedEvaluators).toEqual(["captured"]);
		expect(result.errors).toContainEqual(
			expect.objectContaining({
				evaluatorName: "post_turn",
				error: expect.stringContaining("complete input exceeds"),
			}),
		);
	});

	it("reports oversized notes as a typed failure and settles the trajectory as failed", async () => {
		const runtime = makeRuntime();
		const prompts = captureModel(runtime);
		const report = vi.spyOn(runtime, "reportError");
		const trajectories = {
			isEnabled: () => true,
			startStep: vi.fn(() => "child-step"),
			completeStep: vi.fn(),
			flushWriteQueue: vi.fn(async () => {}),
		};
		const getService = runtime.getService.bind(runtime);
		runtime.getService = vi.fn((type: string) =>
			type === "trajectories"
				? (trajectories as unknown as Service)
				: getService(type),
		) as AgentRuntime["getService"];
		const state = {
			values: {},
			data: {},
			text: `# Notes\n${"x".repeat(40_000)}`,
		};
		expect(promptTokens(state.text)).toBeGreaterThan(BUDGET_TOKENS);

		const result = await runWithTrajectoryContext(
			{ trajectoryId: "traj-1", trajectoryStepId: "step-1" },
			() => new EvaluatorService(runtime).run(makeMessage(), state),
		);

		expect(prompts).toEqual([]);
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			skipped: false,
			activeEvaluators: ["alpha"],
			processedEvaluators: [],
			errors: [
				expect.objectContaining({
					evaluatorName: "post_turn",
					error: expect.stringContaining("complete input exceeds"),
				}),
			],
		});
		expect(report).toHaveBeenCalledWith(
			"EvaluatorService.evaluate",
			expect.any(ElizaError),
			expect.objectContaining({ evaluatorId: expect.any(String) }),
		);
		expect(runtime.getRecentReportedErrors()).toContainEqual(
			expect.objectContaining({
				code: "EVALUATOR_INPUT_BUDGET_EXCEEDED",
				context: expect.objectContaining({
					budgetTokens: BUDGET_TOKENS,
					estimatedPromptTokens: expect.any(Number),
				}),
			}),
		);
		expect(runtime.emitEvent).toHaveBeenCalledWith(
			EventType.ERROR_REPORTED,
			expect.objectContaining({ code: "EVALUATOR_INPUT_BUDGET_EXCEEDED" }),
		);
		expect(runtime.emitEvent).toHaveBeenCalledWith(
			EventType.EVALUATOR_COMPLETED,
			expect.objectContaining({
				completed: false,
				error: expect.any(ElizaError),
			}),
		);
		expect(trajectories.completeStep).toHaveBeenCalledWith(
			"traj-1",
			"step-1",
			expect.objectContaining({
				actionType: "evaluator",
				actionName: "post_turn",
				success: false,
				result: expect.objectContaining({
					success: false,
					data: expect.objectContaining({
						budgetTokens: BUDGET_TOKENS,
						llmCallSkipped: true,
						reason: "input_budget_exceeded",
					}),
				}),
			}),
		);
	});
});
