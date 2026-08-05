import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { BpmnModel, ModelPublicationError } from "./index.js";
import { withTemporaryDirectory, writeBpmn } from "./test-support.test.js";

test("reports added and changed semantic elements after verified publication", async () => {
  await withTemporaryDirectory("bpmn-publication-changes", async (directory) => {
    const source = await writeBpmn(
      directory,
      "source.bpmn",
      '  <bpmn:process id="Process_1"><bpmn:task id="Task_1" name="Before"/></bpmn:process>'
    );
    const output = join(directory, "output.bpmn");
    const model = await BpmnModel.open(source);
    const process = model.element("Process_1");
    model.element("Task_1").setName("After");
    const added = model.create("bpmn:EndEvent", {});
    model.append(process, added, "flowElements");

    const publication = await model.publish({ layout: "none", output });
    const addedChanges = publication.changes.added;
    const changedChanges = publication.changes.changed;

    assert.ok(Array.isArray(addedChanges));
    assert.ok(Array.isArray(changedChanges));
    assert.equal(addedChanges.length, 1);
    assert.match(JSON.stringify(addedChanges), /EndEvent_1/);
    assert.match(JSON.stringify(changedChanges), /Task_1/);
    assert.match(JSON.stringify(changedChanges), /Process_1/);
    assert.equal(publication.destination, output);
    assert.equal(publication.layout, "none");
    assert.equal(publication.status, "written");
    assert.match(publication.outputSha256, /^[a-f0-9]{64}$/);
    assert.match(publication.semanticHash, /^[a-f0-9]{64}$/);
    assert.equal((await BpmnModel.open(output)).element(added.id).type, "bpmn:EndEvent");
  });
});

test("replaces an opened source only when no output is requested", async () => {
  await withTemporaryDirectory("bpmn-publication-replace", async (directory) => {
    const source = await writeBpmn(
      directory,
      "source.bpmn",
      '  <bpmn:process id="Process_1"><bpmn:task id="Task_1" name="Before"/></bpmn:process>'
    );
    const model = await BpmnModel.open(source);
    model.element("Task_1").setName("After");

    const publication = await model.publish({ layout: "none", validate: false });
    assert.equal(publication.destination, source);
    assert.match(await readFile(source, "utf8"), /name="After"/);
  });
});

test("protects existing outputs, permits explicit replacement, and rejects source aliases", async () => {
  await withTemporaryDirectory("bpmn-publication-output", async (directory) => {
    const source = await writeBpmn(
      directory,
      "source.bpmn",
      '  <bpmn:process id="Process_1"><bpmn:task id="Task_1"/></bpmn:process>'
    );
    const output = join(directory, "output.bpmn");
    await writeFile(output, "existing", "utf8");
    const model = await BpmnModel.open(source);

    await assert.rejects(
      model.publish({ layout: "none", output }),
      (error: unknown) =>
        error instanceof ModelPublicationError && error.code === "OUTPUT_WRITE_FAILED"
    );
    assert.equal(await readFile(output, "utf8"), "existing");

    await model.publish({ force: true, layout: "none", output });
    assert.match(await readFile(output, "utf8"), /bpmn:definitions/);

    await assert.rejects(
      model.publish({ force: true, layout: "none", output: source }),
      (error: unknown) =>
        error instanceof ModelPublicationError && error.code === "OUTPUT_WRITE_FAILED"
    );
    assert.match(await readFile(source, "utf8"), /bpmn:definitions/);
  });
});

test("produces deterministic results for equivalent model programs", async () => {
  await withTemporaryDirectory("bpmn-publication-determinism", async (directory) => {
    const firstOutput = join(directory, "first.bpmn");
    const secondOutput = join(directory, "second.bpmn");
    const first = await BpmnModel.create();
    const second = await BpmnModel.create();

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
      first.publish({ layout: "auto", output: firstOutput }),
      second.publish({ layout: "auto", output: secondOutput })
    ]);

    assert.equal(firstResult.outputSha256, secondResult.outputSha256);
    assert.equal(firstResult.semanticHash, secondResult.semanticHash);
    assert.equal(await readFile(firstOutput, "utf8"), await readFile(secondOutput, "utf8"));
  });
});
