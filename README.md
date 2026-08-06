# bpmn-cli

Fluent, type-safe BPMN model construction and safe publication for TypeScript.
This is a library, not a command-line interface.

```sh
npm install @philippfromme/bpmn-cli
```

```ts
import { BpmnModel } from "@philippfromme/bpmn-cli";
```

## Generate a process from a script

```ts
import { Bpmn } from "@philippfromme/bpmn-cli";

const process = await Bpmn.createProcess("approval-flow", {
  name: "Approval flow"
});

await process
  .startEvent("start", { name: "Request Submitted" })
  .userTask("review", { name: "Review request" })
  .exclusiveGateway("approved", { name: "Approved?" })
  .branch("yes", (branch) =>
    branch
      .condition("= approved")
      .serviceTask("notify", { taskType: "send-email" })
      .endEvent("done")
  )
  .branch("no", (branch) => branch.defaultFlow().endEvent("rejected"))
  .publish({ output: "approval-flow.bpmn" });
```

`Bpmn` is the one-shot, semantic construction API for generator scripts.
It creates executable processes, uses exact caller-supplied IDs, assigns
conditions and default flows safely, applies deterministic layout by default,
and delegates publication to the same verified atomic pipeline as `BpmnModel`.

## Generate a collaboration

Use the dedicated collaboration builder when a model contains pools and message
flows. Its references are exact BPMN IDs; it does not share process-flow cursor
state with `ProcessBuilder`.

```ts
const collaboration = await Bpmn.createCollaboration("order-collaboration");

await collaboration
  .process("buyer-process", { isExecutable: true })
  .process("seller-process")
  .participant("buyer", { name: "Buyer", processId: "buyer-process" })
  .participant("seller", { name: "Seller", processId: "seller-process" })
  .message("order-request", { name: "Order request" })
  .messageFlow("request-flow", {
    sourceId: "buyer",
    targetId: "seller",
    messageId: "order-request"
  })
  .publish({ output: "order-collaboration.bpmn", layout: "none" });
```

## Edit an existing model

```ts
const model = await BpmnModel.open("customer-support.bpmn");
const task = model.element("ServiceTask_1");

task.extensions.ensure("zeebe:IoMapping").addInput({
  source: "=customer.id",
  target: "customerId"
});

const result = await model.publish({
  output: "customer-support.edited.bpmn",
  layout: "auto",
  validate: true
});
```

`element(id)` requires an exact BPMN ID. `result` includes the output hash,
semantic hash, destination, selected layout, and added/changed/removed
semantic elements.

## Create a process

```ts
const model = await BpmnModel.create();
const process = model.process({ name: "Customer email" });
const start = model.create("bpmn:StartEvent", {});
const task = model.create("bpmn:UserTask", { name: "Send customer email" });
const end = model.create("bpmn:EndEvent", {});

for (const element of [start, task, end]) {
  model.append(process, element, "flowElements");
}
model.connect(start, task);
model.connect(task, end);

await model.publish({ output: "customer-email.bpmn" });
```

`create` assigns collision-safe IDs. `append` establishes containment.
`connect`, `rewire`, and `remove` keep SequenceFlow references consistent.

## Configure Zeebe user tasks

```ts
task.configureForm({
  formId: "customer-email",
  formKey: "=customer.form"
});

task.extensions.ensure("zeebe:IoMapping").addInput({
  source: "=customer.email",
  target: "email"
});
```

`ensure("zeebe:IoMapping")` reuses an existing mapping rather than replacing
extension data. Zeebe is available by default for `BpmnModel.create()` and is
detected automatically when an opened model declares the Zeebe namespace.

## Use a custom moddle descriptor

```ts
const model = await BpmnModel.open("model.bpmn", {
  extensions: ["acme=acme-moddle.json"]
});

const settings = model.element("Task_1").extensions.ensureCustom(
  "acme:Settings",
  { priority: "high" }
);
settings.append("rules", "acme:Rule", { name: "customer" });

await model.publish({ output: "model.edited.bpmn", layout: "none" });
```

Custom element types and properties must come from a loaded descriptor.

## Publication behavior

```ts
await model.publish({
  output: "edited.bpmn", // Required for BpmnModel.create()
  layout: "auto",        // Default; use "none" to skip automatic DI layout
  validate: true,        // Default; checks for introduced parse diagnostics
  force: false           // Default; refuse to replace an existing output
});
```

Publication serializes, reloads, verifies business semantics, and writes
atomically. It rejects malformed BPMN, unsupported extension data, ambiguous
IDs, foreign model elements, invalid containment, and invalid connections.

## Executable examples

- [`examples/straight-through-service-flow.mjs`](examples/straight-through-service-flow.mjs):
  two Zeebe service tasks in a straight-through flow.
- [`examples/human-workflow.mjs`](examples/human-workflow.mjs): a form-backed
  manager review with approved and default outcomes.
- [`examples/exception-timeout-handling.mjs`](examples/exception-timeout-handling.mjs):
  non-interrupting timer and error boundary handlers.
- [`examples/collaboration.mjs`](examples/collaboration.mjs): pools, an exact
  message reference, and a message flow.
- [`examples/multi-instance-work.mjs`](examples/multi-instance-work.mjs):
  parallel multi-instance service work with a completion condition.
- [`src/model.test.ts`](src/model.test.ts): create, open, publish, and nested Zeebe I/O.
- [`src/model-graph.test.ts`](src/model-graph.test.ts): connect, rewire, and remove.
- [`src/model-extensions.test.ts`](src/model-extensions.test.ts): forms, I/O mappings, and custom descriptors.

Build once, then invoke an example with its output path:

```sh
npm run build
node examples/straight-through-service-flow.mjs generated-order-flow.bpmn
```

Every example prints its `PublicationResult` as JSON and writes only to the
path supplied on the command line (or its documented default file name).

## Generator acceptance metrics

`npm run test:generators` executes each example using only this repository's
local dependencies and fixtures. It is also included in `npm test`. The
repeatable acceptance gates are:

| Metric | Acceptance rule |
| --- | --- |
| Script size | Each example is at most 2,500 bytes. |
| Execution time | Each isolated Node.js invocation completes within 5,000 ms. |
| Publication | The script reports `status: "written"` and produces BPMN XML. |
| Semantic fidelity | The published semantic hash equals the hash after reopening, and scenario-specific IDs, references, extensions, and loop settings are asserted. |
| Camunda compatibility | The output passes the local BPMN and Zeebe moddle-descriptor gate with no parse warnings, unresolved references, or unsupported extension data. |

The compatibility gate verifies serialized BPMN and Zeebe metadata; it does
not execute a workflow.

## Capability support and known gaps

| Capability | Support |
| --- | --- |
| Straight-through Zeebe service flow | Supported, including task type, retries, I/O mappings, headers, and properties. |
| Human workflow | Supported user tasks and Zeebe form IDs; assignment and lifecycle semantics are not modeled by the fluent API. |
| Exception and timeout handling | Supported typed timer, error, escalation, message, and signal boundary events with explicit terminal handlers; event subprocesses are not fluent-builder nodes. |
| Collaboration | Supported pools, root processes, messages, and exact message flows; process-flow construction is separate from the collaboration builder. |
| Multi-instance work | Supported cardinality, completion condition, and sequential/parallel mode; collection, element-variable, and output-element mappings are not exposed by the fluent API. |

For the full API contract and extension rules, see [the API overview](docs/overview.md).

```sh
npm test
```
