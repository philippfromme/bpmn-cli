# bpmn-cli

Fluent, type-safe BPMN model construction and safe publication for TypeScript.
This is a library, not a command-line interface.

```ts
import { BpmnModel } from "@philippfromme/bpmn-cli";

const model = await BpmnModel.open("customer-support.bpmn");
model.element("ServiceTask_1").extensions.ensure("zeebe:IoMapping").addInput({
  source: "=customer.id",
  target: "customerId"
});
await model.publish({
  output: "customer-support.edited.bpmn",
  layout: "auto"
});
```

`BpmnModel` owns moddle construction, generated IDs, containment, SequenceFlow
reciprocal references, reload verification, semantic change reporting, and
atomic output. Use `BpmnModel.create()` for new models and
`extensions.ensureCustom()` only with loaded custom moddle descriptors.

```sh
npm install
npm test
```

See the [API overview](docs/overview.md) for extension and publication rules.
