/** Handles authenticated video generation, billing, and pending-job reconciliation. */
import { Hono } from "hono";
import { z } from "zod";
import {
  admitFlatGenerativeOperation,
  asGenerativeCacheApiError,
  getGenerativeExecutionContext,
  getGenerativePricingCacheOptions,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import {
  ApiError,
  failureResponse,
  jsonError,
} from "@/lib/api/cloud-worker-errors";
import {
  collectVideoProviderApiKeys,
  getConfiguredVideoProviderCandidates,
} from "@/lib/providers/video/registry";
import {
  type GeneratedVideo,
  VIDEO_PENDING_SETTLEMENT_MARKER,
  VideoGenerationPendingError,
} from "@/lib/providers/video/types";
import {
  type BillingContext,
  billFlatUsage,
  type FlatBillingCost,
} from "@/lib/services/ai-billing";
import {
  calculateVideoGenerationCostFromCatalog,
  getDefaultVideoBillingDimensions,
} from "@/lib/services/ai-pricing";
import {
  DEFAULT_VIDEO_MODEL_IDS,
  getSupportedVideoModelDefinition,
  SUPPORTED_VIDEO_MODEL_IDS,
  type SupportedVideoModelDefinition,
} from "@/lib/services/ai-pricing-definitions";
import { contentSafetyService } from "@/lib/services/content-safety";
import { InsufficientCreditsError } from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
import { persistPendingVideoSettlement } from "@/lib/services/pending-video-settlement";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_PROMPT_LENGTH = 4000;

const videoRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  model: z.string().trim().min(1).optional(),
  referenceUrl: z.string().trim().url().optional(),
  durationSeconds: z.coerce.number().int().min(1).max(30).optional(),
  resolution: z.string().trim().max(32).optional(),
  audio: z.boolean().optional(),
  voiceControl: z.boolean().optional(),
});

const app = new Hono<AppEnv>();

/** Everything the catch needs to persist a pending settlement (#11862). */
interface PendingSettlementContext {
  organizationId: string;
  userId: string;
  model: string;
  prompt: string;
  provider: string;
  billingSource: string;
  totalCost: number;
  durationSeconds: number;
  parameters: Record<string, unknown>;
}

interface PricedVideoCandidate {
  definition: SupportedVideoModelDefinition;
  provider: ReturnType<
    typeof getConfiguredVideoProviderCandidates
  >[number]["provider"];
  billingContext: BillingContext;
  cost: FlatBillingCost;
  durationSeconds: number;
  resolution?: string;
  audio?: boolean;
  voiceControl?: boolean;
}

function providerDisplayName(
  definition: SupportedVideoModelDefinition,
): string {
  return definition.provider === "fal" ? "Fal" : definition.provider;
}

function requireDefaultVideoModelDefinitions(): SupportedVideoModelDefinition[] {
  return DEFAULT_VIDEO_MODEL_IDS.map((modelId) => {
    const definition = getSupportedVideoModelDefinition(modelId);
    if (!definition) {
      throw new Error(`Default video model is not supported: ${modelId}`);
    }
    return definition;
  });
}

function redactProviderErrorMessage(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|token|secret|authorization)=([^&\s]+)/gi,
      "$1=[REDACTED]",
    );
}

function providerFailureDetails(options: {
  provider: string;
  model: string;
  billingSource: string;
  error: unknown;
}): Record<string, unknown> {
  const errorRecord =
    typeof options.error === "object" && options.error !== null
      ? (options.error as Record<string, unknown>)
      : {};
  const details: Record<string, unknown> = {
    provider: options.provider,
    model: options.model,
    billingSource: options.billingSource,
  };
  const status = errorRecord.status ?? errorRecord.statusCode;
  if (typeof status === "number" && Number.isFinite(status)) {
    details.upstreamStatus = status;
  }
  if (typeof errorRecord.code === "string" && errorRecord.code.trim()) {
    details.upstreamCode = errorRecord.code.trim().slice(0, 128);
  }
  const message =
    options.error instanceof Error
      ? options.error.message
      : typeof options.error === "string"
        ? options.error
        : "";
  if (message.trim()) {
    details.upstreamMessage = redactProviderErrorMessage(message.trim()).slice(
      0,
      500,
    );
  }
  return details;
}

app.post("/", async (c) => {
  let admission:
    | Awaited<ReturnType<typeof admitFlatGenerativeOperation>>
    | undefined;
  // Once the charge is SETTLED, a later (non-critical, post-settle) failure must
  // NOT hit the catch's reconcile(0) — which is non-idempotent and would refund
  // the already-correct charge, giving a free video. Mirrors generate-image.
  let chargeSettled = false;
  let pendingContext: PendingSettlementContext | null = null;

  try {
    const { user, apiKeyId, admissionSnapshot } =
      await requireGenerativeRouteCaller(c, { rateLimitEndpoint: "strict" });
    const request = videoRequestSchema.parse(await c.req.json());
    const requestedDefinition = request.model
      ? getSupportedVideoModelDefinition(request.model)
      : undefined;
    if (request.model && !requestedDefinition) {
      return jsonError(
        c,
        400,
        `Unsupported video model: ${request.model}`,
        "validation_error",
        {
          supportedModels: SUPPORTED_VIDEO_MODEL_IDS,
        },
      );
    }

    const definitions = requestedDefinition
      ? [requestedDefinition]
      : requireDefaultVideoModelDefinitions();
    const apiKeys = collectVideoProviderApiKeys(c.env);
    const providerCandidates = getConfiguredVideoProviderCandidates(
      definitions,
      apiKeys,
    );
    if (providerCandidates.length === 0) {
      const message = requestedDefinition
        ? `${providerDisplayName(requestedDefinition)} video generation is not configured`
        : "Video generation is not configured";
      return jsonError(c, 503, message, "internal_error");
    }

    const operationRequestId = `generate-video:${crypto.randomUUID()}`;
    const [, candidates] = await Promise.all([
      contentSafetyService.assertSafeForPublicUse({
        surface: "media_generation_prompt",
        organizationId: user.organization_id,
        userId: user.id,
        text: [
          `Video prompt: ${request.prompt}`,
          request.referenceUrl
            ? `Reference URL: ${request.referenceUrl}`
            : undefined,
        ],
        imageUrls: request.referenceUrl ? [request.referenceUrl] : undefined,
        metadata: { type: "video", model: definitions[0].modelId },
      }),
      Promise.all(
        providerCandidates.map(async ({ definition, provider }) => {
          const defaults = getDefaultVideoBillingDimensions(definition.modelId);
          const durationSeconds =
            request.durationSeconds ?? defaults.durationSeconds;
          const resolution =
            request.resolution ?? definition.defaultParameters.resolution;
          const audio = request.audio ?? definition.defaultParameters.audio;
          const voiceControl =
            request.voiceControl ?? definition.defaultParameters.voiceControl;
          const dimensions = {
            ...defaults.dimensions,
            ...(resolution ? { resolution } : {}),
            ...(audio !== undefined ? { audio } : {}),
            ...(voiceControl !== undefined ? { voiceControl } : {}),
            ...(defaults.dimensions.durationSeconds !== undefined
              ? { durationSeconds }
              : {}),
          };
          const cost = await calculateVideoGenerationCostFromCatalog({
            model: definition.modelId,
            billingSource: definition.billingSource,
            durationSeconds,
            dimensions,
            cache: getGenerativePricingCacheOptions(c),
          });
          const billingContext: BillingContext = {
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId,
            model: definition.modelId,
            provider: definition.provider,
            billingSource: definition.billingSource,
            requestId: operationRequestId,
            affiliateCode: c.req.header("X-Affiliate-Code"),
            description: `Video generation: ${definition.modelId}`,
          };
          return {
            definition,
            provider,
            billingContext,
            cost,
            durationSeconds,
            resolution,
            audio,
            voiceControl,
          } satisfies PricedVideoCandidate;
        }),
      ),
    ]);
    const primaryCandidate = candidates[0];
    if (!primaryCandidate) {
      throw new Error("Configured video provider candidates were not priced");
    }
    const reservationCost = candidates.reduce(
      (highest, candidate) =>
        candidate.cost.totalCost > highest.totalCost ? candidate.cost : highest,
      primaryCandidate.cost,
    );

    try {
      admission = await admitFlatGenerativeOperation({
        c,
        context: primaryCandidate.billingContext,
        apiKeyId,
        cost: reservationCost,
        admissionSnapshot,
      });
    } catch (error) {
      // error-policy:J1 the HTTP boundary translates insufficient-credit
      // admission into the stable route response and rethrows other failures.
      if (error instanceof InsufficientCreditsError) {
        return c.json(
          {
            success: false,
            error: "Insufficient credits",
            required: error.required,
          },
          402,
        );
      }
      throw error;
    }

    let generated: GeneratedVideo | undefined;
    let selectedCandidate: PricedVideoCandidate | undefined;
    let lastFailure:
      | { candidate: PricedVideoCandidate; error: unknown }
      | undefined;
    for (const [index, candidate] of candidates.entries()) {
      pendingContext = {
        organizationId: user.organization_id,
        userId: user.id,
        model: candidate.definition.modelId,
        prompt: request.prompt,
        provider: candidate.definition.provider,
        billingSource: candidate.definition.billingSource,
        totalCost: candidate.cost.totalCost,
        durationSeconds: candidate.durationSeconds,
        parameters: {
          referenceUrl: request.referenceUrl,
          durationSeconds: candidate.durationSeconds,
          resolution: candidate.resolution,
          audio: candidate.audio,
          voiceControl: candidate.voiceControl,
        },
      };
      await admission.markProviderDispatched?.();
      try {
        generated = await candidate.provider.generate({
          model: candidate.definition.modelId,
          prompt: request.prompt,
          referenceUrl: request.referenceUrl,
          durationSeconds: candidate.durationSeconds,
          resolution: candidate.resolution,
          audio: candidate.audio,
          voiceControl: candidate.voiceControl,
          apiKeys,
        });
        selectedCandidate = candidate;
        break;
      } catch (error) {
        // error-policy:J1 the route retries only a verified terminal provider
        // failure; pending work remains on its reconciliation boundary.
        if (error instanceof VideoGenerationPendingError) throw error;
        lastFailure = { candidate, error };
        if (index < candidates.length - 1) {
          logger.warn("[GenerateVideo] Provider failed; trying fallback", {
            provider: candidate.definition.provider,
            model: candidate.definition.modelId,
            error: redactProviderErrorMessage(
              error instanceof Error ? error.message : String(error),
            ),
          });
        }
      }
    }
    if (!generated || !selectedCandidate) {
      if (!lastFailure) {
        throw new Error(
          "Video provider candidate loop completed without a result",
        );
      }
      throw new ApiError(
        503,
        "internal_error",
        "Video provider request failed",
        providerFailureDetails({
          provider: lastFailure.candidate.definition.provider,
          model: lastFailure.candidate.definition.modelId,
          billingSource: lastFailure.candidate.definition.billingSource,
          error: lastFailure.error,
        }),
      );
    }
    const { definition, billingContext, cost, durationSeconds } =
      selectedCandidate;
    if (generated.hasNsfwConcepts?.some(Boolean)) {
      throw new ApiError(
        400,
        "validation_error",
        "Generated video failed safety review",
        {
          surface: "media_generation_output",
          provider: definition.provider,
          model: definition.modelId,
          issues: ["provider_nsfw_signal"],
        },
      );
    }

    const generationId = crypto.randomUUID();
    let billingApplied = false;
    const persistenceTask = (async () => {
      await billFlatUsage(billingContext, cost, admission?.reservation);
      billingApplied = true;
      chargeSettled = true;
      await generationsService.create({
        id: generationId,
        organization_id: user.organization_id,
        user_id: user.id,
        type: "video",
        model: definition.modelId,
        provider: definition.provider,
        prompt: request.prompt,
        result: {
          requestId: generated.requestId,
          seed: generated.seed,
          timings: generated.timings,
          billingSource: definition.billingSource,
        },
        status: "completed",
        storage_url: generated.video.url,
        thumbnail_url: generated.video.url,
        file_size: generated.video.file_size
          ? BigInt(generated.video.file_size)
          : undefined,
        mime_type: generated.video.content_type ?? "video/mp4",
        parameters: {
          referenceUrl: request.referenceUrl,
          durationSeconds,
          resolution: selectedCandidate.resolution,
          audio: selectedCandidate.audio,
          voiceControl: selectedCandidate.voiceControl,
        },
        dimensions: {
          width: generated.video.width,
          height: generated.video.height,
          duration: durationSeconds,
        },
        cost: String(cost.totalCost),
        credits: String(cost.totalCost),
        job_id: generated.requestId,
        completed_at: new Date(),
      });
    })().catch(async (error) => {
      // error-policy:J7 successful video billing/history persistence runs
      // outside the response; conservative settlement remains observable.
      if (!billingApplied) await admission?.settleUnknown();
      logger.error("[GenerateVideo] Background persistence failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const executionCtx = getGenerativeExecutionContext(c);
    if (executionCtx) executionCtx.waitUntil(persistenceTask);
    else void persistenceTask;

    return c.json({
      success: true,
      id: generationId,
      requestId: generated.requestId,
      video: generated.video,
      seed: generated.seed,
      timings: generated.timings,
      has_nsfw_concepts: generated.hasNsfwConcepts,
      cost,
    });
  } catch (error) {
    // error-policy:J1 this route boundary preserves pending work, releases
    // terminal failures, and translates the final error into an HTTP response.
    // Poll timeout with the upstream job still live (#11862): the render may
    // still complete and bill the platform, so the hold must NOT be refunded.
    // Persist the job for the reconcile sweep, which verifies the upstream
    // terminal state — charging on late success, refunding once on failure.
    if (
      error instanceof VideoGenerationPendingError &&
      admission &&
      !chargeSettled &&
      pendingContext
    ) {
      const pendingAdmission = admission;
      const pending = pendingContext;
      const pendingGenerationId = crypto.randomUUID();
      const persistPendingSettlement = persistPendingVideoSettlement({
        generationId: pendingGenerationId,
        requestId: error.requestId,
        ...pending,
        settlementMarker: VIDEO_PENDING_SETTLEMENT_MARKER,
        existingReservation:
          pendingAdmission.mode === "synchronous_reservation"
            ? pendingAdmission.reservation
            : undefined,
        releaseDeferredAdmission: () => pendingAdmission.settle(0),
      })
        .then(() => {
          logger.warn(
            "[GenerateVideo] Upstream job still pending after poll window — holding credits for reconcile",
            {
              generationId: pendingGenerationId,
              requestId: error.requestId,
              organizationId: pending.organizationId,
              billedCost: pending.totalCost,
            },
          );
        })
        .catch((persistError) => {
          // error-policy:J7 the upstream job may still bill us, so a failed
          // detached persistence must retain the admitted hold for the sweep.
          logger.error(
            "[GenerateVideo] Failed to persist pending settlement — leaving hold for the reservation sweep",
            {
              requestId: error.requestId,
              error:
                persistError instanceof Error
                  ? persistError.message
                  : String(persistError),
            },
          );
        });
      const executionCtx = getGenerativeExecutionContext(c);
      if (executionCtx) executionCtx.waitUntil(persistPendingSettlement);
      else await persistPendingSettlement;
      return c.json(
        {
          success: false,
          status: "pending",
          id: pendingGenerationId,
          requestId: error.requestId,
          error:
            "Video generation is still running upstream. Credits stay reserved and settle automatically: charged if the video completes, refunded if it fails.",
        },
        202,
      );
    }
    if (admission && !chargeSettled) {
      const release = admission.settle(0);
      const executionCtx = getGenerativeExecutionContext(c);
      const observed = release.catch((reconcileError) => {
        // error-policy:J7 settlement diagnostics must not hide the original
        // route failure; the reservation sweep remains the durable backstop.
        logger.error("[GenerateVideo] Failed to release admission", {
          error:
            reconcileError instanceof Error
              ? reconcileError.message
              : String(reconcileError),
        });
      });
      if (executionCtx) executionCtx.waitUntil(observed);
      else await observed;
    }
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
