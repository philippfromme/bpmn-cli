# Add Zeebe or custom extension data

Use loaded descriptor property names and types. Never write generic XML blobs or
`$attrs`.

## Zeebe task definition

For a model with the standard Zeebe namespace, add an extension container and
task definition:

```json
{
  "schemaVersion": "1",
  "operations": [
    {
      "op": "add",
      "target": "Task_InvokeWorker",
      "path": "/extensionElements",
      "value": {
        "$type": "bpmn:ExtensionElements",
        "values": [
          {
            "$type": "zeebe:TaskDefinition",
            "type": "payment-worker",
            "retries": "3"
          }
        ]
      },
      "expect": [
        {
          "target": "Task_InvokeWorker",
          "path": "/extensionElements",
          "absent": true
        }
      ]
    }
  ]
}
```

Preview with automatic Zeebe detection:

```sh
bpmn-cli edit model.bpmn --request zeebe-task.json --json
```

For an existing extension container, inspect it first; use `add` for an absent
property or collection insertion, and `replace` only for an existing value.

## Custom descriptors

Pass the same descriptor path to discovery, preview, apply, and verification:

```sh
bpmn-cli inspect model.bpmn --extension acme=acme-moddle.json --json
bpmn-cli edit model.bpmn --request edit.json \
  --extension acme=acme-moddle.json --json > preview.json
```

The plan hash binds the descriptor's exact bytes. Editing the descriptor between
preview and apply intentionally causes `STALE_PLAN`.

See [`examples/edit/add-zeebe-task-definition.json`](../../../examples/edit/add-zeebe-task-definition.json)
for the complete request.
