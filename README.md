# bpmn-sdk

`bpmn-sdk` is a TypeScript library for creating and safely editing BPMN 2.0
and Camunda 8 / Zeebe models. Applications and generator scripts import the
library, build or edit a model, then write verified BPMN XML.

`Bpmn` is the single public entry point to one parser, descriptor resolver,
mutation kernel, layout engine, semantic verifier, and atomic output path.
Use it for concise generators and exact-ID editing alike.

## Install

```sh
npm install @philippfromme/bpmn-sdk
```

Requires Node.js 20.12 or later.

## Generate a process

```ts
import { Bpmn } from "@philippfromme/bpmn-sdk";

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
IDs. Both builders expose their shared editor through `editor()` when a
script needs exact-ID edits before writing.

## Edit an existing model

`Bpmn.open()` returns the universal editor. It uses descriptor-checked properties,
exact IDs, and typed contained children instead of XML manipulation.

```ts
import { Bpmn } from "@philippfromme/bpmn-sdk";

const model = await Bpmn.open("customer-support.bpmn");
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

To resume fluent topology construction after exact-ID editing, select both
targets explicitly; no cursor is inferred:

```ts
await model
  .composeProcess("CustomerSupport")
  .at("SendReply")
  .endEvent("ReplySent")
  .write({ output: "customer-support.completed.bpmn" });
```

The selected node must be a flow node directly contained by the selected
process. Continuing from an end event is terminal, and an existing gateway
default flow remains claimed.

Custom moddle extensions require a loaded descriptor:

```ts
const model = await Bpmn.open("model.bpmn", {
  extensions: ["acme=acme-moddle.json"]
});

model.element("Task_1").extensions.ensureCustom("acme:Settings", {
  priority: "high"
});
```

## Create an editable model

```ts
import { Bpmn } from "@philippfromme/bpmn-sdk";

const model = await Bpmn.create();
const process = model.process({ name: "Customer email" });
const task = model.create("bpmn:UserTask", { name: "Send customer email" });
model.append(process, task, "flowElements");
task.configureForm({ formId: "customer-email" });
await model.write({ output: "customer-email.bpmn" });
```

## Writing and safety

`write()` is the only serialization boundary. It serializes, reloads,
verifies BPMN/Zeebe semantics, and writes atomically. It rejects ambiguous IDs,
foreign elements, invalid containment or connections, malformed BPMN, and
unsupported extension data rather than silently dropping it.

```ts
await model.write({
  output: "edited.bpmn", // required for Bpmn.create()
  layout: "auto",        // default; regenerate Diagram Interchange
  validate: true,        // default
  force: false           // default; refuses replacement
});
```

Write results include output and semantic hashes plus semantic change
information. Presentation-only Diagram Interchange does not affect semantic
hashes. Use `layout: "none"` to skip `bpmn-auto-layout`: existing Diagram
Interchange is preserved unchanged, and a model without Diagram Interchange
remains without it. Use the default `layout: "auto"` for generated models that
need a deterministic diagram.

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

For a concise, agent-facing operating guide, see
[`examples/agent-skill/SKILL.md`](examples/agent-skill/SKILL.md). It is a
reference skill to adapt for an agent platform; installing this package does
not automatically activate it.

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

The editor returned by `Bpmn.open()` and `Bpmn.create()` covers bundled BPMN, BPMNDI/DC/DI, and Zeebe
descriptor-backed properties. The fluent API is intentionally curated, not a
mirror of every descriptor. Current fluent gaps include assignment/lifecycle
settings, event subprocesses, and multi-instance element/output mappings.
