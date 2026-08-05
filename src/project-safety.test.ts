import assert from "node:assert/strict";
import test from "node:test";

import { BpmnModdle } from "bpmn-moddle";

import { projectElement, semanticHash } from "./project.js";

test("reports unresolved references without leaking moddle internals", () => {
  const moddle = new BpmnModdle();
  const task = moddle.create("bpmn:Task", {});
  const boundary = moddle.create("bpmn:BoundaryEvent", {
    attachedToRef: task,
    id: "Boundary_1"
  });

  const projected = projectElement(boundary);
  assert.deepEqual(projected.value.attachedToRef, null);
  assert.deepEqual(projected.diagnostics, [{
    code: "UNRESOLVED_REFERENCE",
    elementRef: "Boundary_1",
    message: 'Reference "attachedToRef" points to an element without an ID',
    property: "attachedToRef",
    severity: "warning"
  }]);
  assert.doesNotMatch(JSON.stringify(projected.value), /\$descriptor|\$model|\$parent/);
});

test("preserves unknown attributes in projection but marks them unsafe to publish", () => {
  const moddle = new BpmnModdle();
  const task = moddle.create("bpmn:Task", {
    "acme:priority": "high",
    id: "Task_1"
  });

  const projected = projectElement(task);
  assert.equal(projected.value["acme:priority"], "high");
  assert.equal(projected.diagnostics[0]?.code, "UNSUPPORTED_EXTENSION_DATA");
  assert.match(projected.diagnostics[0]?.message ?? "", /acme:priority/);
});

test("hashing ignores exporter metadata but retains business-semantic changes", () => {
  const moddle = new BpmnModdle();
  const first = moddle.create("bpmn:Definitions", {
    id: "Definitions_1",
    exporter: "Modeler A",
    targetNamespace: "https://example.test"
  });
  const second = moddle.create("bpmn:Definitions", {
    id: "Definitions_1",
    exporter: "Modeler B",
    targetNamespace: "https://example.test"
  });
  const changed = moddle.create("bpmn:Definitions", {
    id: "Definitions_1",
    targetNamespace: "https://other.example.test"
  });

  assert.equal(semanticHash(first), semanticHash(second));
  assert.notEqual(semanticHash(first), semanticHash(changed));
});
