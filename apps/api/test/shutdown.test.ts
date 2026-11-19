import { describe, expect, it, vi } from "vitest";
import { createShutdown } from "../src/shutdown.js";

const server = (err?: Error) => ({ close: (cb?: (e?: Error) => void) => (cb?.(err), undefined as never) });

describe("graceful shutdown", () => {
  it("closes server then closers, exits 0, and runs only once", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const sd = createShutdown({
      server: { close: ((cb: (e?: Error) => void) => (order.push("server"), cb())) as never },
      closers: [async () => void order.push("pool")],
      exit,
      log: () => {},
    });
    await sd("SIGTERM");
    await sd("SIGTERM");
    expect(order).toEqual(["server", "pool"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
  it("exits 1 when a closer fails", async () => {
    const exit = vi.fn();
    const sd = createShutdown({
      server: server(),
      closers: [async () => Promise.reject(new Error("x"))],
      exit,
      log: () => {},
    });
    await sd("SIGINT");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("worker shutdown (no HTTP server)", () => {
  it("runs closers strictly in order, waits for each, then exits 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const sd = createShutdown({
      closers: [
        async () => {
          await new Promise((r) => setTimeout(r, 20));
          order.push("reconciler");
        },
        async () => void order.push("worker"),
        async () => void order.push("queue"),
        async () => void order.push("redis"),
        async () => void order.push("pool"),
      ],
      exit,
      log: () => {},
    });
    await sd("SIGTERM");
    expect(order).toEqual(["reconciler", "worker", "queue", "redis", "pool"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("a closer that never finishes cannot block the process forever: exits 1 at the timeout", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const sd = createShutdown({
        closers: [() => new Promise<void>(() => {})],
        timeoutMs: 5_000,
        exit,
        log: () => {},
      });
      void sd("SIGTERM");
      await vi.advanceTimersByTimeAsync(5_001);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second signal during shutdown does not start a second shutdown", async () => {
    const closer = vi.fn(async () => {});
    const sd = createShutdown({ closers: [closer], exit: vi.fn(), log: () => {} });
    await Promise.all([sd("SIGINT"), sd("SIGTERM")]);
    expect(closer).toHaveBeenCalledTimes(1);
  });
});
