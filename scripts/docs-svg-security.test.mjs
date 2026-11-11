import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const docsRequire = createRequire(new URL("../apps/docs/package.json", import.meta.url));
const coreRequire = createRequire(docsRequire.resolve("@docusaurus/core/package.json"));
const presetRequire = createRequire(docsRequire.resolve("@docusaurus/preset-classic/package.json"));
const pluginRequire = createRequire(presetRequire.resolve("@docusaurus/plugin-svgr/package.json"));
const loaderRequire = createRequire(pluginRequire.resolve("@svgr/webpack/package.json"));
const svgoRequire = createRequire(loaderRequire.resolve("@svgr/plugin-svgo/package.json"));
const webpack = coreRequire("webpack");
const React = docsRequire("react");
const { renderToStaticMarkup } = docsRequire("react-dom/server");

test("docs SVG optimizer has no resolvable or locked deepmerge dependency", () => {
  assert.equal(svgoRequire("@svgr/plugin-svgo/package.json").version, "8.1.0");
  assert.throws(() => svgoRequire.resolve("deepmerge"), { code: "MODULE_NOT_FOUND" });
  const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(lock, /^\s+deepmerge(?:@|:)/m);
});

async function compile(t, svg) {
  const root = mkdtempSync(join(tmpdir(), "facility-docs-svg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "entry.js"), 'export { default } from "./icon.svg";');
  writeFileSync(join(root, "icon.svg"), svg);
  const compiler = webpack({
    mode: "development",
    target: "node",
    devtool: false,
    entry: join(root, "entry.js"),
    output: { path: join(root, "out"), filename: "icon.cjs", library: { type: "commonjs2" } },
    resolve: { alias: { react: docsRequire.resolve("react") } },
    module: {
      rules: [{
        test: /\.svg$/,
        use: [{
          loader: pluginRequire.resolve("@svgr/webpack"),
          options: {
            runtimeConfig: false,
            titleProp: true,
            svgo: true,
            svgoConfig: {
              plugins: [{ name: "preset-default", params: { overrides: { removeViewBox: false } } }],
            },
          },
        }],
      }],
    },
  });
  try {
    await new Promise((resolve, reject) => compiler.run((error, stats) => {
      if (error) return reject(error);
      if (!stats || stats.hasErrors())
        return reject(new Error(stats?.toString({ all: false, errors: true }) ?? "Missing stats"));
      resolve();
    }));
    const result = createRequire(join(root, "entry.js"))(join(root, "out/icon.cjs"));
    return result.default;
  } finally {
    await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
  }
}

test("real docs webpack SVG loader retains configured optimization and React rendering", async t => {
  const Icon = await compile(t,
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#000000" d="M0 0h24v24H0z"/></svg>',
  );
  const html = renderToStaticMarkup(React.createElement(Icon, { title: "M6 <icon>" }));
  assert.match(html, /<svg\b/);
  assert.match(html, /viewBox="0 0 24 24"/);
  assert.match(html, /<title[^>]*>M6 &lt;icon&gt;<\/title>/);
  assert.match(html, /<path\b/);
});

test("real docs webpack SVG loader still rejects malformed input", async t => {
  await assert.rejects(compile(t, "<svg><path></svg>"), /SvgoParserError|Unexpected close tag|Unclosed/);
});
