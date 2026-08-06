import assert from "node:assert/strict";
import test from "node:test";

import { BpmnEditor } from "./index.js";
import { expectModelError, moddleElements } from "./test-support.test.js";

async function connectedModel() {
  const model = await BpmnEditor.create();
  const process = model.process();
  const first = model.create("bpmn:Task", { name: "First" });
  const second = model.create("bpmn:Task", { name: "Second" });
  model.append(process, first, "flowElements");
  model.append(process, second, "flowElements");
  return { first, model, process, second };
}

test("connects, rewires, and removes flows while preserving reciprocal references", async () => {
  const { first, model, process, second } = await connectedModel();
  const third = model.create("bpmn:Task", { name: "Third" });
  model.append(process, third, "flowElements");
  const flow = model.connect(first, second, { name: "initial" });

  assert.equal(flow.type, "bpmn:SequenceFlow");
  assert.equal(flow.raw.get("sourceRef"), first.raw);
  assert.equal(flow.raw.get("targetRef"), second.raw);
  assert.deepEqual(moddleElements(first.raw.get("outgoing")), [flow.raw]);
  assert.deepEqual(moddleElements(second.raw.get("incoming")), [flow.raw]);

  model.rewire(flow, { source: third, target: first });
  assert.deepEqual(moddleElements(first.raw.get("incoming")), [flow.raw]);
  assert.deepEqual(moddleElements(first.raw.get("outgoing")), []);
  assert.deepEqual(moddleElements(second.raw.get("incoming")), []);
  assert.deepEqual(moddleElements(third.raw.get("outgoing")), [flow.raw]);

  model.remove(flow.id);
  assert.deepEqual(moddleElements(first.raw.get("incoming")), []);
  assert.deepEqual(moddleElements(third.raw.get("outgoing")), []);
  assert.equal(moddleElements(process.raw.get("flowElements")).includes(flow.raw), false);
});

test("rejects invalid flow endpoints before creating a SequenceFlow", async () => {
  const { first, model, process, second } = await connectedModel();
  const nested = model.create("bpmn:SubProcess", {});
  const nestedTask = model.create("bpmn:Task", {});
  model.append(process, nested, "flowElements");
  model.append(nested, nestedTask, "flowElements");
  const flow = model.connect(first, second);
  const count = moddleElements(process.raw.get("flowElements")).length;

  expectModelError("INVALID_CONNECTION", () => model.connect(first, nestedTask));
  expectModelError("INVALID_CONNECTION", () => model.connect(flow, first));
  expectModelError("INVALID_CONNECTION", () =>
    model.rewire(flow, { target: nestedTask })
  );

  assert.equal(moddleElements(process.raw.get("flowElements")).length, count);
  assert.equal(flow.raw.get("sourceRef"), first.raw);
  assert.equal(flow.raw.get("targetRef"), second.raw);
});

test("rejects referenced element removal and cross-model raw elements", async () => {
  const { first, model, second } = await connectedModel();
  const flow = model.connect(first, second);
  const foreignModel = await BpmnEditor.create();
  const foreignProcess = foreignModel.process();
  const foreignTask = foreignModel.create("bpmn:Task", {});
  foreignModel.append(foreignProcess, foreignTask, "flowElements");

  expectModelError("ELEMENT_REFERENCED", () => model.remove(first));
  expectModelError("FOREIGN_ELEMENT", () =>
    model.append(foreignProcess.raw, first.raw, "flowElements")
  );
  expectModelError("FOREIGN_ELEMENT", () =>
    model.append(model.process().raw, foreignTask.raw, "flowElements")
  );

  assert.equal(flow.raw.get("sourceRef"), first.raw);
  assert.deepEqual(
    moddleElements(foreignProcess.raw.get("flowElements")),
    [foreignTask.raw]
  );
});
