import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  execute,
  getCapabilities,
  version
} from "./index.js";

const require = createRequire(import.meta.url);
const packageManifest = require("../package.json") as {
  dependencies: Record<string, string>;
  version: string;
};
const entrypoint = fileURLToPath(new URL("./index.js", import.meta.url));
const fixture = fileURLToPath(
  new URL("../test/fixtures/AI Email Support Agent.bpmn", import.meta.url)
);

test("renders discoverable global help", async () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    const result = await execute(args);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stream, "stdout");
    assert.match(result.output, /^bpmn-cli /);
    assert.match(result.output, /capabilities/);
    assert.match(result.output, /inspect/);
    assert.match(result.output, /trace/);
    assert.match(result.output, /lint/);
    assert.match(result.output, /diff/);
    assert.match(result.output, /layout/);
    assert.match(result.output, /help \[command\]/);
    assert.match(result.output, /bpmn-cli <command> --help/);
    assert.ok(result.output.endsWith("\n"));
  }
});

test("renders the package version for both aliases", async () => {
  assert.equal(version, packageManifest.version);

  for (const option of ["--version", "-v"]) {
    assert.deepEqual(await execute([option]), {
      exitCode: 0,
      output: `${packageManifest.version}\n`,
      stream: "stdout"
    });
  }
});

test("reports agent-discoverable capabilities", async () => {
  const result = await execute(["capabilities", "--json"]);
  const capabilities = JSON.parse(result.output);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(capabilities, getCapabilities());
  assert.deepEqual(capabilities.inspection, {
    views: ["model", "process", "scope", "element"],
    formats: ["text", "json", "jsonl"],
    profiles: ["zeebe"],
    customExtensions: true,
    metadata: {
      default: "minimal",
      optIn: "--metadata",
      outputFiles: "full"
    },
    paging: {
      defaultPageSize: 25,
      maxPageSize: 100,
      maxStdoutBytes: 32768
    }
  });
  assert.deepEqual(capabilities.tracing, {
    endpointTypes: ["flowNode", "sequenceFlow", "messageFlow"],
    followMessageFlows: "opt-in",
    formats: ["text", "json", "mermaid"],
    limits: {
      defaultElementBudget: 50,
      maxElementBudget: 100,
      maxStdoutBytes: 32768
    },
    metadata: {
      default: "minimal",
      optIn: "--metadata",
      outputFiles: "full"
    },
    modes: ["forward", "backward", "connecting"]
  });
  assert.equal(capabilities.utilities.lint.fallbackConfig, "bpmnlint:correctness");
  assert.equal(capabilities.utilities.diff.includeLayout, "opt-in");
  assert.equal(capabilities.utilities.layout.writes, "in-place-or-output");
  assert.equal(capabilities.bpmn.mutation, true);
  assert.deepEqual(capabilities.editing.operations, [
    "add",
    "remove",
    "replace",
    "move"
  ]);
  assert.deepEqual(capabilities.editing.recipes, ["insert-activity"]);
  assert.match(capabilities.utilities.engines.differ.commit, /^[0-9a-f]{40}$/);
  assert.match(
    capabilities.utilities.engines.autoLayout.commit,
    /^[0-9a-f]{40}$/
  );
  assert.ok(
    packageManifest.dependencies["bpmn-js-differ"]?.endsWith(
      capabilities.utilities.engines.differ.commit
    )
  );
  assert.ok(
    packageManifest.dependencies["bpmn-auto-layout"]?.endsWith(
      capabilities.utilities.engines.autoLayout.commit
    )
  );
  assert.deepEqual(
    capabilities.commands.find(
      (command: { name: string }) => command.name === "capabilities"
    )?.outputFormats,
    ["text", "json"]
  );
  assert.deepEqual(
    capabilities.commands.find(
      (command: { name: string }) => command.name === "trace"
    )?.outputFormats,
    ["text", "json", "mermaid"]
  );
  assert.match((await execute(["capabilities"])).output, /Inspect views:/);
});

test("renders command help through both forms", async () => {
  const capabilities = await execute(["help", "capabilities"]);
  const inspect = await execute(["help", "inspect"]);
  const trace = await execute(["help", "trace"]);
  const lint = await execute(["help", "lint"]);
  const diff = await execute(["help", "diff"]);
  const edit = await execute(["help", "edit"]);
  const layout = await execute(["help", "layout"]);

  assert.match(capabilities.output, /bpmn-cli capabilities \[--json\]/);
  assert.match(inspect.output, /--scope <id>/);
  assert.match(inspect.output, /--extension/);
  assert.match(inspect.output, /--metadata/);
  assert.match(inspect.output, /32 KiB/);
  assert.match(trace.output, /--follow-message-flows/);
  assert.match(trace.output, /32 KiB/);
  assert.match(lint.output, /bpmnlint:correctness/);
  assert.match(diff.output, /--include-layout/);
  assert.match(edit.output, /--apply <plan-hash>/);
  assert.match(edit.output, /--apply-unreviewed/);
  assert.match(edit.output, /insert-activity/);
  assert.match(
    (await execute(["edit", "--recipe", "insert-activity", "--help"])).output,
    /Recipes generate a schema-valid Edit v1 request/
  );
  assert.match(layout.output, /semantic hashes/);

  for (const option of ["--help", "-h"]) {
    assert.match(
      (await execute(["inspect", option])).output,
      /Inspect BPMN business semantics/
    );
  }
});

test("rejects unsupported global arguments", async () => {
  for (const args of [
    ["--version", "extra"],
    ["capabilities", "--yaml"]
  ]) {
    const result = await execute(args);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stream, "stderr");
    assert.match(result.output, /Unknown command or option/);
    assert.match(result.output, /bpmn-cli --help/);
  }
});

test("routes successful and failed output to the correct stream", async () => {
  const { run } = await import("./index.js");
  const stdout: string[] = [];
  const stderr: string[] = [];

  assert.equal(
    await run(
      ["--version"],
      { write: (chunk) => stdout.push(chunk) },
      { write: (chunk) => stderr.push(chunk) }
    ),
    0
  );
  assert.deepEqual(stdout, [`${version}\n`]);
  assert.equal(stderr.length, 0);

  stdout.length = 0;
  assert.equal(
    await run(
      ["unsupported"],
      { write: (chunk) => stdout.push(chunk) },
      { write: (chunk) => stderr.push(chunk) }
    ),
    1
  );
  assert.deepEqual(stdout, []);
  assert.match(stderr[0] ?? "", /Unknown command or option/);
});

test("runs the compiled CLI as a process", () => {
  const inspect = spawnSync(
    process.execPath,
    [entrypoint, "inspect", fixture, "--json"],
    { encoding: "utf8" }
  );

  assert.equal(inspect.status, 0);
  assert.equal(JSON.parse(inspect.stdout).view, "model");
  assert.equal(inspect.stderr, "");

  const invalid = spawnSync(process.execPath, [entrypoint, "unsupported"], {
    encoding: "utf8"
  });

  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Unknown command or option/);
});
