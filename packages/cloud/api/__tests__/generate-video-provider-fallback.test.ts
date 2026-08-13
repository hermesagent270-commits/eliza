/**
 * Exercises default video provider failover through the real Hono route and
 * provider registry with deterministic auth, billing, fal, and Atlas edges.
 * The suite verifies configuration filtering, terminal fallback, pending-job
 * preservation, actual-provider persistence, and single-settlement billing.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as aiPricingActual from "@/lib/services/ai-pricing";
import * as contentSafetyActual from "@/lib/services/content-safety";
import * as creditsActual from "@/lib/services/credits";
import * as generationsActual from "@/lib/services/generations";

const falActual = require("@fal-ai/client") as Record<string, unknown>;
const originalFetch = globalThis.fetch;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const FAL_MODEL = "fal-ai/veo3";
const ATLAS_MODEL = "vidu/q3-turbo/text-to-video";
const FAL_COST = 0.8;
const ATLAS_COST = 0.3;

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/content-safety", () => ({
  ...contentSafetyActual,
  contentSafetyService: {
    ...contentSafetyActual.contentSafetyService,
    assertSafeForPublicUse: async () => undefined,
  },
}));

const calculateVideoGenerationCostFromCatalog = mock(
  async ({ model }: { model: string }) => {
    const totalCost = model === FAL_MODEL ? FAL_COST : ATLAS_COST;
    return {
      totalCost,
      baseTotalCost: totalCost / 1.2,
      platformMarkup: totalCost - totalCost / 1.2,
    };
  },
);
mock.module("@/lib/services/ai-pricing", () => ({
  ...aiPricingActual,
  calculateVideoGenerationCostFromCatalog,
  getDefaultVideoBillingDimensions: (model: string) => ({
    durationSeconds: model === FAL_MODEL ? 8 : 5,
    dimensions:
      model === FAL_MODEL
        ? { audio: true }
        : { resolution: "720p", audio: false },
  }),
}));

const reserve = mock();
mock.module("@/lib/services/credits", () => ({
  ...creditsActual,
  creditsService: { ...creditsActual.creditsService, reserve },
}));

const generationsCreate = mock();
mock.module("@/lib/services/generations", () => ({
  ...generationsActual,
  generationsService: {
    ...generationsActual.generationsService,
    create: generationsCreate,
  },
}));

const subscribe = mock();
const queueStatus = mock();
const queueResult = mock();
mock.module("@fal-ai/client", () => ({
  ...falActual,
  createFalClient: () => ({
    subscribe,
    queue: { status: queueStatus, result: queueResult },
  }),
}));

const fetchMock = mock(
  async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    throw new Error("Unexpected fetch in video fallback test");
  },
);
globalThis.fetch = Object.assign(fetchMock, {
  preconnect: originalFetch.preconnect,
});

const videoRoute = (await import("../v1/generate-video/route")).default;

afterAll(() => {
  globalThis.fetch = originalFetch;
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module("@/lib/services/content-safety", () => contentSafetyActual);
  mock.module("@/lib/services/ai-pricing", () => aiPricingActual);
  mock.module("@/lib/services/credits", () => creditsActual);
  mock.module("@/lib/services/generations", () => generationsActual);
  mock.module("@fal-ai/client", () => falActual);
});

type AppCtx = { set: (key: string, value: unknown) => void };

function makeLedgerReservation(startBalance: number, hold: number) {
  let balance = startBalance - hold;
  let reconcileCalls = 0;
  let lastActual = Number.NaN;
  return {
    startBalance,
    get balance() {
      return balance;
    },
    get reconcileCalls() {
      return reconcileCalls;
    },
    get lastActual() {
      return lastActual;
    },
    reservation: {
      reservedAmount: hold,
      reservationTransactionId: "11111111-1111-4111-8111-111111111111",
      reconcile: async (actualCost: number) => {
        reconcileCalls++;
        lastActual = actualCost;
        balance += hold - actualCost;
        return undefined;
      },
    },
  };
}

function atlasSuccess(url = "https://atlas.media/video.mp4") {
  return new Response(
    JSON.stringify({
      data: {
        id: "atlas-request-1",
        status: "completed",
        outputs: [url],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function post(
  env: Record<string, unknown>,
  body: Record<string, unknown> = { prompt: "a neon cat" },
) {
  return videoRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  calculateVideoGenerationCostFromCatalog.mockClear();
  reserve.mockReset();
  generationsCreate.mockReset();
  subscribe.mockReset();
  queueStatus.mockReset();
  queueResult.mockReset();
  fetchMock.mockReset();

  requireUserOrApiKeyWithOrg.mockImplementation(async (c: AppCtx) => {
    c.set("apiKeyId", "key-1");
    return {
      id: USER,
      organization_id: ORG,
      organization: { id: ORG, name: "Org", is_active: true },
      is_active: true,
    };
  });
  generationsCreate.mockResolvedValue({ id: "generation-1" });
});

describe("generate-video — default provider fallback", () => {
  test("rejects an unconfigured default chain before pricing or credit work", async () => {
    const response = await post({});

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Video generation is not configured",
    });
    expect(calculateVideoGenerationCostFromCatalog).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uses Atlas directly when fal credentials are absent", async () => {
    const ledger = makeLedgerReservation(100, ATLAS_COST);
    reserve.mockResolvedValue(ledger.reservation);
    fetchMock.mockResolvedValue(atlasSuccess());

    const response = await post({ ATLASCLOUD_API_KEY: "atlas-key" });

    expect(response.status).toBe(200);
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(ATLAS_COST, 10);
    expect(generationsCreate).toHaveBeenCalledTimes(1);
    expect(generationsCreate.mock.calls[0]?.[0]).toMatchObject({
      model: ATLAS_MODEL,
      provider: "vidu",
      cost: String(ATLAS_COST),
      result: { billingSource: "atlascloud" },
      storage_url: "https://atlas.media/video.mp4",
    });
  });

  test("keeps an explicit model request pinned to its provider", async () => {
    const response = await post(
      { ATLASCLOUD_API_KEY: "atlas-key" },
      { model: FAL_MODEL, prompt: "a neon cat" },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Fal video generation is not configured",
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("falls back from a terminal fal failure and settles once at the Atlas cost", async () => {
    const ledger = makeLedgerReservation(100, FAL_COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockRejectedValue(new Error("fal unavailable"));
    fetchMock.mockResolvedValue(atlasSuccess());

    const response = await post({
      FAL_KEY: "fal-key",
      ATLASCLOUD_API_KEY: "atlas-key",
    });

    expect(response.status).toBe(200);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(ATLAS_COST, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - ATLAS_COST, 10);
    expect(generationsCreate.mock.calls[0]?.[0]).toMatchObject({
      model: ATLAS_MODEL,
      provider: "vidu",
      result: { billingSource: "atlascloud" },
    });
  });

  test("refunds once and reports failure when both providers fail terminally", async () => {
    const ledger = makeLedgerReservation(100, FAL_COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockRejectedValue(new Error("fal unavailable"));
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "atlas unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await post({
      FAL_KEY: "fal-key",
      ATLASCLOUD_API_KEY: "atlas-key",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Video provider request failed",
      details: {
        provider: "vidu",
        model: ATLAS_MODEL,
        billingSource: "atlascloud",
      },
    });
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
    expect(generationsCreate).not.toHaveBeenCalled();
  });

  test("does not fall back when fal may still complete upstream", async () => {
    const ledger = makeLedgerReservation(100, FAL_COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockImplementation(
      async (_model: string, options: Record<string, unknown>) => {
        (options.onEnqueue as (requestId: string) => void)("fal-pending-1");
        throw new Error("fal poll timed out");
      },
    );
    queueStatus.mockResolvedValue({ status: "IN_PROGRESS", logs: [] });

    const response = await post({
      FAL_KEY: "fal-key",
      ATLASCLOUD_API_KEY: "atlas-key",
    });

    expect(response.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ledger.reconcileCalls).toBe(0);
    expect(generationsCreate).toHaveBeenCalledTimes(1);
    expect(generationsCreate.mock.calls[0]?.[0]).toMatchObject({
      model: FAL_MODEL,
      provider: "fal",
      status: "pending",
      job_id: "fal-pending-1",
    });
  });
});
