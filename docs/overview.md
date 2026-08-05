# Fluent BPMN Model API

`bpmn-cli` is a TypeScript library for working with BPMN business semantics.
BPMN XML remains the durable artifact, while the fluent API owns safe moddle
construction and publication.

## Open and change an existing model

```ts
import { BpmnModel } from "@philippfromme/bpmn-cli";

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

`element(id)` requires an exact BPMN ID. `publish` serializes the model,
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
await model.publish({ output: "customer-email.bpmn", layout: "auto" });
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

Publication refuses malformed or unregistered extension data rather than
silently discarding it.
