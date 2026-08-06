# Fluent BPMN Model API

`bpmn-cli` is a TypeScript library for working with BPMN business semantics.
BPMN XML remains the durable artifact, while the fluent API owns safe moddle
construction and output writing.

## Generate a collaboration

`Bpmn.createCollaboration(id, options)` returns `CollaborationBuilder`, which
is separate from `ProcessBuilder` and is intended for root processes, pools,
messages, and message flows. It exposes `process`, `participant`, `message`,
and `messageFlow`; each ID is caller supplied. `processId`, `sourceId`,
`targetId`, and `messageId` are exact references to already-created BPMN
elements. A participant may omit `processId` for a black-box pool, and a
message flow may omit `messageId`.

```ts
const collaboration = await Bpmn.createCollaboration("order-collaboration");

await collaboration
  .process("buyer-process", { isExecutable: true })
  .process("seller-process")
  .participant("buyer", { processId: "buyer-process" })
  .participant("seller", { processId: "seller-process" })
  .message("order-request")
  .messageFlow("request-flow", {
    sourceId: "buyer",
    targetId: "seller",
    messageId: "order-request"
  })
  .write({ output: "order-collaboration.bpmn", layout: "none" });
```

## Generate a process

Use `Bpmn` for a one-shot generator script. It is the high-level semantic API;
it does not expose BPMN XML, Diagram Interchange, cursor state, or a command
language.

```ts
import { Bpmn } from "@philippfromme/bpmn-cli";

const process = await Bpmn.createProcess("approval-flow", {
  name: "Approval flow"
});

await process
  .startEvent("start")
  .userTask("review", { name: "Review request" })
  .exclusiveGateway("approved", { name: "Approved?" })
  .branch("yes", (branch) =>
    branch
      .condition("= approved")
      .serviceTask("notify", { taskType: "send-email" })
      .endEvent("done")
  )
  .branch("no", (branch) => branch.defaultFlow().endEvent("rejected"))
  .write({ output: "approval-flow.bpmn" });
```

Exclusive and inclusive branches must begin with `condition(expression)` or
`defaultFlow()` and end with `endEvent()` or `join()`. `build()` returns the
underlying `BpmnModel` when a script needs the lower-level exact-ID API before
writing. `write()` retains the standard validation, deterministic
auto-layout, semantic verification, and atomic-output behavior.

## Branch joins, events, and loops

Splits are joined only through an explicit join declaration. Branches that
continue must call `join()`, followed by the selected gateway join; branches
that end use `endEvent()` instead.

```ts
process
  .startEvent("start")
  .parallelGateway("split")
  .branch("a", (branch) => branch.userTask("a").join())
  .branch("b", (branch) => branch.userTask("b").join())
  .parallelJoin("join")
  .timerCatchEvent("wait", { duration: "PT5M" })
  .endEvent("done");
```

`inclusiveGateway`, `eventBasedGateway`, `parallelJoin`, `inclusiveJoin`, and
`exclusiveJoin` model the corresponding BPMN gateways. Event-based branches
must begin with `catchEvent`. Use `catchEvent` and `throwEvent` with typed
timer, message, error, escalation, signal, or link definitions, or the
corresponding convenience methods such as `timerCatchEvent` and
`errorEndEvent`. Message, error, escalation, and signal references are
root BPMN elements created or reused by their exact IDs.

Use `loop(targetId)` for an explicit graph back-edge,
`standardLoop(options)` or `multiInstanceLoop(options)` for BPMN activity loop
characteristics, and `subProcess` or `adHocSubProcess` for subprocess nodes.
`boundary(id, definition, handler)` attaches a typed boundary event to the
current activity while keeping the main-flow cursor unchanged; the handler
must end explicitly.

## Generator scripts and local acceptance

The executable scripts in [`examples/`](../examples) cover straight-through
service work, human review, timeout and error handling, collaboration, and
multi-instance work. Build before running one:

```sh
npm run build
node examples/multi-instance-work.mjs bulk-dispatch.bpmn
```

Each script accepts an optional output path and writes its `WriteResult`
as JSON. `npm run test:generators` runs all five scripts and enforces a
2,500-byte script-size ceiling, a 5,000 ms execution ceiling per script,
successful write, semantic-hash round trips plus scenario assertions,
and the local BPMN/Zeebe moddle compatibility gate. The gate rejects parse
warnings, unresolved references, and unsupported extension data. It validates
serialized BPMN and Zeebe metadata rather than workflow execution.

The fluent builder supports task type and I/O configuration, user-task form
IDs, typed boundary handlers, pools/messages/message flows, and basic
multi-instance characteristics. It intentionally does not provide user-task
assignment/lifecycle settings, event subprocesses, or multi-instance
collection/element-variable/output-element mappings. Collaboration construction
is separate from process-flow construction.

## Open and change an existing model

```ts
import { BpmnModel } from "@philippfromme/bpmn-cli";

const model = await BpmnModel.open("customer-support.bpmn");
const task = model.element("ServiceTask_1");
task.extensions.ensure("zeebe:IoMapping").addInput({
  source: "=customer.id",
  target: "customerId"
});

const result = await model.write({
  output: "customer-support.edited.bpmn",
  layout: "auto",
  validate: true
});
```

`element(id)` requires an exact BPMN ID. `write` serializes the model,
optionally replaces Diagram Interchange with deterministic layout, reloads it
with the active profiles, verifies semantic equivalence, reports changes, and
atomically writes the output. It never needs JSON Pointer paths, request files,
manual reciprocal-reference maintenance, or external plan hashes.

## Create a model

```ts
const model = await BpmnModel.create();
const process = model.process({ name: "Customer email" });
const task = model.create("bpmn:UserTask", { name: "Send customer email" });
model.append(process, task, "flowElements");
task.configureForm({ formId: "customer-email" });
await model.write({ output: "customer-email.bpmn", layout: "auto" });
```

`connect`, `rewire`, and `remove` maintain or validate SequenceFlow reciprocal
references. Generated IDs are collision-safe and library-owned.

## Extensions and profiles

Zeebe activates automatically for models that declare its namespace.
`extensions.ensure("zeebe:IoMapping")` preserves existing extension values and
adds typed nested inputs safely.

For custom extensions, provide a moddle descriptor when opening the model and
use the descriptor-validated escape hatch:

```ts
const model = await BpmnModel.open("model.bpmn", {
  extensions: ["acme=acme-moddle.json"]
});
const settings = model.element("Task_1").extensions.ensureCustom(
  "acme:Settings",
  { priority: "high" }
);
settings.append("rules", "acme:Rule", { name: "customer" });
```

Writing refuses malformed or unregistered extension data rather than
silently discarding it.
