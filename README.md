# bpmn-cli

`bpmn-cli` is a TypeScript library for creating and safely editing BPMN 2.0
and Camunda 8 / Zeebe models. Despite its name, it is not a command-line tool:
applications and generator scripts import the library, build or edit a model,
then write verified BPMN XML.

It has two APIs backed by one parser, descriptor resolver, mutation kernel,
layout engine, semantic verifier, and atomic output path:

| API | Use it for |
| --- | --- |
| `Bpmn` | Concise, semantic generator scripts for processes and collaborations. |
| `BpmnModel` | Exact-ID editing of existing models and the full bundled BPMN/Zeebe descriptor surface. |

## Install

```sh
npm install @philippfromme/bpmn-cli
```

Requires Node.js 20.12 or later.

## Generate a process

```ts
import { Bpmn } from "@philippfromme/bpmn-cli";

const process = await Bpmn.createProcess("approval-flow", {
  name: "Approval flow"
});

await process
  .startEvent("start", { name: "Request submitted" })
  .userTask("review", { name: "Review request", formId: "review-request" })
  .exclusiveGateway("approved", { name: "Approved?" })
  .branch("yes", (branch) =>
    branch
      .condition("= approved")
      .serviceTask("notify", {
        taskType: "send-email",
        retries: "3",
        inputs: [{ source: "=requester.email", target: "email" }]
      })
      .endEvent("done")
  )
  .branch("no", (branch) => branch.defaultFlow().endEvent("rejected"))
  .write({ output: "approval-flow.bpmn" });
```

`Bpmn` uses caller-supplied IDs, creates executable processes by default, and
keeps topology explicit. Joins, loop targets, branch conditions, and default
flows are never inferred.

The fluent layer covers common BPMN topology: exclusive, parallel, inclusive,
and event-based gateways; intermediate and boundary events; timers, messages,
errors, escalations, signals, and links; loops; subprocesses and ad-hoc
subprocesses. It also supports common Zeebe service-task configuration:
task type, retries, inputs/outputs, headers, properties, and forms.

## Generate a collaboration

Use a separate builder for pools and message flows:

```ts
const collaboration = await Bpmn.createCollaboration("order-collaboration");

await collaboration
  .process("buyer-process", { isExecutable: true })
  .process("seller-process")
  .participant("buyer", { name: "Buyer", processId: "buyer-process" })
  .participant("seller", { name: "Seller", processId: "seller-process" })
  .message("order-request", { name: "Order request" })
  .messageFlow("request", {
    sourceId: "buyer",
    targetId: "seller",
    messageId: "order-request"
  })
  .write({ output: "order-collaboration.bpmn", layout: "none" });
```

`CollaborationBuilder` deliberately does not share cursor state with
`ProcessBuilder`. Participants, messages, and message-flow endpoints use exact
IDs.

## Edit an existing model

`BpmnModel` is the universal editor. It uses descriptor-checked properties,
exact IDs, and typed contained children instead of XML manipulation.

```ts
import { BpmnModel } from "@philippfromme/bpmn-cli";

const model = await BpmnModel.open("customer-support.bpmn");
const task = model.element<"bpmn:ServiceTask">("SendReply");

task.setName("Send customer reply");
task.extensions.ensure("zeebe:IoMapping").addInput({
  source: "=customer.id",
  target: "customerId"
});

await model.write({
  output: "customer-support.edited.bpmn",
  layout: "none"
});
```

The model API provides scalar and ordinary-reference edits, typed contained
child traversal/create/remove, collision-safe ID renaming, sequence-flow
connect/rewire/remove, and safe boundary-event attachment. It also exposes
Zeebe helpers for forms, subscriptions, called decisions/elements, scripts,
and multi-instance settings.

Custom moddle extensions require a loaded descriptor:

```ts
const model = await BpmnModel.open("model.bpmn", {
  extensions: ["acme=acme-moddle.json"]
});

model.element("Task_1").extensions.ensureCustom("acme:Settings", {
  priority: "high"
});
```

## Writing and safety

`write()` is the only serialization boundary. It serializes, reloads,
verifies BPMN/Zeebe semantics, and writes atomically. It rejects ambiguous IDs,
foreign elements, invalid containment or connections, malformed BPMN, and
unsupported extension data rather than silently dropping it.

```ts
await model.write({
  output: "edited.bpmn", // required for BpmnModel.create()
  layout: "auto",        // default; use "none" to preserve imported DI
  validate: true,        // default
  force: false           // default; refuses replacement
});
```

Write results include output and semantic hashes plus semantic change
information. Presentation-only Diagram Interchange does not affect semantic
hashes.

## Examples

The executable examples cover the main supported scenarios:

- `examples/straight-through-service-flow.mjs`
- `examples/human-workflow.mjs`
- `examples/exception-timeout-handling.mjs`
- `examples/collaboration.mjs`
- `examples/multi-instance-work.mjs`

```sh
npm run build
node examples/straight-through-service-flow.mjs generated-flow.bpmn
```

## Verification

```sh
npm test
npm run lint
npm run test:generators
```

`test:generators` executes each example and gates script size, execution time,
write success, semantic fidelity after reload, and local BPMN/Zeebe
descriptor compatibility. It does not replace validation against an external
Camunda runtime.

## Scope and current gaps

The universal `BpmnModel` editor covers bundled BPMN, BPMNDI/DC/DI, and Zeebe
descriptor-backed properties. The fluent API is intentionally curated, not a
mirror of every descriptor. Current fluent gaps include assignment/lifecycle
settings, event subprocesses, and multi-instance element/output mappings.
