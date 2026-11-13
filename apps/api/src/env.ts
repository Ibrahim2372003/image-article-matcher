import { z } from "zod";

const num = (d: number) => z.coerce.number().default(d);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: num(3000).pipe(z.number().int().min(1).max(65535)),
  DATABASE_URL: z.string().url().default("postgres://postgres:postgres@localhost:5432/image_article_matcher"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  AI_PROVIDER: z.enum(["mock", "gemini", "ollama"]).default("mock"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_VISION_MODEL: z.string().default("gemini-2.5-flash"),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  API_KEY: z.string().min(16, "API_KEY must be at least 16 characters").optional(),
  MAX_UPLOAD_BYTES: num(5 * 1024 * 1024).pipe(z.number().int().positive()),
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
  if (env.AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
    throw new Error("Invalid environment configuration: GEMINI_API_KEY is required when AI_PROVIDER=gemini");
  }
  return env;
}
