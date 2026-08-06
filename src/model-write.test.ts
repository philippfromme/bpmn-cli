import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { BpmnEditor, ModelWriteError } from "./index.js";
import { withTemporaryDirectory, writeBpmn } from "./test-support.test.js";

test("reports added and changed semantic elements after verified write", async () => {
  await withTemporaryDirectory("bpmn-write-changes", async (directory) => {
    const source = await writeBpmn(
      directory,
      "source.bpmn",
      '  <bpmn:process id="Process_1"><bpmn:task id="Task_1" name="Before"/></bpmn:process>'
    );
    const output = join(directory, "output.bpmn");
    const model = await BpmnEditor.open(source);
    const process = model.element("Process_1");
    model.element("Task_1").setName("After");
    const added = model.create("bpmn:EndEvent", {});
    model.append(process, added, "flowElements");

    const result = await model.write({ layout: "none", output });
    const addedChanges = result.changes.added;
    const changedChanges = result.changes.changed;

    assert.ok(Array.isArray(addedChanges));
    assert.ok(Array.isArray(changedChanges));
    assert.equal(addedChanges.length, 1);
    assert.match(JSON.stringify(addedChanges), /EndEvent_1/);
    assert.match(JSON.stringify(changedChanges), /Task_1/);
    assert.match(JSON.stringify(changedChanges), /Process_1/);
    assert.equal(result.destination, output);
    assert.equal(result.layout, "none");
    assert.equal(result.status, "written");
    assert.match(result.outputSha256, /^[a-f0-9]{64}$/);
    assert.match(result.semanticHash, /^[a-f0-9]{64}$/);
    assert.equal((await BpmnEditor.open(output)).element(added.id).type, "bpmn:EndEvent");
  });
});

test("replaces an opened source only when no output is requested", async () => {
  await withTemporaryDirectory("bpmn-write-replace", async (directory) => {
    const source = await writeBpmn(
      directory,
      "source.bpmn",
      '  <bpmn:process id="Process_1"><bpmn:task id="Task_1" name="Before"/></bpmn:process>'
    );
    const model = await BpmnEditor.open(source);
    model.element("Task_1").setName("After");

    const result = await model.write({ layout: "none", validate: false });
    assert.equal(result.destination, source);
    assert.match(await readFile(source, "utf8"), /name="After"/);
  });
});

test("protects existing outputs, permits explicit replacement, and rejects source aliases", async () => {
  await withTemporaryDirectory("bpmn-write-output", async (directory) => {
    const source = await writeBpmn(
      directory,
      "source.bpmn",
      '  <bpmn:process id="Process_1"><bpmn:task id="Task_1"/></bpmn:process>'
    );
    const output = join(directory, "output.bpmn");
    await writeFile(output, "existing", "utf8");
    const model = await BpmnEditor.open(source);

    await assert.rejects(
      model.write({ layout: "none", output }),
      (error: unknown) =>
        error instanceof ModelWriteError && error.code === "OUTPUT_WRITE_FAILED"
    );
    assert.equal(await readFile(output, "utf8"), "existing");

    await model.write({ force: true, layout: "none", output });
    assert.match(await readFile(output, "utf8"), /bpmn:definitions/);

    await assert.rejects(
      model.write({ force: true, layout: "none", output: source }),
      (error: unknown) =>
        error instanceof ModelWriteError && error.code === "OUTPUT_WRITE_FAILED"
    );
    assert.match(await readFile(source, "utf8"), /bpmn:definitions/);
  });
});

test("produces deterministic results for equivalent model programs", async () => {
  await withTemporaryDirectory("bpmn-write-determinism", async (directory) => {
    const firstOutput = join(directory, "first.bpmn");
    const secondOutput = join(directory, "second.bpmn");
    const first = await BpmnEditor.create();
    const second = await BpmnEditor.create();

    for (const model of [first, second]) {
      const process = model.process();
      const start = model.create("bpmn:StartEvent", {});
      const task = model.create("bpmn:Task", { name: "Review" });
      const end = model.create("bpmn:EndEvent", {});
      model.append(process, start, "flowElements");
      model.append(process, task, "flowElements");
      model.append(process, end, "flowElements");
      model.connect(start, task);
      model.connect(task, end);
    }

    const [firstResult, secondResult] = await Promise.all([
      first.write({ layout: "auto", output: firstOutput }),
      second.write({ layout: "auto", output: secondOutput })
    ]);

    assert.equal(firstResult.outputSha256, secondResult.outputSha256);
    assert.equal(firstResult.semanticHash, secondResult.semanticHash);
    assert.equal(await readFile(firstOutput, "utf8"), await readFile(secondOutput, "utf8"));
  });
});
