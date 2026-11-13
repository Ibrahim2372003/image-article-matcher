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
