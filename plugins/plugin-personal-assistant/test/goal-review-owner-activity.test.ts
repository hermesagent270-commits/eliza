/**
 * Goal review staleness on a real PGlite runtime: occurrence refreshes create
 * and expire rows without the owner doing anything, so they must not count as
 * activity that keeps a neglected goal "on track".
 */

import { expect, it } from "vitest";
import { LifeOpsService } from "../src/lifeops/service.ts";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

async function reviewStates(completeFirstDay: boolean) {
  const fixture = await createLifeOpsTestRuntime();
  try {
    const service = new LifeOpsService(fixture.runtime);
    const goal = await service.createGoal({
      title: "Be calmer",
      cadence: { kind: "daily" },
    });
    const habit = await service.createDefinition({
      title: "Meditate",
      kind: "habit",
      timezone: "UTC",
      priority: 3,
      cadence: { kind: "daily", windows: ["morning"] },
      goalId: goal.goal.id,
    } as Parameters<LifeOpsService["createDefinition"]>[0]);
    const base = Date.parse("2026-10-11T00:00:00.000Z");
    const states: Record<string, string> = {};
    let lastActivityAt: string | null = null;
    for (let day = 0; day <= 3; day += 1) {
      for (const hour of [9, 14]) {
        const now = new Date(base + day * 86_400_000 + hour * 3_600_000);
        const definition = await service.repository.getDefinition(
          fixture.runtime.agentId,
          habit.definition.id,
        );
        if (!definition) throw new Error("definition missing");
        const occurrences = await service.refreshDefinitionOccurrences(
          definition,
          now,
        );
        if (completeFirstDay && day === 0 && hour === 9) {
          const today = occurrences.find(
            (occurrence) => occurrence.metadata.localDateKey === "2026-10-11",
          );
          if (!today) throw new Error("today's occurrence missing");
          await service.completeOccurrence(today.id, {}, now);
        }
        const review = await service.reviewGoal(goal.goal.id, now);
        states[now.toISOString().slice(5, 13)] = review.summary.reviewState;
        lastActivityAt = review.summary.lastActivityAt;
      }
    }
    return { states, lastActivityAt };
  } finally {
    await fixture.cleanup();
  }
}

it("flags a daily goal the owner has not worked on for two days", async () => {
  const { states, lastActivityAt } = await reviewStates(false);
  expect(states["10-11T09"]).toBe("on_track");
  expect(states["10-13T14"]).toBe("at_risk");
  expect(states["10-14T09"]).toBe("needs_attention");
  expect(lastActivityAt).toBeNull();
}, 120_000);

it("dates activity from the owner's last completion", async () => {
  const { states, lastActivityAt } = await reviewStates(true);
  expect(states["10-12T09"]).toBe("on_track");
  expect(states["10-13T14"]).toBe("at_risk");
  expect(lastActivityAt?.slice(0, 19)).toBe("2026-10-11T09:00:00");
}, 120_000);
