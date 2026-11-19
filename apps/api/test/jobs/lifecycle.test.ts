import { describe, expect, it } from "vitest";
import { JOB_STATUSES } from "@iam/shared";
import { canTransition, computeBackoffMs, isTerminal } from "../../src/jobs/lifecycle.js";

describe("job lifecycle", () => {
  it("terminal statuses are exactly completed, failed, needs_review", () => {
    expect(JOB_STATUSES.filter(isTerminal).sort()).toEqual(["completed", "failed", "needs_review"]);
  });
  it("matches the documented transition table", () => {
    const allowed: Array<[string, string]> = [
      ["queued", "processing"],
      ["queued", "failed"],
      ["processing", "processing"],
      ["processing", "queued"],
      ["processing", "completed"],
      ["processing", "needs_review"],
      ["processing", "failed"],
    ];
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const expected = allowed.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });
  it("terminal jobs can never move anywhere", () => {
    for (const t of ["completed", "failed", "needs_review"] as const) {
      for (const to of JOB_STATUSES) expect(canTransition(t, to)).toBe(false);
    }
  });
  it("a job can never go queued -> completed without being processed", () => {
    expect(canTransition("queued", "completed")).toBe(false);
    expect(canTransition("queued", "needs_review")).toBe(false);
  });
});

describe("computeBackoffMs", () => {
  const cfg = { baseMs: 1000, maxMs: 30_000 };
  it("doubles each attempt", () => {
    expect([1, 2, 3, 4, 5].map((n) => computeBackoffMs(n, cfg))).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });
  it("is capped at maxMs, even for absurd attempt numbers", () => {
    expect(computeBackoffMs(6, cfg)).toBe(30_000);
    expect(computeBackoffMs(1_000_000, cfg)).toBe(30_000);
  });
  it("treats invalid attempt numbers as the first attempt", () => {
    for (const bad of [0, -3, NaN, Infinity, -Infinity]) expect(computeBackoffMs(bad, cfg)).toBe(1000);
  });
  it("never exceeds the cap or returns a negative/NaN delay", () => {
    for (let n = 1; n <= 80; n += 1) {
      const d = computeBackoffMs(n, cfg);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });
});
