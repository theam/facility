import { buildApp } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig();
const app = await buildApp(config);
await app.listen({ port: config.port, host: "0.0.0.0" });

let closing = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "facility gateway shutting down");
  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, "facility gateway shutdown failed");
    process.exitCode = 1;
  }
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
