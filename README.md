# bpmn-cli

Agent-first Node.js CLI and TypeScript library for BPMN inspection, tracing,
fluent model construction, linting, semantic diffing, and deterministic layout.
Business-semantic operations exclude Diagram Interchange, colors, and
presentation-only modeler data.

The library API owns typed moddle construction, generated IDs, containment,
reciprocal references, layout, reload verification, semantic change reporting,
and atomic publication. It replaces generic JSON request-based mutation.

```ts
import { BpmnModel } from "@philippfromme/bpmn-cli";

const model = await BpmnModel.open("customer-support.bpmn");
const task = model.element("ServiceTask_1");
task.extensions.ensure("zeebe:IoMapping").addInput({
  source: "xyz",
  target: "customerId"
});
await model.publish({
  output: "customer-support.edited.bpmn",
  layout: "auto",
  validate: true
});
```

For usage details, see the [overview](docs/overview.md) and concise
[agent skill](skills/bpmn-cli/SKILL.md).

## Development

```sh
npm install
npm run build
npm run typecheck
npm run lint
npm test
```

Run the compiled CLI with `node dist/index.js`.
