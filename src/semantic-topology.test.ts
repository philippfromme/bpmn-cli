import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BpmnModel } from "./index.js";
import { loadSemanticModel } from "./model-loader.js";
import { withTemporaryDirectory } from "./test-support.test.js";

const fixture = fileURLToPath(
  new URL("../test/fixtures/collaboration-nested.bpmn", import.meta.url)
);

test("loads collaborations, message flows, nested scopes, gateways, and boundary handlers", async () => {
  const model = await loadSemanticModel({
    autoProfile: true,
    extensions: [],
    file: fixture
  });
  const types = model.allElements.map((element) => element.$type);

  for (const id of [
    "Collaboration_1",
    "MessageFlow_Request",
    "SubProcess_Handle",
    "Task_Review",
    "Boundary_Timeout",
    "Timer_Timeout",
    "Gateway_Resolved"
  ]) {
    assert.ok(model.byId.has(id), `${id} must be addressable`);
  }
  assert.ok(types.includes("bpmn:Collaboration"));
  assert.ok(types.includes("bpmn:MessageFlow"));
  assert.ok(types.includes("bpmn:SubProcess"));
  assert.ok(types.includes("bpmn:BoundaryEvent"));
  assert.ok(types.includes("bpmn:ExclusiveGateway"));
  assert.deepEqual(model.diagnostics, []);
});

test("round-trips a complex collaboration without altering business semantics", async () => {
  await withTemporaryDirectory("bpmn-collaboration-roundtrip", async (directory) => {
    const original = await loadSemanticModel({
      autoProfile: true,
      extensions: [],
      file: fixture
    });
    const fluent = await BpmnModel.open(fixture);
    const temporary = join(directory, "roundtrip.bpmn");
    const publication = await fluent.publish({
      layout: "none",
      output: temporary
    });
    const roundTripped = await loadSemanticModel({
      autoProfile: true,
      extensions: [],
      file: temporary
    });

    assert.equal(publication.semanticHash, original.semanticHash);
    assert.equal(roundTripped.semanticHash, original.semanticHash);
    assert.equal(
      (await readFile(temporary, "utf8")).includes("bpmndi:BPMNDiagram"),
      false
    );
  });
});
