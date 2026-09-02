try {
  await import("node:sqlite");
} catch {
  console.error(
    [
      "Facility requires a Node.js release with the node:sqlite builtin (pnpm 11 depends on it).",
      `Detected ${process.version}.`,
      "Install Node.js 22.13 or newer, or a current Node 24.x release, then rerun pnpm install.",
    ].join(" "),
  );
  process.exit(1);
}
