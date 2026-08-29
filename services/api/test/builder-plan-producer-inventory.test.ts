import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const expectedProducerCounts = new Map([
  ["executors.ts", 5],
  ["github/processor.ts", 1],
  ["github/router.ts", 1],
  ["integrations/inbound.ts", 1],
  ["learning.ts", 1],
  ["routes/v1/assistant.ts", 1],
  ["routes/v1/conversations.ts", 1],
  ["routes/v1/github.ts", 1],
  ["routes/v1/kb-tasks.ts", 1],
  ["routes/v1/runs.ts", 3],
  ["scheduler.ts", 1],
  ["schedules.ts", 1],
  ["watchtower/canary.ts", 1],
]);

describe("Builder plan producer inventory", () => {
  it("requires every production run insert to declare a reviewed preflight", () => {
    const inserts: Array<{
      file: string;
      relativeFile: string;
      offset: number;
      context: string;
      guarded: boolean;
      admissionModePersisted: boolean;
    }> = [];
    for (const file of typescriptFiles(sourceRoot)) {
      const source = readFileSync(file, "utf8");
      const relativeFile = file.slice(sourceRoot.length + 1);
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      visit(sourceFile, (node) => {
        if (!isRunsInsert(node)) return;
        const offset = node.getStart(sourceFile);
        inserts.push({
          file,
          relativeFile,
          offset,
          context: source.slice(Math.max(0, offset - 220), offset + 220),
          guarded: hasTransactionalAdmissionAncestor(node, relativeFile, sourceFile),
          admissionModePersisted: persistsAdmissionMode(node, relativeFile, sourceFile),
        });
      });
    }

    expect(inserts).toHaveLength(19);
    expect(
      new Map(
        [...new Set(inserts.map((insert) => insert.relativeFile))].map((file) => [
          file,
          inserts.filter((insert) => insert.relativeFile === file).length,
        ]),
      ),
    ).toEqual(expectedProducerCounts);
    for (const insert of inserts) {
      expect(
        insert.context,
        `${insert.file}:${insert.offset} inserts a run without the Builder plan producer review marker`,
      ).toMatch(/builder-plan-preflight:\s*[a-z0-9_:-]+\s*(?:\n|\r\n)/);
      expect(
        insert.guarded,
        `${insert.file}:${insert.offset} does not couple Builder preflight and run insertion under the shared project lock`,
      ).toBe(true);
      expect(
        insert.admissionModePersisted,
        `${insert.file}:${insert.offset} does not persist the immutable Builder admission mode`,
      ).toBe(true);
    }
  });
});

function isRunsInsert(node: ts.Node): node is ts.CallExpression {
  const target = ts.isCallExpression(node) ? node.arguments.at(0) : undefined;
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "insert" &&
    node.arguments.length === 1 &&
    target !== undefined &&
    ts.isIdentifier(target) &&
    target.text === "runs"
  );
}

function persistsAdmissionMode(
  insert: ts.CallExpression,
  relativeFile: string,
  sourceFile: ts.SourceFile,
) {
  for (let current: ts.Node | undefined = insert.parent; current; current = current.parent) {
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue;
    const call: ts.Node = current.parent;
    if (!ts.isCallExpression(call) || !call.arguments.includes(current)) continue;
    const body = current.getText(sourceFile);
    if (ts.isIdentifier(call.expression) && call.expression.text === "withBuilderPlanPreflight") {
      const parameter = current.parameters[1]?.name;
      if (!parameter || !ts.isIdentifier(parameter)) return false;
      return new RegExp(`mode\\s*:\\s*${parameter.text}\\.mode\\b`).test(body);
    }
    if (
      relativeFile === "scheduler.ts" &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "transaction"
    ) {
      return (
        /admittedMode\s*=\s*admission\.mode\b/.test(body) && /mode\s*:\s*admittedMode\b/.test(body)
      );
    }
  }
  return false;
}

function hasTransactionalAdmissionAncestor(
  insert: ts.CallExpression,
  relativeFile: string,
  sourceFile: ts.SourceFile,
) {
  for (let current: ts.Node | undefined = insert.parent; current; current = current.parent) {
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue;
    const call: ts.Node = current.parent;
    if (!ts.isCallExpression(call) || !call.arguments.includes(current)) continue;
    if (ts.isIdentifier(call.expression) && call.expression.text === "withBuilderPlanPreflight") {
      return true;
    }
    if (
      relativeFile === "scheduler.ts" &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "transaction"
    ) {
      const body = current.getText(sourceFile);
      return body.includes("lockBuilderPlanPolicy(") && body.includes("assertBuilderPlanDispatch(");
    }
  }
  return false;
}

function visit(node: ts.Node, callback: (node: ts.Node) => void) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}
