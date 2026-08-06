import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { Bpmn, BpmnModel, ModelApiError, ProcessBuilderError } from "./index.js";
import {
  isModdleElement,
  moddleElements,
  withTemporaryDirectory
} from "./test-support.test.js";

test("builds, publishes, and reloads a collaboration with exact ID references", async () => {
  await withTemporaryDirectory("bpmn-collaboration-builder", async (directory) => {
    const output = join(directory, "order-collaboration.bpmn");
    const collaboration = await Bpmn.createCollaboration("Collaboration_order", {
      name: "Order collaboration"
    });
    const model = collaboration
      .process("Process_buyer", { isExecutable: true, name: "Buyer process" })
      .process("Process_seller", { name: "Seller process" })
      .participant("Participant_buyer", {
        name: "Buyer",
        processId: "Process_buyer"
      })
      .participant("Participant_seller", {
        name: "Seller",
        processId: "Process_seller"
      })
      .message("Message_order", { name: "Order request" })
      .messageFlow("MessageFlow_order", {
        messageId: "Message_order",
        name: "Send order",
        sourceId: "Participant_buyer",
        targetId: "Participant_seller"
      })
      .build();

    const publication = await collaboration.publish({ layout: "none", output });
    const buyer = model.element<"bpmn:Participant">("Participant_buyer");
    const flow = model.element<"bpmn:MessageFlow">("MessageFlow_order");
    const reopened = await BpmnModel.open(output);

    assert.equal(publication.status, "written");
    assert.equal(model.element("Collaboration_order").name, "Order collaboration");
    assert.equal(buyer.raw.get("processRef"), model.element("Process_buyer").raw);
    assert.equal(flow.raw.get("sourceRef"), buyer.raw);
    assert.equal(
      flow.raw.get("targetRef"),
      model.element("Participant_seller").raw
    );
    assert.equal(flow.raw.get("messageRef"), model.element("Message_order").raw);
    assert.equal(
      reopened.element("MessageFlow_order").raw.get("sourceRef"),
      reopened.element("Participant_buyer").raw
    );
    assert.equal(
      reopened.element("MessageFlow_order").raw.get("messageRef"),
      reopened.element("Message_order").raw
    );
  });
});

test("rejects missing and mistyped collaboration reference IDs before mutation", async () => {
  const collaboration = await Bpmn.createCollaboration("Collaboration_order");
  const builder = collaboration
    .process("Process_order")
    .participant("Participant_buyer", { processId: "Process_order" })
    .message("Message_order");

  assert.throws(
    () => builder.participant("Participant_missing", { processId: "missing" }),
    (error: unknown) =>
      error instanceof ModelApiError && error.code === "ELEMENT_NOT_FOUND"
  );
  assert.throws(
    () => builder.participant("Participant_wrong", { processId: "Message_order" }),
    (error: unknown) =>
      error instanceof ModelApiError && error.code === "INVALID_PROPERTY"
  );
  assert.throws(
    () => builder.messageFlow("MessageFlow_missing", {
      sourceId: "Participant_buyer",
      targetId: "missing"
    }),
    (error: unknown) =>
      error instanceof ModelApiError && error.code === "ELEMENT_NOT_FOUND"
  );
  assert.throws(
    () => builder.messageFlow("MessageFlow_wrong", {
      messageId: "Participant_buyer",
      sourceId: "Participant_buyer",
      targetId: "Participant_buyer"
    }),
    (error: unknown) =>
      error instanceof ModelApiError && error.code === "INVALID_CONNECTION"
  );
  assert.throws(
    () => builder.messageFlow("MessageFlow_invalid_endpoint", {
      sourceId: "Process_order",
      targetId: "Participant_buyer"
    }),
    (error: unknown) =>
      error instanceof ModelApiError && error.code === "INVALID_CONNECTION"
  );

  const model = builder.build();
  const foreignModel = await BpmnModel.create();
  const foreignCollaboration = foreignModel.rootElement("bpmn:Collaboration", {
    id: "Collaboration_foreign"
  });
  const foreignParticipant = foreignModel.create("bpmn:Participant", {
    id: "Participant_foreign"
  });
  foreignModel.append(foreignCollaboration, foreignParticipant, "participants");

  assert.throws(
    () => model.messageFlow(
      "Collaboration_order",
      foreignParticipant,
      "Participant_buyer",
      { id: "MessageFlow_foreign" }
    ),
    (error: unknown) =>
      error instanceof ModelApiError && error.code === "FOREIGN_ELEMENT"
  );
  assert.throws(
    () => model.element("Participant_missing"),
    (error: unknown) =>
      error instanceof ModelApiError && error.code === "ELEMENT_NOT_FOUND"
  );
  assert.throws(
    () => model.element("MessageFlow_missing"),
    (error: unknown) =>
      error instanceof ModelApiError && error.code === "ELEMENT_NOT_FOUND"
  );
  assert.throws(
    () => model.element("MessageFlow_invalid_endpoint"),
    (error: unknown) =>
      error instanceof ModelApiError && error.code === "ELEMENT_NOT_FOUND"
  );
});

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
            taskType: "send-email",
            retries: "3",
            inputs: [{ source: "=requester.email", target: "email" }],
            outputs: [{ source: "=response.id", target: "messageId" }],
            headers: { priority: "high" },
            properties: { connector: "email" }
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
    assert.equal(taskDefinition?.get("retries"), "3");
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

test("adds explicit parallel gateway nodes through the fluent builder", async () => {
  const process = await Bpmn.createProcess("parallel-flow");
  const model = process
    .startEvent("start")
    .parallelGateway("split")
    .parallelGateway("join")
    .endEvent("done")
    .build();

  assert.equal(model.element("split").type, "bpmn:ParallelGateway");
  assert.equal(model.element("join").type, "bpmn:ParallelGateway");
});

test("joins parallel, inclusive, and event-based branches only when declared explicitly", async () => {
  const process = await Bpmn.createProcess("joined-flow");
  const model = process
    .startEvent("start")
    .parallelGateway("parallel-split")
    .branch("left", (branch) => branch.userTask("left-task").join())
    .branch("right", (branch) => branch.serviceTask("right-task").join())
    .parallelJoin("parallel-join")
    .inclusiveGateway("inclusive-split")
    .branch("eligible", (branch) => branch.condition("= eligible").userTask("eligible-task").join())
    .branch("otherwise", (branch) => branch.defaultFlow().userTask("other-task").join())
    .inclusiveJoin("inclusive-join")
    .eventBasedGateway("event-split")
    .branch("message", (branch) =>
      branch.catchEvent("message-catch", {
        type: "message",
        message: { id: "Message_ordered", name: "Order received" }
      }).join()
    )
    .branch("signal", (branch) =>
      branch.catchEvent("signal-catch", {
        type: "signal",
        signal: { id: "Signal_cancelled", name: "Order cancelled" }
      }).join()
    )
    .exclusiveJoin("event-join")
    .endEvent("done")
    .build();

  const parallelJoin = model.element("parallel-join");
  const inclusiveSplit = model.element<"bpmn:InclusiveGateway">("inclusive-split");
  const eventSplit = model.element("event-split");

  assert.equal(moddleElements(parallelJoin.raw.get("incoming")).length, 2);
  assert.equal(moddleElements(inclusiveSplit.raw.get("outgoing")).length, 2);
  assert.equal(moddleElements(eventSplit.raw.get("outgoing")).length, 2);
  assert.equal(model.element("Message_ordered").type, "bpmn:Message");
  assert.equal(model.element("Signal_cancelled").type, "bpmn:Signal");
});

test("models explicit graph loops and BPMN loop characteristics on subprocesses", async () => {
  const process = await Bpmn.createProcess("looped-flow");
  const model = process
    .startEvent("start")
    .userTask("review")
    .standardLoop({ condition: "= retry", maximum: 3, testBefore: true })
    .loop("review", { condition: "= retry", name: "retry" })
    .subProcess("bulk-work")
    .multiInstanceLoop({
      cardinality: "= items",
      completionCondition: "= completed > 2",
      sequential: true
    })
    .adHocSubProcess("cleanup", {
      cancelRemainingInstances: false,
      completionCondition: "= approved",
      ordering: "Sequential"
    })
    .endEvent("done")
    .build();

  const reviewLoop = model.element("review").child<"bpmn:StandardLoopCharacteristics">(
    "loopCharacteristics"
  );
  const bulkLoop = model.element("bulk-work").child<"bpmn:MultiInstanceLoopCharacteristics">(
    "loopCharacteristics"
  );
  const cleanup = model.element("cleanup");
  const retryFlow = moddleElements(model.element("review").raw.get("outgoing")).find(
    (flow) => flow.get("targetRef") === model.element("review").raw
  );

  assert.equal(reviewLoop.raw.get("loopMaximum"), 3);
  assert.equal(reviewLoop.child("loopCondition").raw.get("body"), "= retry");
  assert.equal(bulkLoop.raw.get("isSequential"), true);
  assert.equal(bulkLoop.child("loopCardinality").raw.get("body"), "= items");
  assert.equal(cleanup.type, "bpmn:AdHocSubProcess");
  assert.equal(cleanup.raw.get("ordering"), "Sequential");
  assert.equal(cleanup.child("completionCondition").raw.get("body"), "= approved");
  assert.ok(retryFlow);
  assert.ok(isModdleElement(retryFlow?.get("conditionExpression")));
});

test("creates typed timer, message, error, escalation, signal, and link event definitions", async () => {
  const process = await Bpmn.createProcess("events-flow");
  const model = process
    .timerStartEvent("start", { duration: "PT5M" })
    .messageCatchEvent("receive", { id: "Message_inbound", name: "Inbound" })
    .errorThrowEvent("throw-error", { id: "Error_problem", code: "PROBLEM" })
    .escalationThrowEvent("throw-escalation", {
      id: "Escalation_manual",
      code: "MANUAL"
    })
    .signalCatchEvent("wait-signal", { id: "Signal_ready", name: "Ready" })
    .linkCatchEvent("link-target", "continue")
    .linkThrowEvent("link-source", "link-target")
    .signalEndEvent("done", { id: "Signal_done", name: "Done" })
    .build();

  const types = (id: string) => model.element(id)
    .children("eventDefinitions")
    .map((definition) => definition.type);
  const link = model.element("link-source").children<"bpmn:LinkEventDefinition">(
    "eventDefinitions"
  )[0];

  assert.deepEqual(types("start"), ["bpmn:TimerEventDefinition"]);
  assert.deepEqual(types("receive"), ["bpmn:MessageEventDefinition"]);
  assert.deepEqual(types("throw-error"), ["bpmn:ErrorEventDefinition"]);
  assert.deepEqual(types("throw-escalation"), ["bpmn:EscalationEventDefinition"]);
  assert.deepEqual(types("wait-signal"), ["bpmn:SignalEventDefinition"]);
  assert.equal(link?.raw.get("target"), model.element("link-target").children("eventDefinitions")[0]?.raw);
  assert.equal(model.element("Error_problem").raw.get("errorCode"), "PROBLEM");
  assert.equal(model.element("Escalation_manual").raw.get("escalationCode"), "MANUAL");
  await withTemporaryDirectory("bpmn-fluent-events", async (directory) => {
    const publication = await model.publish({ output: join(directory, "events.bpmn") });

    assert.equal(publication.status, "written");
  });
});

test("attaches typed boundary handlers without moving the main flow cursor", async () => {
  const process = await Bpmn.createProcess("boundary-flow");
  const model = process
    .startEvent("start")
    .serviceTask("work")
    .timerBoundaryEvent(
      "timeout",
      { duration: "PT10M" },
      (handler) => handler.serviceTask("notify-timeout").endEvent("timeout-done"),
      { cancelActivity: false }
    )
    .messageBoundaryEvent(
      "message-boundary",
      { id: "Message_update" },
      (handler) => handler.endEvent("message-done")
    )
    .errorBoundaryEvent(
      "error-boundary",
      { id: "Error_failed" },
      (handler) => handler.endEvent("error-done")
    )
    .escalationBoundaryEvent(
      "escalation-boundary",
      { id: "Escalation_review" },
      (handler) => handler.endEvent("escalation-done")
    )
    .signalBoundaryEvent(
      "signal-boundary",
      { id: "Signal_stop" },
      (handler) => handler.endEvent("signal-done")
    )
    .endEvent("done")
    .build();

  const work = model.element("work");
  const timeout = model.element("timeout");

  assert.equal(timeout.raw.get("attachedToRef"), work.raw);
  assert.equal(timeout.raw.get("cancelActivity"), false);
  assert.equal(moddleElements(work.raw.get("boundaryEventRefs")).length, 5);
  assert.equal(
    moddleElements(timeout.raw.get("outgoing"))[0]?.get("targetRef"),
    model.element("notify-timeout").raw
  );
  assert.equal(
    moddleElements(work.raw.get("outgoing"))[0]?.get("targetRef"),
    model.element("done").raw
  );
});
