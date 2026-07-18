# Insert an activity into a SequenceFlow

This is a three-operation transaction:

1. Add the activity and name it with an alias.
2. Retarget the existing incoming SequenceFlow to that alias.
3. Add the downstream SequenceFlow.

Inspect the process, existing flow, source, and target first. Substitute every
placeholder below with IDs and values returned by `inspect`.

```json
{
  "schemaVersion": "1",
  "operations": [
    {
      "op": "add",
      "target": "Process_1",
      "path": "/flowElements/-",
      "value": {
        "$type": "bpmn:UserTask",
        "name": "Review application"
      },
      "as": "$review",
      "expect": [
        {
          "target": "Process_1",
          "path": "/flowElements",
          "length": 10
        }
      ]
    },
    {
      "op": "replace",
      "target": "Flow_Approve",
      "path": "/targetRef",
      "value": "$review",
      "expect": [
        {
          "target": "Flow_Approve",
          "path": "/targetRef",
          "equals": "Task_Approve"
        }
      ]
    },
    {
      "op": "add",
      "target": "Process_1",
      "path": "/flowElements/-",
      "value": {
        "$type": "bpmn:SequenceFlow",
        "sourceRef": "$review",
        "targetRef": "Task_Approve"
      },
      "as": "$afterReview",
      "expect": [
        {
          "target": "Process_1",
          "path": "/flowElements",
          "length": 11
        }
      ]
    }
  ]
}
```

The preview reports generated IDs and derived incoming/outgoing effects. Review
those effects: they must only update the old and new flow endpoints. An
unexpected effect is a reason to stop and inspect, not to apply.

The schema-valid source is
[`examples/edit/split-sequence-flow.json`](../../../examples/edit/split-sequence-flow.json).
