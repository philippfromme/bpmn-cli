# Inspect and diagnose

Use this workflow before proposing an edit or responding to a lint finding.

```sh
bpmn-cli inspect model.bpmn --json > catalog.json
bpmn-cli lint model.bpmn --json > lint.json
```

Use the catalog to choose one process and then inspect the relevant semantic
elements:

```sh
bpmn-cli inspect model.bpmn --process Process_1 --json > process.json
bpmn-cli inspect model.bpmn --element Task_1 --json > task.json
bpmn-cli trace model.bpmn --from Task_1 --json > behavior.json
```

For a decision or flow change, inspect both endpoints and the containing scope.
Do not infer `sourceRef`, `targetRef`, `default`, `conditionExpression`, or
extension properties from their XML spelling.

If JSON exceeds the interactive budget, request a complete artifact:

```sh
bpmn-cli inspect model.bpmn --process Process_1 --all \
  --json --output process.json
```

Lint findings are policy results, not proof that a model can or cannot be
structurally edited. Use their `elementRef` and `path` to inspect exact context.
