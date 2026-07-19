---
name: bpmn-cli
description: Safely inspect, trace, lint, diff, lay out, and edit BPMN models with bpmn-cli. Use when a task needs BPMN analysis or a reviewable BPMN change.
---

# bpmn-cli

Use `bpmn-cli` as the semantic interface to BPMN. Do not hand-edit BPMN XML.

## Operating rules

- Use `--json` for every agent decision. Text output is for human review.
- Discover IDs, `$type` values, and writable property names with `inspect`;
  never guess them from XML.
- Treat `lint` as policy analysis, separate from edit structural safety.
- Start edits with a preview. Apply only the exact `planHash` from that preview.
   For a trusted non-review workflow, `--apply-unreviewed` is allowed: it keeps all
   validation and verification but publishes atomically without external review.
- Prefer `--output <new-file.bpmn>` for applies. It keeps the source unchanged.
- Use the same profile, custom extensions, and layout mode for preview and
  apply. A mismatch makes the plan stale.
- Do not use `--force` to bypass review: it only permits replacing a separate
  output or report file.
- Use `--report <path> --json` when a complete response exceeds the 32 KiB
  stdout limit.

## Discover before acting

```sh
bpmn-cli capabilities --json
bpmn-cli inspect model.bpmn --json
bpmn-cli inspect model.bpmn --process Process_1 --json
bpmn-cli inspect model.bpmn --element Task_1 --json
```

Inspect provides semantic IDs, descriptor property names, exact references, and
active profiles. For behavior across control flow, trace a bounded graph:

```sh
bpmn-cli trace model.bpmn --from Task_1 --json
bpmn-cli trace model.bpmn --from Gateway_1 --to Task_2 --json
```

Use `--follow-message-flows` only when cross-participant traversal is needed.

## Review and edit workflow

1. Inspect the target, its containing scope, and relevant flows.
2. Lint the source:

   ```sh
   bpmn-cli lint model.bpmn --json
   ```

3. Discover the exact Edit v1 request schema if needed:

   ```sh
   bpmn-cli edit --schema --json
   ```

4. Write a request with only `add`, `remove`, `replace`, or `move`. Every
   operation requires at least one `expect` assertion.
5. Preview without writing BPMN:

   ```sh
   bpmn-cli edit model.bpmn --request edit.json --json > preview.json
   ```

6. Review `preview.json`: `planHash`, `operations`, generated IDs, derived
   `effects`, semantic `changes`, and `layout`.
7. Apply the exact hash to a separate file:

   ```sh
   PLAN_HASH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('preview.json', 'utf8')).planHash)")

   bpmn-cli edit model.bpmn --request edit.json \
     --apply "$PLAN_HASH" --output edited.bpmn --json
   ```

8. Verify the output:

   ```sh
   bpmn-cli lint edited.bpmn --json
   bpmn-cli diff model.bpmn edited.bpmn --json
   ```

`edit` auto-layouts by default. Add `--no-layout` to **both** preview and apply
to produce semantic-only BPMN without DI. Never reuse a hash produced with a
different layout mode.

## Profiles and extension descriptors

The Zeebe profile activates automatically for its standard namespace. Supply
the same extension arguments to every command that reads, previews, applies, or
verifies a custom model:

```sh
bpmn-cli inspect model.bpmn --extension acme=acme-moddle.json --json
bpmn-cli edit model.bpmn --request edit.json \
  --extension acme=acme-moddle.json --json
```

Use `--profile zeebe` only when automatic detection is insufficient. Do not
disable automatic profile detection unless the task explicitly requires it.

## Interpreting common errors

| Error code | Required action |
| --- | --- |
| `STALE_PLAN` | Re-preview. The source, request, profile/descriptor identity, layout mode, or resolved result changed. |
| `EDIT_PRECONDITION_FAILED` | Re-inspect the target and update the request; do not weaken the assertion blindly. |
| `EDIT_BPMN_STRUCTURE_INVALID` | Change the requested model semantics. Do not attempt to bypass structural BPMN validation. |
| `EXTERNAL_REFERENCE_CONFLICT` | Inspect all references to the affected element and make the required edits explicit. |
| `EDIT_TARGET_NOT_FOUND` | Discover the actual ID, or create and alias the target in an earlier operation. |
| `OUTPUT_TOO_LARGE` | Re-run with `--report <path> --json`; read the report artifact. |
| `PROFILE_ERROR` | Use the correct descriptor file and ensure its namespace does not collide with loaded packages. |

## Cookbook

Use the narrowest recipe that fits:

- [Inspect and diagnose](cookbook/inspect-and-diagnose.md)
- [Rename an element](cookbook/rename-element.md)
- [Insert an activity into a SequenceFlow](cookbook/insert-activity.md)
- [Add Zeebe or custom extension data](cookbook/extension-data.md)
- [Review, apply, and verify an edit](cookbook/review-apply-verify.md)

The repository also contains schema-valid request examples under
[`examples/edit`](../../examples/edit).
