import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function patchedImageSizeModule() {
  const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  const match = lockfile.match(/^  image-size@2\.0\.2: ([a-f0-9]+)$/m);
  assert.ok(match, "image-size 2.0.2 must remain pinned to the reviewed local patch");

  const storeDir = join(root, "node_modules", ".pnpm");
  const entries = await readdir(storeDir);
  const patchedEntry = entries.find((entry) => /^image-size@2\.0\.2_patch_hash[=_][a-f0-9]+$/.test(entry));
  assert.ok(
    patchedEntry,
    "expected a patched image-size@2.0.2 entry under node_modules/.pnpm — run pnpm install",
  );

  return join(storeDir, patchedEntry, "node_modules", "image-size", "dist", "index.mjs");
}

function writeBox(buffer, offset, size, name) {
  buffer.writeUInt32BE(size, offset);
  buffer.write(name, offset + 4, 4, "ascii");
}

function maliciousIcns() {
  const input = Buffer.alloc(16);
  input.write("icns", 0, 4, "ascii");
  input.writeUInt32BE(input.length, 4);
  input.write("ic07", 8, 4, "ascii");
  input.writeUInt32BE(0, 12);
  return input;
}

function maliciousHeif() {
  const input = Buffer.alloc(64);
  writeBox(input, 0, 16, "ftyp");
  input.write("mif1", 8, 4, "ascii");
  writeBox(input, 16, 48, "meta");
  writeBox(input, 28, 36, "iprp");
  writeBox(input, 36, 28, "ipco");
  writeBox(input, 44, 0, "ispe");
  input.writeUInt32BE(1, 56);
  input.writeUInt32BE(1, 60);
  return input;
}

function maliciousJxl() {
  const input = Buffer.alloc(36);
  writeBox(input, 0, 12, "JXL ");
  writeBox(input, 12, 16, "ftyp");
  input.write("jxl ", 20, 4, "ascii");
  writeBox(input, 28, 0, "jxlp");
  return input;
}

for (const [format, input] of [
  ["ICNS", maliciousIcns()],
  ["HEIF", maliciousHeif()],
  ["JXL", maliciousJxl()],
]) {
  test(`patched image-size rejects non-advancing ${format} boxes`, async () => {
    const moduleUrl = pathToFileURL(await patchedImageSizeModule()).href;
    const source = `
      import imageSize from ${JSON.stringify(moduleUrl)};
      const input = Buffer.from(${JSON.stringify(input.toString("base64"))}, "base64");
      try {
        imageSize(input);
        process.exit(2);
      } catch (error) {
        if (!String(error).includes("does not advance")) {
          console.error(error);
          process.exit(3);
        }
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: root,
      encoding: "utf8",
      timeout: 1_500,
    });

    assert.equal(result.error, undefined, `${format} parser did not terminate: ${result.error}`);
    assert.equal(result.status, 0, result.stderr);
  });
}
