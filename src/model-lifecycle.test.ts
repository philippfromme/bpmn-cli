import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { BpmnModel, ModelApiError } from "./index.js";
import { ModelLoadError } from "./model-loader.js";
import {
  expectModelError,
  withTemporaryDirectory,
  writeBpmn
} from "./test-support.test.js";

test("creates models with configured definitions and collision-safe identifiers", async () => {
  const model = await BpmnModel.create({
    id: "Definitions_Custom",
    targetNamespace: "https://acme.test/bpmn"
  });
  const process = model.process({ id: "Process_Custom", name: "Orders" });
  const first = model.create("bpmn:Task", {});
  const second = model.create("bpmn:Task", {});

  model.append(process, first, "flowElements");
  assert.equal(model.element("Definitions_Custom").type, "bpmn:Definitions");
  assert.equal(model.element("Process_Custom").name, "Orders");
  assert.equal(first.id, "Task_1");
  assert.equal(second.id, "Task_2");
  expectModelError("ELEMENT_ID_CONFLICT", () =>
    model.create("bpmn:Task", { id: "Task_1" })
  );
});

test("requires an explicit destination when publishing an in-memory model", async () => {
  const model = await BpmnModel.create();
  model.process();

  await assert.rejects(
    model.publish(),
    (error: unknown) =>
      error instanceof ModelApiError && error.code === "OUTPUT_REQUIRED"
  );
});

test("loads exact IDs and reports source errors with stable codes", async () => {
  await withTemporaryDirectory("bpmn-model-lifecycle", async (directory) => {
    const source = await writeBpmn(
      directory,
      "model.bpmn",
      '  <bpmn:process id="Process_1"><bpmn:task id="Task_1" name="Review"/></bpmn:process>'
    );
    const model = await BpmnModel.open(source);

    assert.equal(model.element("Task_1").name, "Review");
    expectModelError("ELEMENT_NOT_FOUND", () => model.element("task_1"));

    await assert.rejects(
      BpmnModel.open(join(directory, "missing.bpmn")),
      (error: unknown) =>
        error instanceof ModelLoadError && error.code === "SOURCE_READ_FAILED"
    );

    const invalidEncoding = join(directory, "invalid-encoding.bpmn");
    await writeFile(invalidEncoding, Buffer.from([0xff, 0xfe, 0xfd]));
    await assert.rejects(
      BpmnModel.open(invalidEncoding),
      (error: unknown) =>
        error instanceof ModelLoadError && error.code === "SOURCE_DECODE_FAILED"
    );
  });
});

test("keeps ID reservations after attachment, removal, and index refreshes", async () => {
  const model = await BpmnModel.create();
  const process = model.process();
  const first = model.create("bpmn:Task", {});
  model.append(process, first, "flowElements");
  model.remove(first);

  const second = model.create("bpmn:Task", {});
  assert.equal(first.id, "Task_1");
  assert.equal(second.id, "Task_2");
  expectModelError("ELEMENT_NOT_FOUND", () => model.element("Task_1"));
});

test("rejects invalid or ambiguous containment without changing either parent", async () => {
  const model = await BpmnModel.create();
  const first = model.process({ id: "Process_First" });
  const second = model.process({ id: "Process_Second" });
  const task = model.create("bpmn:Task", {});
  model.append(first, task, "flowElements");

  expectModelError("INVALID_CONTAINMENT", () =>
    model.append(first, task, "flowElements")
  );
  expectModelError("INVALID_CONTAINMENT", () =>
    model.append(second, task, "flowElements")
  );
  expectModelError("INVALID_CONTAINMENT", () =>
    model.append(first, task, "lanes")
  );

  assert.deepEqual(first.raw.flowElements, [task.raw]);
  assert.deepEqual(second.raw.flowElements, []);
  assert.equal(task.raw.$parent, first.raw);
});

test("preserves explicit target namespace through publication", async () => {
  await withTemporaryDirectory("bpmn-target-namespace", async (directory) => {
    const output = join(directory, "model.bpmn");
    const model = await BpmnModel.create({
      targetNamespace: "https://acme.test/processes"
    });
    model.process();
    await model.publish({ layout: "none", output });

    assert.match(
      await readFile(output, "utf8"),
      /targetNamespace="https:\/\/acme\.test\/processes"/
    );
  });
});
