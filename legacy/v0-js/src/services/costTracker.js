import { PRICING_PER_1M_TOKENS_USD } from "../config.js";

/**
 * Estimate a call's cost from published per-token rates. Returns
 * `estimatedCostUsd: null` with `costBasis: 'no_rate_configured'` when
 * the model has no configured rate or token counts are unknown — a cost
 * is never invented, and the result is only ever an ESTIMATE.
 */
export function estimateCostUsd({ model, inputTokens, outputTokens, pricing = PRICING_PER_1M_TOKENS_USD }) {
  const rate = pricing[model];
  if (!rate || typeof inputTokens !== "number") {
    return { estimatedCostUsd: null, costBasis: "no_rate_configured" };
  }
  const cost = (inputTokens * rate.input + (outputTokens ?? 0) * rate.output) / 1_000_000;
  return { estimatedCostUsd: Math.round(cost * 1e8) / 1e8, costBasis: "published_rate_estimate" };
}

/**
 * Record one AI call — successful or not — in model_calls. `usage` may
 * be null (a failure before any token count was available).
 */
export async function trackModelCall(store, { provider, model, operation, startedAt, finishedAt, usage, success, errorMessage = null }) {
  const inputTokens = usage?.inputTokens ?? null;
  const outputTokens = usage?.outputTokens ?? null;
  const { estimatedCostUsd, costBasis } = estimateCostUsd({ model, inputTokens, outputTokens });
  return store.recordModelCall({
    provider,
    model,
    operation,
    startedAt,
    finishedAt,
    inputTokens,
    outputTokens,
    tokensEstimated: usage?.estimated === true,
    estimatedCostUsd,
    costBasis,
    success,
    errorMessage,
  });
}

/**
 * Aggregate recorded calls. `estimatedCostUsd` sums only calls that have
 * an estimate; `callsWithoutRate` says how many do not. `actualCostUsd`
 * is always null: billing state cannot be verified from the API, so this
 * never claims a call was free or what it really cost.
 */
export function summarizeCalls(calls) {
  const byOperation = {};
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let estimatedCostUsd = 0;
  let callsWithoutRate = 0;
  let failedCalls = 0;

  for (const call of calls) {
    const op = (byOperation[call.operation] ??= { calls: 0, failedCalls: 0, estimatedCostUsd: 0 });
    op.calls += 1;
    if (!call.success) {
      op.failedCalls += 1;
      failedCalls += 1;
    }
    totalInputTokens += call.inputTokens ?? 0;
    totalOutputTokens += call.outputTokens ?? 0;
    if (call.estimatedCostUsd === null || call.estimatedCostUsd === undefined) callsWithoutRate += 1;
    else {
      estimatedCostUsd += Number(call.estimatedCostUsd);
      op.estimatedCostUsd += Number(call.estimatedCostUsd);
    }
  }
  const round = (n) => Math.round(n * 1e8) / 1e8;
  for (const op of Object.values(byOperation)) op.estimatedCostUsd = round(op.estimatedCostUsd);

  return {
    totalCalls: calls.length,
    successfulCalls: calls.length - failedCalls,
    failedCalls,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUsd: round(estimatedCostUsd),
    callsWithoutRate,
    byOperation,
    actualCostUsd: null,
    billingVerified: false,
    note:
      "estimatedCostUsd is computed from published per-token rates for a PAID call and excludes calls with no configured rate. " +
      "Actual billed cost is unknown to this app (Google AI Studio's free tier is expected to bill $0 within quota, but that is not verified here) — check your provider dashboard.",
  };
}
