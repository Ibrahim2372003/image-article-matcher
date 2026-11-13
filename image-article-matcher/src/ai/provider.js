/**
 * The provider contract. Everything that touches AI (services, jobs,
 * the evaluation script) depends on this shape and nothing else, so the
 * real Gemini client and the deterministic test double are
 * interchangeable:
 *
 *   {
 *     name: string,
 *     visionModel: string,
 *     embeddingModel: string,
 *     classifyImage({ imagePath, base64, mimeType })
 *        -> { rawOutput: unknown, usage: {inputTokens, outputTokens, estimated}, model: string }
 *     embedText(text, { taskType? })
 *        -> { vector: number[], usage: {inputTokens, outputTokens, estimated}, model: string }
 *   }
 *
 * Providers return RAW output. They never validate it and never decide
 * anything — validation (Zod) and every decision (the Mismatch Guard)
 * live outside the provider, which is what keeps an LLM from being able
 * to override the deterministic guard.
 */
export function assertProvider(provider) {
  const problems = [];
  if (!provider || typeof provider !== "object") problems.push("provider must be an object");
  else {
    if (typeof provider.name !== "string" || !provider.name) problems.push("provider.name must be a non-empty string");
    if (typeof provider.classifyImage !== "function") problems.push("provider.classifyImage must be a function");
    if (typeof provider.embedText !== "function") problems.push("provider.embedText must be a function");
  }
  if (problems.length) throw new Error(`Invalid AI provider: ${problems.join("; ")}`);
  return provider;
}
