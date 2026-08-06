import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { BpmnModdle } from "bpmn-moddle";
import test from "node:test";

import {
  createElement,
  descriptorPropertyClassifications,
  getDescriptorPropertyClassification,
  isElementType,
  isSupportedElementType,
  supportedElementTypes,
  type DescriptorPropertyClassification,
  type ElementProperties,
  type SupportedElementType
} from "./model-types.js";

const require = createRequire(import.meta.url);
const descriptorPaths = [
  require.resolve("bpmn-moddle/resources/bpmn/json/bpmn.json"),
  require.resolve("bpmn-moddle/resources/bpmn/json/bpmndi.json"),
  require.resolve("bpmn-moddle/resources/bpmn/json/dc.json"),
  require.resolve("bpmn-moddle/resources/bpmn/json/di.json"),
  require.resolve("zeebe-bpmn-moddle/resources/zeebe.json")
];

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

test("generates classifications for every bundled descriptor property", async () => {
  const descriptors = await Promise.all(
    descriptorPaths.map(async (path) =>
      JSON.parse(await readFile(path, "utf8")) as {
        prefix: string;
        types: Array<{
          name: string;
          properties?: Array<{ name: string }>;
        }>;
      }
    )
  );
  const classifications = new Set<DescriptorPropertyClassification>([
    "scalar",
    "reference",
    "contained-child",
    "presentation"
  ]);

  for (const descriptor of descriptors) {
    for (const type of descriptor.types) {
      for (const property of type.properties ?? []) {
        const key = `${descriptor.prefix}:${type.name}#${property.name}`;
        const classification = getDescriptorPropertyClassification(
          `${descriptor.prefix}:${type.name}`,
          property.name
        );

        assert.ok(
          Object.hasOwn(descriptorPropertyClassifications, key),
          `missing classification for ${key}`
        );
        assert.ok(classification, `missing classification for ${key}`);
        assert.ok(
          classifications.has(classification),
          `invalid classification for ${key}`
        );
      }
    }
  }

  assert.equal(
    getDescriptorPropertyClassification("bpmn:BaseElement", "id"),
    "scalar"
  );
  assert.equal(
    getDescriptorPropertyClassification("bpmn:SequenceFlow", "sourceRef"),
    "reference"
  );
  assert.equal(
    getDescriptorPropertyClassification("bpmn:Process", "flowElements"),
    "contained-child"
  );
  assert.equal(
    getDescriptorPropertyClassification("bpmn:Definitions", "diagrams"),
    "presentation"
  );
  assert.equal(
    getDescriptorPropertyClassification("bpmndi:BPMNShape", "bpmnElement"),
    "presentation"
  );
  assert.equal(
    getDescriptorPropertyClassification("zeebe:IoMapping", "inputParameters"),
    "contained-child"
  );
  assert.equal(
    getDescriptorPropertyClassification("zeebe:ZeebeServiceTask", "retryCounter"),
    "scalar"
  );
});
