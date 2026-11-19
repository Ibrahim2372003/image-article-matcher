import { z } from "zod";
import type { AiProvider, ClassifyImageInput, EmbedTextOptions, ProviderUsage } from "../ai/types.js";
import { AiProviderError } from "../ai/errors.js";
import { classifyError } from "./failure.js";
import type { CostBasis, UsageEntry, UsageOperation } from "./types.js";

/** Rates per 1M tokens, keyed by model name. There are NO built-in defaults: unknown models have unknown cost. */
export const PricingSchema = z.record(
  z.string().min(1),
  z.object({ inputPer1M: z.number().finite().nonnegative(), outputPer1M: z.number().finite().nonnegative() }).strict(),
);
export type PricingTable = z.infer<typeof PricingSchema>;

export function parsePricing(json: string | undefined): PricingTable {
  if (!json || json.trim() === "") return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("AI_PRICING_JSON is not valid JSON");
  }
  const parsed = PricingSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `AI_PRICING_JSON is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}

/**
 * Cost is an ESTIMATE computed only from an operator-configured rate and provider-REPORTED token counts.
 * Otherwise it is unknown (null), never zero: a free/unknown model must not look free.
 */
export function estimateCost(
  model: string,
  usage: ProviderUsage | null,
  pricing: PricingTable,
): { costUsd: number | null; basis: CostBasis } {
  const rate = pricing[model];
  if (!rate) return { costUsd: null, basis: "no_rate_configured" };
  if (!usage || usage.estimated || usage.inputTokens === null) return { costUsd: null, basis: "tokens_unavailable" };
  if (usage.outputTokens === null && rate.outputPer1M !== 0) return { costUsd: null, basis: "tokens_unavailable" };
  const cost = (usage.inputTokens * rate.inputPer1M + (usage.outputTokens ?? 0) * rate.outputPer1M) / 1_000_000;
  return { costUsd: Math.round(cost * 1e8) / 1e8, basis: "configured_rate_estimate" };
}

export interface TrackingOptions {
  jobId: string;
  attempt: number;
  operation: UsageOperation;
  record: (entry: UsageEntry) => Promise<void>;
  pricing: PricingTable;
  now?: () => number;
  onRecordError?: (err: unknown) => void;
}

/**
 * Wraps a provider so every REAL call (success or failure) is recorded with latency, reported tokens and outcome.
 * Results reused from storage never reach the provider, so they create no usage rows. A failure to write the ledger
 * entry is reported to `onRecordError` but never fails the job or discards a paid-for AI result (the ledger may
 * under-count in that rare case; it never over-counts or invents numbers).
 */
export function withUsageTracking(provider: AiProvider, o: TrackingOptions): AiProvider {
  const now = o.now ?? Date.now;
  const model = o.operation === "classify_image" ? provider.visionModel : provider.embeddingModel;

  async function tracked<T extends { usage: ProviderUsage; model: string }>(call: () => Promise<T>): Promise<T> {
    const started = now();
    try {
      const result = await call();
      const cost = estimateCost(result.model, result.usage, o.pricing);
      await write({ success: true, errorCode: null, model: result.model, usage: result.usage, ...cost });
      return result;
    } catch (err) {
      const usage = err instanceof AiProviderError ? err.usage : null;
      const cost = estimateCost(model, usage, o.pricing);
      await write({ success: false, errorCode: classifyError(err).code, model, usage, ...cost });
      throw err;
    }

    async function write(f: {
      success: boolean;
      errorCode: string | null;
      model: string;
      usage: ProviderUsage | null;
      costUsd: number | null;
      basis: CostBasis;
    }) {
      try {
        await o.record({
          jobId: o.jobId,
          attempt: o.attempt,
          operation: o.operation,
          provider: provider.name,
          model: f.model,
          success: f.success,
          errorCode: f.errorCode,
          latencyMs: Math.max(0, now() - started),
          usage: f.usage,
          estimatedCostUsd: f.costUsd,
          costBasis: f.basis,
        });
      } catch (e) {
        o.onRecordError?.(e);
      }
    }
  }

  return {
    name: provider.name,
    visionModel: provider.visionModel,
    embeddingModel: provider.embeddingModel,
    classifyImage: (input: ClassifyImageInput) => tracked(() => provider.classifyImage(input)),
    embedText: (text: string, options?: EmbedTextOptions) => tracked(() => provider.embedText(text, options)),
  };
}
