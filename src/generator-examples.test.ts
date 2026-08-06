import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import test from "node:test";

import { BpmnEditor } from "./index.js";
import { loadSemanticModel } from "./model-loader.js";
import { isModdleElement, moddleElements } from "./test-support.test.js";

const execFile = promisify(execFileCallback);
const acceptanceDirectory = join(process.cwd(), ".generator-acceptance");
const maxScriptBytes = 2_500;
const maxExecutionMilliseconds = 5_000;

interface GeneratorExample {
  name: string;
  assertSemantics(model: BpmnEditor): void;
}

function serviceTaskType(model: BpmnEditor, id: string): string | undefined {
  const extensions = model.element(id).raw.get("extensionElements");
  if (!isModdleElement(extensions)) return undefined;
  const definition = moddleElements(extensions.get("values")).find(
    (element) => element.$type === "zeebe:TaskDefinition"
  );
  const taskType = definition?.get("type");
  return typeof taskType === "string" ? taskType : undefined;
}

function hasBoundaryReference(model: BpmnEditor, activityId: string, boundaryId: string): boolean {
  return moddleElements(model.element(activityId).raw.get("boundaryEventRefs")).some(
    (boundary) => boundary.id === boundaryId
  );
}

const examples: readonly GeneratorExample[] = [
  {
    name: "straight-through-service-flow",
    assertSemantics(model) {
      assert.equal(model.element("Process_order_fulfilment").raw.get("isExecutable"), true);
      assert.equal(serviceTaskType(model, "Task_validate_order"), "validate-order");
      assert.equal(serviceTaskType(model, "Task_fulfil_order"), "fulfil-order");
      assert.equal(model.element("End_order_fulfilled").type, "bpmn:EndEvent");
    }
  },
  {
    name: "human-workflow",
    assertSemantics(model) {
      assert.equal(model.element("Task_manager_review").type, "bpmn:UserTask");
      const form = model.element("Task_manager_review")
        .child("extensionElements")
        .children<"zeebe:FormDefinition">("values")[0];
      assert.equal(form?.raw.get("formId"), "leave-request-review");
      assert.equal(serviceTaskType(model, "Task_confirm_leave"), "confirm-leave");
      assert.equal(model.element("End_leave_rejected").type, "bpmn:EndEvent");
    }
  },
  {
    name: "exception-timeout-handling",
    assertSemantics(model) {
      assert.equal(model.element("Boundary_payment_timeout").raw.get("cancelActivity"), false);
      assert.equal(
        model.element("Boundary_payment_failed").raw.get("attachedToRef"),
        model.element("Task_charge_card").raw
      );
      assert.ok(hasBoundaryReference(model, "Task_charge_card", "Boundary_payment_timeout"));
      assert.ok(hasBoundaryReference(model, "Task_charge_card", "Boundary_payment_failed"));
      assert.equal(model.element("Error_payment_failed").raw.get("errorCode"), "PAYMENT_FAILED");
      assert.equal(serviceTaskType(model, "Task_notify_failure"), "notify-payment-failure");
    }
  },
  {
    name: "collaboration",
    assertSemantics(model) {
      const buyer = model.element("Participant_buyer").raw;
      const flow = model.element("MessageFlow_order_request").raw;
      assert.equal(buyer.get("processRef"), model.element("Process_buyer").raw);
      assert.equal(flow.get("sourceRef"), buyer);
      assert.equal(flow.get("targetRef"), model.element("Participant_seller").raw);
      assert.equal(flow.get("messageRef"), model.element("Message_order_request").raw);
    }
  },
  {
    name: "multi-instance-work",
    assertSemantics(model) {
      const loop = model.element("Task_dispatch_item")
        .child<"bpmn:MultiInstanceLoopCharacteristics">("loopCharacteristics");
      assert.equal(loop.raw.get("isSequential"), false);
      assert.equal(loop.child("loopCardinality").raw.get("body"), "= items");
      assert.equal(loop.child("completionCondition").raw.get("body"), "= dispatched >= required");
      assert.equal(serviceTaskType(model, "Task_dispatch_item"), "dispatch-item");
    }
  }
];

test("generator examples meet repeatable local acceptance metrics", async () => {
  await rm(acceptanceDirectory, { force: true, recursive: true });
  await mkdir(acceptanceDirectory);

  try {
    for (const example of examples) {
      const script = join(process.cwd(), "examples", `${example.name}.mjs`);
      const output = join(acceptanceDirectory, `${example.name}.bpmn`);
      const scriptSize = (await stat(script)).size;
      const started = performance.now();
      const execution = await execFile(process.execPath, [script, output], {
        cwd: process.cwd()
      });
      const executionMilliseconds = performance.now() - started;
      const result = JSON.parse(execution.stdout) as {
        semanticHash: string;
        status: string;
      };
      const outputXml = await readFile(output, "utf8");
      const reloaded = await BpmnEditor.open(output);
      const localCamundaModel = await loadSemanticModel({
        autoProfile: true,
        extensions: [],
        file: output
      });

      assert.ok(
        scriptSize <= maxScriptBytes,
        `${example.name} script is ${scriptSize} bytes; limit is ${maxScriptBytes}`
      );
      assert.ok(
        executionMilliseconds <= maxExecutionMilliseconds,
        `${example.name} took ${executionMilliseconds.toFixed(0)} ms; limit is ${maxExecutionMilliseconds} ms`
      );
      assert.equal(result.status, "written");
      assert.equal(localCamundaModel.semanticHash, result.semanticHash);
      assert.match(result.semanticHash, /^[a-f0-9]{64}$/);
      assert.match(outputXml, /<bpmn:definitions\b/);
      assert.deepEqual(
        localCamundaModel.diagnostics.filter(
          (diagnostic) =>
            diagnostic.code === "BPMN_PARSE_WARNING" ||
            diagnostic.code === "UNRESOLVED_REFERENCE" ||
            diagnostic.code === "UNSUPPORTED_EXTENSION_DATA"
        ),
        [],
        `${basename(output)} must pass the local Camunda BPMN and Zeebe descriptor gate`
      );
      example.assertSemantics(reloaded);
    }
  } finally {
    await rm(acceptanceDirectory, { force: true, recursive: true });
  }
});
