import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BpmnModdle } from "bpmn-moddle";

import {
  classifyProperty,
  descriptorCoverage,
  projectElement,
  semanticHash
} from "./project.js";
import { createSemanticModel } from "./semantic.js";

const require = createRequire(import.meta.url);
const zeebe = require(
  "zeebe-bpmn-moddle/resources/zeebe.json"
) as Record<string, unknown>;
const fixture = fileURLToPath(
  new URL("../test/fixtures/AI Email Support Agent.bpmn", import.meta.url)
);

test("classifies every descriptor property reached in the real fixture", async () => {
  const source = await readFile(fixture);
  const parsed = await new BpmnModdle({ zeebe }).fromXML(source.toString("utf8"));
  const model = createSemanticModel({
    definitions: parsed.rootElement,
    disabledZeebe: false,
    parseWarnings: parsed.warnings,
    profiles: [],
    sourceBytes: source,
    sourcePath: fixture
  });
  const coverage = descriptorCoverage(model.allElements);

  assert.ok(coverage.length > 200);
  assert.ok(
    coverage.every(({ classification }) =>
      ["exclude", "primitive", "reference", "semantic-child"].includes(
        classification
      )
    )
  );

  const adHoc = model.byId.get("Activity_04glkkx");
  assert.ok(adHoc);
  const icon = adHoc.$descriptor.properties.find(
    ({ name }) => name === "modelerTemplateIcon"
  );
  assert.ok(icon);
  assert.equal(classifyProperty(adHoc, icon), "exclude");
  assert.doesNotMatch(
    JSON.stringify(projectElement(adHoc).value),
    /modelerTemplateIcon|data:image/
  );
});

test("normalizes explicit and implicit semantic defaults identically", async () => {
  const createXml = (cancelActivity: string) => `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Default" targetNamespace="https://example.test">
  <bpmn:process id="Process_Default">
    <bpmn:task id="Task_Default" />
    <bpmn:boundaryEvent id="Boundary_Default" attachedToRef="Task_Default"${cancelActivity} />
  </bpmn:process>
</bpmn:definitions>`;
  const implicit = await new BpmnModdle().fromXML(createXml(""));
  const explicit = await new BpmnModdle().fromXML(
    createXml(' cancelActivity="true"')
  );

  assert.equal(
    semanticHash(implicit.rootElement),
    semanticHash(explicit.rootElement)
  );
});

test("normalizes namespace prefix differences", async () => {
  const first = await new BpmnModdle().fromXML(`<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Prefix" targetNamespace="https://example.test">
  <bpmn:process id="Process_Prefix"><bpmn:task id="Task_Prefix" /></bpmn:process>
</bpmn:definitions>`);
  const second = await new BpmnModdle().fromXML(`<?xml version="1.0"?>
<semantic:definitions xmlns:semantic="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Prefix" targetNamespace="https://example.test">
  <semantic:process id="Process_Prefix"><semantic:task id="Task_Prefix" /></semantic:process>
</semantic:definitions>`);

  assert.equal(
    semanticHash(first.rootElement),
    semanticHash(second.rootElement)
  );
});
