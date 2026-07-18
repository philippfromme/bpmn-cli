# Review, apply, and verify

Always preview first:

```sh
bpmn-cli edit model.bpmn --request edit.json --json > preview.json
```

Review these fields before publication:

- `planHash`: exact approval token.
- `sourceSha256` and `requestSha256`: inputs bound to the plan.
- `operations`: resolved generated IDs and operation-local `effects`.
- `changes`: exact semantic additions, removals, and modifications.
- `layout`: `auto` by default, or `none` only when explicitly selected.

Apply only the exact hash, preferably to a separate file:

```sh
PLAN_HASH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('preview.json', 'utf8')).planHash)")

bpmn-cli edit model.bpmn --request edit.json \
  --apply "$PLAN_HASH" --output edited.bpmn --json > apply.json
```

Verify output policy and semantic change:

```sh
bpmn-cli lint edited.bpmn --json > lint.json
bpmn-cli diff model.bpmn edited.bpmn --json > diff.json
```

For a semantic-only result, include `--no-layout` in **both** commands:

```sh
bpmn-cli edit model.bpmn --request edit.json --no-layout --json > preview.json
bpmn-cli edit model.bpmn --request edit.json --no-layout \
  --apply "$PLAN_HASH" --output edited.bpmn --json
```

If `STALE_PLAN` occurs, discard the old approval and repeat preview/review. Do
not retry with a modified, case-folded, or guessed hash.
