import { buildApp } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig();
const app = await buildApp(config);
await app.listen({ port: config.port, host: config.listenHost ?? "localhost" });
