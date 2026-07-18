import assert from "node:assert/strict";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { execute } from "./index.js";
import { loadSemanticModel } from "./model-loader.js";

const zeebeFixture = fileURLToPath(
  new URL("../test/fixtures/AI Email Support Agent.bpmn", import.meta.url)
);
const collaborationFixture = fileURLToPath(
  new URL(
    "../test/fixtures/car rental booking process.bpmn",
    import.meta.url
  )
);

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bpmn-cli-utilities-"));
}

function generatedModel(
  count: number,
  namePrefix: string,
  separateProcesses = false
): string {
  const elements = Array.from({ length: count }, (_, index) =>
    separateProcesses
      ? `<bpmn:process id="Process_${index}">
    <bpmn:startEvent id="StartEvent_${index}" />
  </bpmn:process>`
      : `<bpmn:task id="Task_${index}" name="${namePrefix} ${index}" />`
  ).join("\n  ");
  const body = separateProcesses
    ? elements
    : `<bpmn:process id="Process_1">\n  ${elements}\n</bpmn:process>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="https://example.com">
  ${body}
</bpmn:definitions>
`;
}

test("lints both real fixtures with the correctness fallback", async () => {
  for (const fixture of [zeebeFixture, collaborationFixture]) {
    const result = await execute(["lint", fixture, "--json"]);
    const document = JSON.parse(result.output);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stream, "stdout");
    assert.equal(document.schemaVersion, "1");
    assert.equal(document.view, "lint");
    assert.deepEqual(document.config, {
      source: "fallback",
      extends: "bpmnlint:correctness"
    });
    assert.equal(document.engine.name, "bpmnlint");
    assert.deepEqual(document.counts, { errors: 0, warnings: 0 });
    assert.deepEqual(document.findings, []);
  }
});

test("honors explicit bpmnlint severities and exit behavior", async () => {
  const directory = await temporaryDirectory();
  const config = join(directory, ".bpmnlintrc");
  const model = join(directory, "missing-end.bpmn");

  try {
    await writeFile(
      model,
      `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="https://example.com">
  <bpmn:process id="Process_1">
    <bpmn:startEvent id="StartEvent_1">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:task id="Task_1">
      <bpmn:incoming>Flow_1</bpmn:incoming>
    </bpmn:task>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Task_1" />
  </bpmn:process>
</bpmn:definitions>
`,
      "utf8"
    );
    await writeFile(
      config,
      JSON.stringify({ rules: { "end-event-required": "error" } }),
      "utf8"
    );
    const errorResult = await execute([
      "lint",
      model,
      "--config",
      config,
      "--json"
    ]);
    const errorDocument = JSON.parse(errorResult.output);

    assert.equal(errorResult.exitCode, 1);
    assert.equal(errorResult.stream, "stderr");
    assert.ok(errorDocument.counts.errors > 0);
    assert.equal(errorDocument.config.source, "file");
    assert.ok(
      errorDocument.findings.every(
        (finding: { category: string }) => finding.category === "error"
      )
    );

    await writeFile(
      config,
      JSON.stringify({ rules: { "end-event-required": "warn" } }),
      "utf8"
    );
    const warningResult = await execute([
      "lint",
      model,
      "--config",
      config,
      "--json"
    ]);
    const warningDocument = JSON.parse(warningResult.output);

    assert.equal(warningResult.exitCode, 0);
    assert.equal(warningResult.stream, "stdout");
    assert.equal(warningDocument.counts.errors, 0);
    assert.ok(warningDocument.counts.warnings > 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("diffs equal models without semantic changes", async () => {
  const result = await execute([
    "diff",
    zeebeFixture,
    zeebeFixture,
    "--json"
  ]);
  const document = JSON.parse(result.output);

  assert.equal(result.exitCode, 0);
  assert.equal(document.changed, false);
  assert.deepEqual(document.changes, {
    added: [],
    removed: [],
    changed: []
  });
  assert.match(document.engine.commit, /^[0-9a-f]{40}$/);
});

test("detects exact extension-element property changes", async () => {
  const directory = await temporaryDirectory();
  const after = join(directory, "after.bpmn");

  try {
    const source = await readFile(zeebeFixture, "utf8");
    await writeFile(after, source.replaceAll('retries="3"', 'retries="4"'));

    const result = await execute([
      "diff",
      zeebeFixture,
      after,
      "--json"
    ]);
    const document = JSON.parse(result.output);
    const propertyChanges = document.changes.changed.flatMap(
      (element: { changes: unknown[] }) => element.changes
    );

    assert.equal(result.exitCode, 0);
    assert.equal(document.changed, true);
    assert.ok(document.changes.changed.length > 0);
    assert.ok(
      propertyChanges.some(
        (change: { path: string; before: string; after: string }) =>
          change.path.includes("extensionElements") &&
          change.path.endsWith(".retries") &&
          change.before === "3" &&
          change.after === "4"
      )
    );

    const model = await loadSemanticModel({
      autoProfile: true,
      extensions: [],
      file: zeebeFixture
    });
    const changedIds = document.changes.changed.map(
      (element: { elementRef: string }) => element.elementRef
    );
    const changedIdSet = new Set(changedIds);
    const expectedOrder = model.allElements
      .map(({ id }) => id)
      .filter((id): id is string => id !== undefined && changedIdSet.has(id));
    assert.deepEqual(changedIds, expectedOrder);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps DI changes outside the semantic diff", async () => {
  const directory = await temporaryDirectory();
  const after = join(directory, "after.bpmn");

  try {
    const source = await readFile(collaborationFixture, "utf8");
    const changed = source.replace(/ x="(\d+(?:\.\d+)?)"/, (_, value) =>
      ` x="${Number(value) + 17}"`
    );
    assert.notEqual(changed, source);
    await writeFile(after, changed);

    const semanticResult = await execute([
      "diff",
      collaborationFixture,
      after,
      "--json"
    ]);
    const semanticDocument = JSON.parse(semanticResult.output);
    assert.equal(semanticDocument.changed, false);
    assert.equal(semanticDocument.layoutChanged, undefined);

    const layoutResult = await execute([
      "diff",
      collaborationFixture,
      after,
      "--include-layout",
      "--json"
    ]);
    const layoutDocument = JSON.parse(layoutResult.output);
    assert.equal(layoutDocument.changed, true);
    assert.ok(layoutDocument.layoutChanged.length > 0);
    assert.deepEqual(layoutDocument.changes, {
      added: [],
      removed: [],
      changed: []
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("ignores namespace-prefix and presentation-color changes", async () => {
  const directory = await temporaryDirectory();
  const after = join(directory, "after.bpmn");

  try {
    const source = await readFile(zeebeFixture, "utf8");
    const changed = source
      .replaceAll("xmlns:bpmn=", "xmlns:semantic=")
      .replaceAll("bpmn:", "semantic:")
      .replaceAll("#bbdefb", "#ffffff")
      .replaceAll("#0d4372", "#000000");
    assert.notEqual(changed, source);
    await writeFile(after, changed);

    const result = await execute(["diff", zeebeFixture, after, "--json"]);
    const document = JSON.parse(result.output);

    assert.equal(result.exitCode, 0);
    assert.equal(document.changed, false);
    assert.deepEqual(document.changes, {
      added: [],
      removed: [],
      changed: []
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("lays out both real fixtures without changing semantic hashes", async () => {
  const directory = await temporaryDirectory();

  try {
    for (const [index, fixture] of [
      zeebeFixture,
      collaborationFixture
    ].entries()) {
      const output = join(directory, `layout-${index}.bpmn`);
      const sourceBefore = await readFile(fixture, "utf8");
      const result = await execute([
        "layout",
        fixture,
        "--output",
        output,
        "--json"
      ]);
      const document = JSON.parse(result.output);

      assert.equal(result.exitCode, 0);
      assert.equal(document.status, "written");
      assert.equal(document.destination, output);
      assert.notEqual(document.sourceSha256, document.outputSha256);
      assert.match(document.semanticHash, /^[0-9a-f]{64}$/);
      assert.equal(await readFile(fixture, "utf8"), sourceBefore);
      assert.notEqual(await readFile(output, "utf8"), sourceBefore);

      const diffResult = await execute([
        "diff",
        fixture,
        output,
        "--json"
      ]);
      assert.equal(JSON.parse(diffResult.output).changed, false);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("atomically replaces a copied source and protects separate output", async () => {
  const directory = await temporaryDirectory();
  const source = join(directory, "source.bpmn");
  const output = join(directory, "output.bpmn");

  try {
    await copyFile(collaborationFixture, source);
    const before = await readFile(source, "utf8");
    const inPlace = await execute(["layout", source, "--json"]);

    assert.equal(inPlace.exitCode, 0);
    assert.notEqual(await readFile(source, "utf8"), before);

    await writeFile(output, "protected", "utf8");
    const refused = await execute([
      "layout",
      collaborationFixture,
      "--output",
      output,
      "--json"
    ]);

    assert.equal(refused.exitCode, 2);
    assert.equal(refused.stream, "stderr");
    assert.equal(JSON.parse(refused.output).error.code, "OUTPUT_WRITE_FAILED");
    assert.equal(await readFile(output, "utf8"), "protected");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("bounds lint and diff output while allowing complete safe reports", async () => {
  const directory = await temporaryDirectory();
  const lintModel = join(directory, "lint.bpmn");
  const lintConfig = join(directory, ".bpmnlintrc");
  const lintReport = join(directory, "lint.json");
  const before = join(directory, "before.bpmn");
  const after = join(directory, "after.bpmn");
  const diffReport = join(directory, "diff.json");

  try {
    await writeFile(lintModel, generatedModel(450, "", true), "utf8");
    await writeFile(
      lintConfig,
      JSON.stringify({ rules: { "end-event-required": "error" } }),
      "utf8"
    );
    const boundedLint = await execute([
      "lint",
      lintModel,
      "--config",
      lintConfig,
      "--json"
    ]);
    assert.equal(boundedLint.exitCode, 1);
    assert.equal(JSON.parse(boundedLint.output).error.code, "OUTPUT_TOO_LARGE");

    const reportedLint = await execute([
      "lint",
      lintModel,
      "--config",
      lintConfig,
      "--json",
      "--report",
      lintReport
    ]);
    assert.equal(reportedLint.exitCode, 1);
    assert.equal(reportedLint.output, "");
    assert.equal(JSON.parse(await readFile(lintReport, "utf8")).counts.errors, 450);

    const refusedLint = await execute([
      "lint",
      lintModel,
      "--config",
      lintConfig,
      "--json",
      "--report",
      lintReport
    ]);
    assert.equal(refusedLint.exitCode, 2);
    assert.equal(JSON.parse(refusedLint.output).error.code, "OUTPUT_WRITE_FAILED");

    await writeFile(before, generatedModel(450, "Before"), "utf8");
    await writeFile(after, generatedModel(450, "After"), "utf8");
    const boundedDiff = await execute(["diff", before, after, "--json"]);
    assert.equal(boundedDiff.exitCode, 1);
    assert.equal(JSON.parse(boundedDiff.output).error.code, "OUTPUT_TOO_LARGE");

    const reportedDiff = await execute([
      "diff",
      before,
      after,
      "--json",
      "--report",
      diffReport
    ]);
    assert.equal(reportedDiff.exitCode, 0);
    assert.equal(reportedDiff.output, "");
    assert.equal(
      JSON.parse(await readFile(diffReport, "utf8")).changes.changed.length,
      450
    );

    const aliasedDiff = await execute([
      "diff",
      before,
      after,
      "--json",
      "--report",
      before
    ]);
    assert.equal(aliasedDiff.exitCode, 2);
    assert.equal(JSON.parse(aliasedDiff.output).error.code, "OUTPUT_WRITE_FAILED");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
