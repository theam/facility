import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, seed } from "@facility/db";
import { buildApp } from "./app.js";
import { readConfig } from "./config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = join(root, "packages/sdk/openapi.json");
const config = readConfig();

await migrate(config.databaseUrl);
await seed(config.databaseUrl);
const app = await buildApp(config);
await app.ready();
const document = app.swagger() as unknown as {
  servers: Array<{ url: string; description: string }>;
};
document.servers = [
  {
    url: "https://facility.example",
    description: "Replace with the base URL of your Facility deployment.",
  },
];
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(document, null, 2)}\n`);
await app.close();
console.log(`wrote ${out}`);
