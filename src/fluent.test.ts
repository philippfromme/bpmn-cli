import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { Bpmn, ProcessBuilderError } from "./index.js";
import {
  isModdleElement,
  moddleElements,
  withTemporaryDirectory
} from "./test-support.test.js";

test("builds and publishes a branched Zeebe process", async () => {
  await withTemporaryDirectory("bpmn-process-builder", async (directory) => {
    const output = join(directory, "approval-flow.bpmn");
    const process = await Bpmn.createProcess("approval-flow", {
      name: "Approval flow"
    });

    const model = process
      .startEvent("start", { name: "Request Submitted" })
      .userTask("review", { name: "Review Request" })
      .exclusiveGateway("gw", { name: "Approved?" })
      .branch("yes", (branch) =>
        branch
          .condition("= approved")
          .serviceTask("notify", {
            name: "Notify requester",
            taskType: "send-email"
          })
          .endEvent("done")
      )
      .branch("no", (branch) =>
        branch.defaultFlow().endEvent("rejected")
      )
      .build();

    const publication = await process.publish({ output });
    const gateway = model.element<"bpmn:ExclusiveGateway">("gw");
    const defaultFlow = gateway.raw.get("default");
    const yesFlow = moddleElements(gateway.raw.get("outgoing")).find(
      (flow) => {
        const target = flow.get("targetRef");
        return isModdleElement(target) && target.id === "notify";
      }
    );
    const extensionElements = model.element("notify").raw.get("extensionElements");
    assert.ok(isModdleElement(extensionElements));
    const taskDefinition = moddleElements(extensionElements.get("values")).find(
      (element) => element.$type === "zeebe:TaskDefinition"
    );

    assert.equal(publication.status, "written");
    assert.equal(model.element("approval-flow").name, "Approval flow");
    assert.equal(model.element("approval-flow").raw.get("isExecutable"), true);
    assert.equal(yesFlow?.get("sourceRef"), gateway.raw);
    const condition = yesFlow?.get("conditionExpression");
    assert.ok(isModdleElement(condition));
    assert.equal(condition.get("body"), "= approved");
    assert.ok(isModdleElement(defaultFlow));
    const defaultTarget = defaultFlow.get("targetRef");
    assert.ok(isModdleElement(defaultTarget));
    assert.equal(defaultTarget.id, "rejected");
    assert.equal(taskDefinition?.get("type"), "send-email");
    assert.match(await readFile(output, "utf8"), /bpmndi:BPMNDiagram/);
  });
});

test("rejects incomplete and ambiguous branch declarations", async () => {
  const process = await Bpmn.createProcess("approval-flow");

  process.startEvent("start").exclusiveGateway("gw");

  assert.throws(
    () => process.branch("invalid", (branch) => branch.endEvent("end")),
    (error: unknown) =>
      error instanceof ProcessBuilderError &&
      error.code === "BRANCH_START_REQUIRED"
  );
  process.branch("first-default", (branch) => branch.defaultFlow().endEvent("first"));
  assert.throws(
    () => process.branch("second-default", (branch) => branch.defaultFlow().endEvent("second")),
    (error: unknown) =>
      error instanceof ProcessBuilderError &&
      error.code === "DUPLICATE_DEFAULT_BRANCH"
  );
  assert.throws(
    () => process.branch("empty-condition", (branch) => branch.condition(" ")),
    (error: unknown) =>
      error instanceof ProcessBuilderError &&
      error.code === "EMPTY_CONDITION"
  );

  const unfinished = await Bpmn.createProcess("unfinished");
  unfinished.startEvent("start").exclusiveGateway("gw");
  assert.throws(
    () => unfinished.branch("yes", (branch) => branch.condition("= approved")),
    (error: unknown) =>
      error instanceof ProcessBuilderError &&
      error.code === "UNFINISHED_BRANCH"
  );
});
