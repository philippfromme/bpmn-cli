# bpmn-cli

`bpmn-cli` is a focused TypeScript library for creating and safely changing BPMN
models. It exposes a fluent semantic API rather than XML editing, a generic
transaction DSL, or a command-line interface.

The library owns moddle construction, generated IDs, containment, reciprocal
flow references, optional deterministic layout, reload verification, semantic
change reporting, and atomic publication.

```ts
import { BpmnModel } from "@philippfromme/bpmn-cli";

const model = await BpmnModel.open("customer-support.bpmn");
const task = model.element("ServiceTask_1");
task.extensions.ensure("zeebe:IoMapping").addInput({
  source: "=customer.id",
  target: "customerId"
});

await model.publish({
  output: "customer-support.edited.bpmn",
  layout: "auto",
  validate: true
});
```

Use `BpmnModel.create()` to start a new definitions document. Create processes,
activities, events, gateways, and flows through named methods; use
`extensions.ensureCustom()` only for loaded custom moddle descriptors.

## Development

```sh
npm install
npm run build
npm run typecheck
npm run lint
npm test
```

See the [API overview](docs/overview.md) for publication and extension safety
contracts.
