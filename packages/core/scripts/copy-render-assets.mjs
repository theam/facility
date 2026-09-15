import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(packageRoot, "../..");
const destinationRoot = join(packageRoot, "dist/render-assets");
const assetDirectories = ["packages/cli/templates/agents"];

mkdirSync(destinationRoot, { recursive: true });
for (const relativePath of assetDirectories) {
  const source = join(workspaceRoot, relativePath);
  if (!existsSync(source)) {
    throw new Error(`Required render asset directory is missing: ${relativePath}`);
  }
  cpSync(source, join(destinationRoot, relativePath), { recursive: true, force: true });
}

const builder = "packages/cli/templates/agents/builder.md";
if (!existsSync(join(destinationRoot, builder))) {
  throw new Error(`Required render asset was not packaged: ${builder}`);
}
