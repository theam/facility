#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (error) => {
    console.error(error?.code === "prompt_eof" ? error.message : (error?.stack ?? String(error)));
    process.exit(1);
  }
);
