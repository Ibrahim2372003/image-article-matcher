import { describe, expect, it } from "vitest";
import { buildPoolConfig, describeDatabase, redactSecrets } from "../src/db/config.js";
import { loadEnv } from "../src/env.js";

describe("pool config", () => {
  it("uses bounded defaults", () => {
    const cfg = buildPoolConfig(loadEnv({}));
    expect(cfg.max).toBe(10);
    expect(cfg.connectionTimeoutMillis).toBe(5000);
    expect(cfg.idleTimeoutMillis).toBe(30000);
    expect(cfg.statement_timeout).toBe(30000);
    expect(cfg.ssl).toBeUndefined();
  });
  it("honours overrides and TLS", () => {
    const cfg = buildPoolConfig(loadEnv({ DB_POOL_MAX: "3", DB_SSL: "require" }));
    expect(cfg.max).toBe(3);
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });
  it("rejects unbounded or invalid pool settings", () => {
    expect(() => loadEnv({ DB_POOL_MAX: "0" })).toThrow(/Invalid environment/);
    expect(() => loadEnv({ DB_POOL_MAX: "1000" })).toThrow(/Invalid environment/);
    expect(() => loadEnv({ DB_SSL: "maybe" })).toThrow(/Invalid environment/);
  });
});

describe("secret hygiene", () => {
  const url = "postgres://appuser:s3cr3t-pw@db.example.com:5433/mydb";
  it("describeDatabase omits credentials", () => {
    const d = describeDatabase(url);
    expect(d).toBe("db.example.com:5433/mydb");
    expect(d).not.toContain("s3cr3t-pw");
    expect(d).not.toContain("appuser");
  });
  it("redactSecrets strips the url and password from messages", () => {
    const out = redactSecrets(`connect failed for ${url} (password s3cr3t-pw)`, url);
    expect(out).not.toContain("s3cr3t-pw");
    expect(out).not.toContain(url);
  });
  it("handles unparseable urls without throwing", () => {
    expect(describeDatabase("not a url")).toBe("(unparseable DATABASE_URL)");
    expect(redactSecrets("x", "not a url")).toBe("x");
  });
});
