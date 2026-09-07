// @vitest-environment jsdom

import {
  Button,
  ButtonLink,
  Callout,
  Divider,
  Eyebrow,
  Field,
  LegendChip,
  Metric,
  NumeralAnchor,
  PillTag,
  Select,
  StatusDot,
  Terminal,
  TextArea,
  TextInput,
} from "@facility/ui";
import axe from "axe-core";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CiStatusLink } from "../components/ci-status";
import { Markdown } from "../components/markdown";

/**
 * Fragment-level accessibility guard: server-render a component tree, run
 * axe-core over it, and fail on any violation. Color contrast needs a real
 * cascade and stays with the manual browser pass; page-level structure (skip
 * link, landmarks, focus order) does not apply to fragments and is covered
 * there too.
 */
async function expectNoViolations(ui: ReactElement) {
  const container = document.createElement("div");
  container.innerHTML = renderToString(ui);
  document.body.appendChild(container);
  try {
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    const failures = results.violations.flatMap((violation) =>
      violation.nodes.map((node) => `${violation.id} (${violation.help}): ${node.html}`),
    );
    expect(failures).toEqual([]);
  } finally {
    container.remove();
  }
}

describe("accessibility guard", () => {
  it("renders the design system primitives without violations", async () => {
    await expectNoViolations(
      <main>
        <h1>Agent activity</h1>
        <Eyebrow>Delivery</Eyebrow>
        <NumeralAnchor n={1} />
        <p>
          <LegendChip tone="ok">AI</LegendChip> <StatusDot tone="agent" pulse /> builder is working
        </p>
        <PillTag>queued</PillTag>
        <PillTag active>running</PillTag>
        <Divider />
        <h2>Actions</h2>
        <Button variant="primary">Start story</Button>
        <Button variant="outline">Suspend story</Button>
        <Button variant="textual">Archive story</Button>
        <Button variant="danger">Delete workspace</Button>
        <ButtonLink href="https://example.com/projects/p/stories/1">Open story</ButtonLink>
        <h2>Evidence</h2>
        <Callout eyebrow="Review" heading="One-shot merge">
          The pull request merged without change requests.
        </Callout>
        <Terminal
          title="Turn log"
          lines={[
            { text: "queued", tone: "info" },
            { text: "running", tone: "agent", tag: "12:00" },
          ]}
          footer="2 lines"
        />
        <Metric label="Turn cost" value="3.98" unit="USD" hint="after pricing" />
      </main>,
    );
  });

  it("associates every control with its label", async () => {
    await expectNoViolations(
      <main>
        <Field label="Story title" hint="Copied from the mirrored issue">
          <TextInput name="title" />
        </Field>
        <Field label="Monthly budget" error="Budget reached">
          <TextInput name="budget" />
        </Field>
        <Field label="Agent">
          <Select name="agent">
            <option value="builder">builder</option>
            <option value="architect">architect</option>
          </Select>
        </Field>
        <Field label="Notes">
          <TextArea name="notes" />
        </Field>
      </main>,
    );
  });

  it("renders CI status as text, not color alone", async () => {
    await expectNoViolations(
      <main>
        <p>
          <CiStatusLink state="success" url="https://example.com/checks/1" />
        </p>
        <p>
          <CiStatusLink
            state="failure"
            url="https://example.com/checks/2"
            failureNames={["lint", "typecheck", "test", "e2e"]}
          />
        </p>
      </main>,
    );
  });

  it("renders markdown evidence without violations", async () => {
    await expectNoViolations(
      <main>
        <Markdown
          source={[
            "# Delivery report",
            "",
            "The **builder** agent opened [pull request #12](https://example.com/pr/12).",
            "",
            "| check | result |",
            "| --- | --- |",
            "| lint | passed |",
            "| test | failed |",
            "",
            "- [x] branch pushed",
            "- [ ] human review",
            "",
            "> merged four hours after dispatch",
          ].join("\n")}
        />
      </main>,
    );
  });
});
