# bpmn-cli Overview

`bpmn-cli` gives coding agents and humans a semantic interface to BPMN. The
CLI inspects, traces, validates, compares, and lays out models. The TypeScript
API creates and changes BPMN through named operations rather than XML or a
generic mutation DSL.

## Fluent model API

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

The API owns moddle construction, identifiers, containment, reciprocal
references, deterministic layout, serialization/reload verification, semantic
change reporting, and atomic output publication. `publish` fails rather than
writing a model whose reload changes the intended business semantics. Policy
linting remains a separate, optional command.

Use `BpmnModel.create()` to start a definitions document or `BpmnModel.open()`
to safely load an existing BPMN model. Select exact existing elements with
`model.element(id)`. The API never requires JSON Pointer paths, request files,
manual operation ordering, aliases, or an external plan-hash loop.

## CLI diagnostics

```sh
bpmn-cli capabilities --json
bpmn-cli inspect model.bpmn --element Task_1 --json
bpmn-cli trace model.bpmn --from Task_1 --json
bpmn-cli lint model.bpmn --json
bpmn-cli diff before.bpmn after.bpmn --json
bpmn-cli layout model.bpmn --output laid-out.bpmn --json
```

`inspect` and `trace` are optional diagnostics, not mutation preconditions.
`lint` reports BPMN policy issues and does not replace structural/reload safety.

## Profiles

The Zeebe profile activates automatically when its standard namespace is
present. Load custom profiles explicitly using the library open options or
`--extension name=descriptor.json` for CLI diagnostics. Unsupported or
unparsed extension data is never silently discarded during publication.
