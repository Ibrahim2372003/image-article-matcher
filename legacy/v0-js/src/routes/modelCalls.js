import { Router } from "express";
import { asyncHandler } from "./util.js";

export function createModelCallsRouter({ store }) {
  const router = Router();

  // Every AI call, aggregated. Costs are ESTIMATES; actualCostUsd is
  // always null because billing state cannot be verified from here.
  router.get("/summary", asyncHandler(async (_req, res) => res.json(await store.summarizeModelCalls())));

  router.get("/", asyncHandler(async (_req, res) => res.json(await store.listModelCalls())));

  return router;
}
