---
name: bpmn-cli
description: Create and safely edit BPMN 2.0 and Camunda 8 / Zeebe models with @philippfromme/bpmn-cli.
---

# Model BPMN with bpmn-cli

Use `@philippfromme/bpmn-cli` to create or edit BPMN 2.0 and Zeebe models.
This is a reference skill to adapt for an agent host; installing the package
does not activate this file automatically.

## Choose an entry point

```ts
import { Bpmn } from "@philippfromme/bpmn-cli";

const process = await Bpmn.createProcess("process-id");
const collaboration = await Bpmn.createCollaboration("collaboration-id");
const editor = await Bpmn.open("existing.bpmn");
const emptyEditor = await Bpmn.create();
```

- Use `createProcess` for a new single-process design.
- Use `createCollaboration` for pools, messages, and message flows.
- Use `open` to make exact-ID changes to an existing BPMN file.
- Use `create` only when the fluent builders do not express the required
  operation.

## Core rules

1. Use stable, meaningful IDs supplied by the caller.
2. Keep topology explicit. Declare branch conditions/defaults, joins, loop
   targets, and fluent continuation points; never infer a cursor from graph
   order.
3. Use the fluent builders for common new-model topology. Use the editor for
   exact-ID changes or descriptor-backed features outside the fluent surface.
4. Do not edit BPMN XML, Diagram Interchange, or raw moddle objects.
5. Call `write()` once after all mutations are complete.
6. Treat library errors as actionable input errors. Do not bypass validation or
   retry by mutating XML.

## Create a process

```ts
const process = await Bpmn.createProcess("approval-flow");

await process
  .startEvent("start")
  .userTask("review", { formId: "review-request" })
  .exclusiveGateway("approved")
  .branch("yes", (branch) =>
    branch
      .condition("= approved")
      .serviceTask("notify", {
        taskType: "send-email",
        retries: "3",
        inputs: [{ source: "=requester.email", target: "email" }]
      })
      .endEvent("completed")
  )
  .branch("no", (branch) => branch.defaultFlow().endEvent("rejected"))
  .write({ output: "approval-flow.bpmn" });
```

## Edit an existing process

```ts
const editor = await Bpmn.open("existing.bpmn");
const task = editor.element<"bpmn:ServiceTask">("SendReply");

task.setName("Send customer reply");
task.extensions.ensure("zeebe:IoMapping").addInput({
  source: "=customer.id",
  target: "customerId"
});

await editor.write({ output: "edited.bpmn", layout: "none" });
```

To continue an existing process fluently, specify both IDs:

```ts
await editor
  .composeProcess("CustomerSupport")
  .at("SendReply")
  .endEvent("ReplySent")
  .write({ output: "completed.bpmn" });
```

## Layout and output

- `layout: "auto"` is the default and generates deterministic Diagram
  Interchange for generated models.
- `layout: "none"` skips automatic layout, preserves existing Diagram
  Interchange, and leaves models without Diagram Interchange unchanged.
- `write()` serializes, reloads, checks BPMN/Zeebe semantics, and writes
  atomically.
- A distinct existing output path requires `force: true`; do not use it unless
  replacement is intentional.

## Common patterns

- Service work: `serviceTask` with `taskType`, retries, I/O, headers, and
  properties.
- Human work: `userTask` with `formId`.
- Exception handling: attach typed timer, error, escalation, message, or
  signal boundary handlers.
- Collaboration: create participants, messages, and message flows with exact
  IDs through `Bpmn.createCollaboration`.
- Complex or uncommon BPMN/Zeebe properties: use `Bpmn.open` or `Bpmn.create`
  and the exact-ID editor.

Read the repository README for the complete supported fluent surface and the
current intentionally unsupported conveniences.
