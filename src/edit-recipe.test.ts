import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeEditRecipe } from "./edit-recipe.js";

const sourceXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  id="Definitions_1" targetNamespace="https://example.com/edit-recipe">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="Start_1" />
    <bpmn:serviceTask id="Task_1" name="Fetch customer history" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />
  </bpmn:process>
</bpmn:definitions>
`;

test("generates a native Zeebe user-task insertion request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-edit-recipe-"));
  const source = join(directory, "source.bpmn");

  try {
    await writeFile(source, sourceXml);
    const result = await executeEditRecipe([
      source,
      "--recipe",
      "insert-activity",
      "--flow",
      "Flow_1",
      "--type",
      "zeebe:userTask",
      "--name",
      "Verify customer identity",
      "--form-id",
      "verify-customer-identity",
      "--json"
    ]);
    const request = JSON.parse(result.output) as {
      operations: Array<Record<string, unknown>>;
      schemaVersion: string;
    };

    assert.equal(result.exitCode, 0, result.output);
    assert.equal(request.schemaVersion, "1");
    assert.equal(request.operations.length, 3);
    assert.deepEqual(request.operations[0], {
      op: "add",
      target: "Process_1",
      path: "/flowElements/-",
      value: {
        $type: "bpmn:UserTask",
        name: "Verify customer identity",
        extensionElements: {
          $type: "bpmn:ExtensionElements",
          values: [
            { $type: "zeebe:UserTask" },
            {
              $type: "zeebe:FormDefinition",
              formId: "verify-customer-identity"
            }
          ]
        }
      },
      as: "$insertedActivity",
      expect: [{ target: "Process_1", path: "/flowElements", length: 3 }]
    });
    assert.deepEqual(request.operations[1], {
      op: "replace",
      target: "Flow_1",
      path: "/targetRef",
      value: "$insertedActivity",
      expect: [{ target: "Flow_1", path: "/targetRef", equals: "Task_1" }]
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects a non-SequenceFlow insertion target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-edit-recipe-"));
  const source = join(directory, "source.bpmn");

  try {
    await writeFile(source, sourceXml);
    const result = await executeEditRecipe([
      source,
      "--recipe",
      "insert-activity",
      "--flow",
      "Task_1",
      "--type",
      "bpmn:Task",
      "--name",
      "Review",
      "--json"
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.output).error.code, "EDIT_RECIPE_FLOW_INVALID");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});