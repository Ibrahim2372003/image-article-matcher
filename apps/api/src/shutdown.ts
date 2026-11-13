import type { Server } from "node:http";

export interface ShutdownOptions {
  server: Pick<Server, "close">;
  closers?: Array<() => Promise<void>>;
  timeoutMs?: number;
  exit?: (code: number) => void;
  log?: (msg: string) => void;
}

/** Returns a shutdown function (also wired to SIGINT/SIGTERM by `registerShutdown`). Safe to call twice. */
export function createShutdown(opts: ShutdownOptions): (signal: string) => Promise<void> {
  const { server, closers = [], timeoutMs = 10_000, exit = process.exit, log = console.log } = opts;
  let started = false;
  return async (signal) => {
    if (started) return;
    started = true;
    log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
    const timer = setTimeout(() => exit(1), timeoutMs);
    timer.unref();
    try {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      for (const close of closers) await close();
      clearTimeout(timer);
      exit(0);
    } catch {
      clearTimeout(timer);
      exit(1);
    }
  };
}

export function registerShutdown(opts: ShutdownOptions): void {
  const shutdown = createShutdown(opts);
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
