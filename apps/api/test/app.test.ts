import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HealthSchema, ApiErrorSchema } from "@iam/shared";
import { createApp } from "../src/app.js";

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

describe("api", () => {
  it("GET /health returns a valid health payload and request id", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(HealthSchema.safeParse(await res.json()).success).toBe(true);
  });
  it("unknown routes return the consistent error envelope", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(ApiErrorSchema.safeParse(await res.json()).success).toBe(true);
  });
});
