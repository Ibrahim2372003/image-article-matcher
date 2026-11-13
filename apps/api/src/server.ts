import { createApp } from "./app.js";
import { closePool } from "./db/pool.js";
import { loadEnv } from "./env.js";
import { registerShutdown } from "./shutdown.js";

const env = loadEnv();
const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(JSON.stringify({ level: "info", msg: "api listening", port: env.PORT, provider: env.AI_PROVIDER }));
});
registerShutdown({ server, closers: [closePool] });
