# Rename an element

Inspect first to obtain the exact ID and current value:

```sh
bpmn-cli inspect model.bpmn --element Task_1 --json
```

Write `rename.json` using the discovered values:

```json
{
  "schemaVersion": "1",
  "operations": [
    {
      "op": "replace",
      "target": "Task_1",
      "path": "/name",
      "value": "Review application",
      "expect": [
        {
          "target": "Task_1",
          "path": "/name",
          "equals": "Review request"
        }
      ]
    }
  ]
}
```

Preview, apply the exact hash to a new output, then verify:

```sh
bpmn-cli edit model.bpmn --request rename.json --json > preview.json
PLAN_HASH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('preview.json', 'utf8')).planHash)")
bpmn-cli edit model.bpmn --request rename.json \
  --apply "$PLAN_HASH" --output renamed.bpmn --json
bpmn-cli lint renamed.bpmn --json
bpmn-cli diff model.bpmn renamed.bpmn --json
```

If the expectation fails, inspect again. Do not replace `equals` with a weaker
assertion just to make the command pass.
