/**
 * Local latency benchmark for the plan burst and sustained buckets
 * (AlphaCompute/alphaphone#410). It measures what the buckets add to an
 * assistant inference admission under five conditions:
 *
 *   normal          cached plan snapshot, tokens available
 *   cache-miss      no snapshot, first request of a new account (default limits)
 *   exhausted       the account's bucket is empty (429)
 *   expired         the cached plan window has ended (default limits)
 *   billing-outage  the billing database is closed
 *
 * Part 1 times the limiter stage alone: the exact in-memory call that
 * `enforceOrgRateLimit` makes before its policy transaction. Part 2 times
 * `enforceOrgRateLimit` end to end on in-process PGlite with the limiter off
 * and on. PGlite has no network, so part 2 is a lower bound on the existing
 * policy transaction, not a production number. The bucket numbers below are
 * benchmark values only; they are not selected limits.
 *
 * Run: bun --conditions=eliza-source packages/cloud/scripts/plan-request-limit-latency.ts
 * Output: test-results/plan-request-limit-latency/results.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "61000000-0000-4000-8000-00000000a410";
const STAGE_ITERATIONS = 20_000;
const E2E_ITERATIONS = 400;
const WARMUP = 50;

/** Benchmark-only numbers, deliberately large so admitted runs never refuse. */
const BENCH_CONFIG = (planKey: string) => ({
  selected: false,
  plans: {
    default: {
      burst: { capacity: 1_000_000, refillPerSecond: 1_000 },
      sustained: { capacity: 1_000_000, refillPerSecond: 1_000 },
    },
    [planKey]: {
      burst: { capacity: 1_000_000, refillPerSecond: 1_000 },
      sustained: { capacity: 1_000_000, refillPerSecond: 1_000 },
    },
    exhausted: {
      burst: { capacity: 1, refillPerSecond: 0.000_001 },
      sustained: { capacity: 1, refillPerSecond: 0.000_001 },
    },
  },
});

interface Summary {
  n: number;
  p50: number;
  p95: number;
  mean: number;
}

function summarize(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (v: number) => Math.round(v * 1_000) / 1_000;
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    mean: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
  };
}

async function time(
  iterations: number,
  run: (i: number) => unknown,
): Promise<number[]> {
  for (let i = 0; i < WARMUP; i++) await run(-1 - i);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    await run(i);
    samples.push(performance.now() - started);
  }
  return samples;
}

async function main(): Promise<void> {
  const database = await import("../shared/src/db/client");
  const { createBillingSnapshotFixture } = await import(
    "../shared/src/db/repositories/account-billing-snapshot-test-fixture"
  );
  const exec = async (query: string) => {
    await database.getPgliteClientForTests().exec(query);
  };
  await createBillingSnapshotFixture(exec, "");
  await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${ORG}', '0', 1, 0, '{}', true, false, 'active')`);
  const { enforceOrgRateLimit, OrgRateLimitCacheNotReadyError } = await import(
    "../shared/src/lib/middleware/rate-limit"
  );
  const snapshots = await import(
    "../shared/src/lib/services/inference-admission-snapshot"
  );
  const limiter = await import(
    "../shared/src/lib/services/plan-request-limiter"
  );

  const snapshot = await snapshots.loadInferenceAdmissionSnapshot(ORG);
  const planKey = snapshot.planKey ?? "default";
  const config = snapshots.inferenceRateLimitConfig(snapshot, "completions");
  if (!config)
    throw new Error("admission snapshot produced no rate-limit config");
  const expiredConfig = {
    ...config,
    authority: config.authority && {
      ...config.authority,
      effectiveUntil: new Date(Date.now() - 60_000).toISOString(),
    },
  };
  const exhaustedConfig = { ...config, planKey: "exhausted" };
  const benchJson = JSON.stringify(BENCH_CONFIG(planKey));
  const setLimiter = (on: boolean) => {
    limiter.resetPlanRequestLimiterForTests();
    if (on) process.env.ELIZA_CLOUD_PLAN_RATE_LIMITS = benchJson;
    else delete process.env.ELIZA_CLOUD_PLAN_RATE_LIMITS;
  };
  const exhaust = async (userId: string) => {
    await enforceOrgRateLimit(ORG, "completions", {
      config: exhaustedConfig,
      userId,
    });
  };

  // Part 1: the limiter stage alone.
  setLimiter(true);
  const stage: Record<string, Summary> = {};
  const stageCall = (
    identity: Parameters<typeof limiter.enforcePlanRequestLimit>[0],
  ) => limiter.enforcePlanRequestLimit(identity);
  stage.normal = summarize(
    await time(STAGE_ITERATIONS, () =>
      stageCall({
        organizationId: ORG,
        userId: "normal",
        planKey,
        planEffectiveUntil: config.authority?.effectiveUntil,
      }),
    ),
  );
  stage["cache-miss"] = summarize(
    await time(STAGE_ITERATIONS, (i) =>
      stageCall({ organizationId: ORG, userId: `miss-${i}` }),
    ),
  );
  stageCall({ organizationId: ORG, userId: "spent", planKey: "exhausted" });
  stage.exhausted = summarize(
    await time(STAGE_ITERATIONS, () => {
      const response = stageCall({
        organizationId: ORG,
        userId: "spent",
        planKey: "exhausted",
      });
      if (response?.status !== 429)
        throw new Error("exhausted bucket admitted a request");
    }),
  );
  stage.expired = summarize(
    await time(STAGE_ITERATIONS, () =>
      stageCall({
        organizationId: ORG,
        userId: "expired",
        planKey,
        planEffectiveUntil: expiredConfig.authority?.effectiveUntil,
      }),
    ),
  );

  // Part 2: enforceOrgRateLimit end to end on PGlite, limiter off and on.
  const e2e: Record<
    string,
    { off: Summary; on: Summary; addedP50: number; addedP95: number }
  > = {};
  const compare = async (
    name: string,
    run: (i: number) => Promise<unknown>,
    prepare?: () => Promise<void>,
  ) => {
    setLimiter(false);
    const off = summarize(await time(E2E_ITERATIONS, run));
    setLimiter(true);
    if (prepare) await prepare();
    const on = summarize(await time(E2E_ITERATIONS, run));
    e2e[name] = {
      off,
      on,
      addedP50: Math.round((on.p50 - off.p50) * 1_000) / 1_000,
      addedP95: Math.round((on.p95 - off.p95) * 1_000) / 1_000,
    };
  };
  await compare("normal", () =>
    enforceOrgRateLimit(ORG, "completions", { config, userId: "normal" }),
  );
  await compare("cache-miss", (i) =>
    enforceOrgRateLimit(ORG, "completions", { userId: `e2e-miss-${i}` }),
  );
  await compare(
    "exhausted",
    () =>
      enforceOrgRateLimit(ORG, "completions", {
        config: exhaustedConfig,
        userId: "e2e-spent",
      }),
    () => exhaust("e2e-spent"),
  );
  // The ended window no longer matches the primary policy stamp, so the
  // existing fence answers "warming" (503) after its transaction in both runs.
  await compare("expired", () =>
    enforceOrgRateLimit(ORG, "completions", {
      config: expiredConfig,
      userId: "e2e-expired",
    }).catch((error: unknown) => {
      if (!(error instanceof OrgRateLimitCacheNotReadyError)) throw error;
    }),
  );

  // Billing outage: the database is closed. The limiter stage and a refusal
  // still decide from memory. An admitted request continues to the existing
  // policy transaction, whose outage behavior this change does not alter.
  setLimiter(true);
  await exhaust("outage-spent");
  await database.closeDatabaseConnectionsForTests();
  const outageRefusal = summarize(
    await time(E2E_ITERATIONS, async () => {
      const response = await enforceOrgRateLimit(ORG, "completions", {
        config: exhaustedConfig,
        userId: "outage-spent",
      });
      if (response?.status !== 429)
        throw new Error("outage refusal did not return 429");
    }),
  );
  // After the end-to-end refusal: new accounts here would evict its bucket.
  stage["billing-outage"] = summarize(
    await time(STAGE_ITERATIONS, (i) =>
      stageCall({ organizationId: ORG, userId: `outage-${i}`, planKey }),
    ),
  );

  const result = {
    issue: "https://github.com/AlphaCompute/alphaphone/issues/410",
    measuredAt: new Date().toISOString(),
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    unit: "milliseconds",
    note: "Local in-process measurement. PGlite has no network; production adds the policy transaction's real database round trip to both limiter-off and limiter-on rows. Bucket numbers are benchmark values, not selected limits.",
    limiterStage: stage,
    enforceOrgRateLimitPglite: e2e,
    billingOutageRefusalEndToEnd: outageRefusal,
  };
  const output = testOutputPath("plan-request-limit-latency", "results.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`wrote ${output}`);
}

await main();
