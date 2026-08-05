import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeModelProgram } from "./model-program.js";

test("runs a trusted ESM model program in a separate process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-program-"));
  const program = join(directory, "create-model.mjs");
  const output = join(directory, "created.bpmn");

  try {
    await writeFile(
      program,
      `export default async ({ BpmnModel }) => {
  const model = await BpmnModel.create();
  const process = model.process({ name: "Program process" });
  const task = model.create("bpmn:Task", { name: "Program task" });
  model.append(process, task, "flowElements");
  return model.publish({ output: ${JSON.stringify(output)}, layout: "none" });
};`,
      "utf8"
    );

    const result = await executeModelProgram([program, "--json"]);
    const envelope = JSON.parse(result.output);

    assert.equal(result.exitCode, 0);
    assert.equal(envelope.status, "completed");
    assert.equal(envelope.result.status, "written");
    assert.match(await readFile(output, "utf8"), /Program task/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("requires an async default export from a model program", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-program-"));
  const program = join(directory, "invalid.mjs");

  try {
    await writeFile(program, "export const value = 1;", "utf8");
    const result = await executeModelProgram([program, "--json"]);

    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.output).error.code, "PROGRAM_FAILED");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
