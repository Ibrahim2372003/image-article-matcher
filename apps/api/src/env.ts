import { z } from "zod";

const num = (d: number) => z.coerce.number().default(d);
/** Optional numeric override: unset/empty stays undefined; anything else must be a finite number. */
const optNum = z.preprocess(
  (v) => (v === undefined || v === "" ? undefined : v),
  z.coerce.number().finite().optional(),
);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: num(3000).pipe(z.number().int().min(1).max(65535)),
  DATABASE_URL: z.string().url().default("postgres://postgres:postgres@localhost:5432/image_article_matcher"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  AI_PROVIDER: z.enum(["mock", "gemini", "ollama"]).default("mock"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_VISION_MODEL: z.string().default("gemini-2.5-flash"),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_VISION_MODEL: z.string().min(1).default("llama3.2-vision"),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1).default("nomic-embed-text"),
  AI_TIMEOUT_MS: num(30_000).pipe(z.number().int().min(1_000).max(300_000)),
  API_KEY: z.string().min(16, "API_KEY must be at least 16 characters").optional(),
  MAX_UPLOAD_BYTES: num(5 * 1024 * 1024).pipe(z.number().int().positive()),
  JOB_MAX_ATTEMPTS: num(3).pipe(z.number().int().min(1).max(10)),
  JOB_BACKOFF_BASE_MS: num(5_000).pipe(z.number().int().min(100).max(3_600_000)),
  JOB_BACKOFF_MAX_MS: num(300_000).pipe(z.number().int().min(100).max(86_400_000)),
  WORKER_CONCURRENCY: num(1).pipe(z.number().int().min(1).max(10)),
  JOB_STALE_QUEUED_MS: num(60_000).pipe(z.number().int().min(1_000)),
  JOB_STALE_PROCESSING_MS: num(600_000).pipe(z.number().int().min(1_000)),
  JOB_RECONCILE_INTERVAL_MS: num(30_000).pipe(z.number().int().min(1_000)),
  SHUTDOWN_TIMEOUT_MS: num(60_000).pipe(z.number().int().min(1_000).max(600_000)),
  QUEUE_PUBLISH_TIMEOUT_MS: num(3_000).pipe(z.number().int().min(100).max(60_000)),
  QUEUE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "QUEUE_NAME may only contain letters, digits, _ and -")
    .default("image-article-analysis"),
  IMAGE_STORAGE_DIR: z.string().min(1).default("./data/images"),
  AI_PRICING_JSON: z.string().optional(),
  RATE_LIMIT_MAX: num(30).pipe(z.number().int().min(1).max(100_000)),
  RATE_LIMIT_WINDOW_MS: num(60_000).pipe(z.number().int().min(1_000).max(3_600_000)),
  GUARD_MIN_CONFIDENCE: optNum,
  GUARD_MIN_SIMILARITY: optNum,
  GUARD_MIN_MARGIN: optNum,
  GUARD_MIN_SHARED_TAGS: optNum,
  DB_POOL_MAX: num(10).pipe(z.number().int().min(1).max(100)),
  DB_IDLE_TIMEOUT_MS: num(30_000).pipe(z.number().int().min(0)),
  DB_CONNECT_TIMEOUT_MS: num(5_000).pipe(z.number().int().min(1)),
  DB_STATEMENT_TIMEOUT_MS: num(30_000).pipe(z.number().int().min(0)),
  DB_SSL: z.enum(["disable", "require"]).default("disable"),
});
export type Env = z.infer<typeof EnvSchema>;

/** Fails fast with a readable message; never echoes secret values. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  const env = parsed.data;
  if (env.JOB_BACKOFF_MAX_MS < env.JOB_BACKOFF_BASE_MS) {
    throw new Error("Invalid environment configuration: JOB_BACKOFF_MAX_MS must be >= JOB_BACKOFF_BASE_MS");
  }
  if (env.AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
    throw new Error("Invalid environment configuration: GEMINI_API_KEY is required when AI_PROVIDER=gemini");
  }
  return env;
}

/**
 * The API fails CLOSED: without an API key every protected route answers 503. In production it also refuses to
 * start, so a misconfigured deployment is noticed immediately instead of serving 503s.
 */
export function assertApiKeyConfigured(env: Pick<Env, "NODE_ENV" | "API_KEY">): void {
  if (env.NODE_ENV === "production" && !env.API_KEY) {
    throw new Error("Invalid environment configuration: API_KEY is required when NODE_ENV=production");
  }
}
