import assert from "node:assert/strict";
import { BpmnModdle } from "bpmn-moddle";
import test from "node:test";

import {
  createElement,
  isElementType,
  isSupportedElementType,
  supportedElementTypes,
  type ElementProperties,
  type SupportedElementType
} from "./model-types.js";

const serviceTaskProperties: ElementProperties<"bpmn:ServiceTask"> = {
  retryCounter: "3"
};
const processProperties: ElementProperties<"bpmn:Process"> = {
  modelerTemplate: "example-template"
};
void processProperties;

// @ts-expect-error Zeebe traits extend concrete BPMN elements and are not creatable.
const trait: SupportedElementType = "zeebe:ZeebeServiceTask";
void trait;

test("exposes only constructible descriptor types and merged trait fields", () => {
  const moddle = new BpmnModdle();
  const task = createElement(moddle, "bpmn:ServiceTask", serviceTaskProperties);

  assert.ok(supportedElementTypes.includes("bpmn:ServiceTask"));
  assert.equal(isSupportedElementType("bpmn:ServiceTask"), true);
  assert.equal(isSupportedElementType("zeebe:ZeebeServiceTask"), false);
  assert.equal(isSupportedElementType("missing:Type"), false);
  assert.equal(isElementType(task, "bpmn:ServiceTask"), true);
  assert.equal(isElementType(task, "bpmn:Task"), false);
  assert.equal(task.get("retryCounter"), "3");
});
