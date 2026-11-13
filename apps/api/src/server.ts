import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const app = createApp();
app.listen(env.PORT, () => {
  console.log(JSON.stringify({ level: "info", msg: "api listening", port: env.PORT, provider: env.AI_PROVIDER }));
});
