---
name: bpmn-cli
description: Inspect, validate, compare, lay out, and safely modify BPMN models with bpmn-cli's fluent TypeScript API.
---

# bpmn-cli

Use `bpmn-cli` as the BPMN semantic interface. Do not hand-edit BPMN XML or
construct generic mutation requests.

```ts
const model = await BpmnModel.open("model.bpmn");
const task = model.element("Task_1");
task.extensions.ensure("zeebe:IoMapping").addInput({
  source: "=customer.id",
  target: "customerId"
});
await model.publish({ output: "edited.bpmn", layout: "auto", validate: true });
```

The model API owns IDs, containment, reciprocal references, layout, reload
verification, semantic reports, and atomic publication. Use `lint` for
independent policy validation:

```sh
bpmn-cli lint edited.bpmn --json
bpmn-cli diff model.bpmn edited.bpmn --json
```

Use bounded CLI diagnostics only when needed:

```sh
bpmn-cli capabilities --json
bpmn-cli inspect model.bpmn --element Task_1 --json
bpmn-cli trace model.bpmn --from Task_1 --json
```

Use loaded custom moddle descriptors for extension data. Unsupported or
unparsed extension data must never be discarded.
