# bpmn-cli

Agent-first Node.js CLI for bounded BPMN inspection, tracing, safe editing,
linting, semantic diffing, and layout. Business-semantic operations exclude
Diagram Interchange, colors, and presentation-only modeler data.

## Requirements

- Node.js 20.12 or later
- npm

## Development

```sh
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run test:coverage
```

Run the built CLI with `node dist/index.js`, or use the `bpmn-cli` executable
after linking or packaging it.

## Agent inspection workflow

Start with the bounded model catalog:

```sh
bpmn-cli inspect "model.bpmn" --json
```

Use the returned process IDs to inspect one process and its nested containers:

```sh
bpmn-cli inspect "model.bpmn" --process Process_1 --json
```

Page through one process or subprocess's direct `flowElements` and `artifacts`.
The default page size is 25 and the maximum is 100:

```sh
bpmn-cli inspect "model.bpmn" --scope Process_1 --limit 25 --json
bpmn-cli inspect "model.bpmn" --scope Process_1 --limit 25 --cursor "<cursor>" --json
```

Inspect exact BPMN semantics and local context for an element:

```sh
bpmn-cli inspect "model.bpmn" --element Gateway_1 --json
bpmn-cli inspect "model.bpmn" --element BoundaryEvent_1 --json
bpmn-cli inspect "model.bpmn" --element MessageFlow_1 --json
```

Properties use loaded moddle descriptor names. For example, output preserves
`$type`, `sourceRef`, `targetRef`, `attachedToRef`, `eventDefinitions`, and
`messageFlows`; references are IDs. Derived counts, context, diagnostics, and
paging metadata are isolated under `analysis`, `context`, and `page`.

## Agent trace workflow

Trace modeled behavior forward, backward, or between two elements:

```sh
bpmn-cli trace "model.bpmn" --from Task_1 --json
bpmn-cli trace "model.bpmn" --to EndEvent_1 --json
bpmn-cli trace "model.bpmn" --from Gateway_1 --to Task_2 --json
```

Trace returns a reachable BPMN-native subgraph, not simulated execution or an
enumeration of paths. It preserves exact SequenceFlow conditions, nested
scopes, handlers, loops, relevant lanes/data/artifacts, and modeled event
transitions. MessageFlows are shown when relevant but crossed only explicitly:

```sh
bpmn-cli trace "collaboration.bpmn" --to StartEvent_1 \
  --follow-message-flows --json
```

For human review, render the same bounded selection as a Mermaid flowchart:

```sh
bpmn-cli trace "model.bpmn" --from Gateway_1 --to Task_2 --mermaid
bpmn-cli trace "model.bpmn" --from Task_1 --mermaid --output "trace.mmd"
```

Mermaid output groups BPMN scopes, labels exact SequenceFlow conditions, uses
dashed MessageFlows, highlights selected endpoints, and exposes truncation
frontiers. JSON remains the canonical machine-readable contract.

The default budget is 50 unique semantic elements; the maximum is 100. Bounded
results report deterministic `frontierRefs`. Complete output requires an
offline artifact:

```sh
bpmn-cli trace "model.bpmn" --from Task_1 --all --json --output "trace.json"
```

## Agent utility workflow

Discover the strict Edit v1 request schema, then preview a descriptor-driven
transaction:

```sh
bpmn-cli edit --schema --json
bpmn-cli edit "model.bpmn" --request "edit.json" --json
```

Preview never writes BPMN. Apply reruns the complete transaction and requires
the exact `planHash` returned by preview:

```sh
bpmn-cli edit "model.bpmn" --request "edit.json" \
  --apply "<planHash>" --json
bpmn-cli edit "model.bpmn" --request "edit.json" \
  --apply "<planHash>" --output "edited.bpmn" --json
```

Edit supports `add`, `remove`, `replace`, and `move` over loaded BPMN, Zeebe,
and custom moddle descriptors. Auto-layout is the default; `--no-layout`
removes DI. Every operation requires explicit preconditions, and reciprocal
BPMN references are normalized and reported as effects. See [PLAN.md](PLAN.md)
for the complete safety contract.

Run BPMN policy checks through the bundled `bpmnlint` engine:

```sh
bpmn-cli lint "model.bpmn" --json
bpmn-cli lint "model.bpmn" --config ".bpmnlintrc" --json
```

The current directory's `.bpmnlintrc` is used automatically. Without one,
`bpmnlint:correctness` is the fallback. Configured errors exit `1`; warnings
alone exit `0`. Lint is policy analysis, not an edit-safety gate.

Compare descriptor-faithful business semantics through the pinned
`bpmn-js-differ#next` engine:

```sh
bpmn-cli diff "before.bpmn" "after.bpmn" --json
bpmn-cli diff "before.bpmn" "after.bpmn" --include-layout --json
```

DI, colors, formatting, namespace prefixes, and excluded template icons do not
create semantic changes. `--include-layout` reports DI changes separately.
Different models remain successful results with `changed: true` and exit `0`.

Replace all existing DI through the pinned `bpmn-auto-layout#next` engine:

```sh
bpmn-cli layout "model.bpmn" --json
bpmn-cli layout "model.bpmn" --output "laid-out.bpmn" --json
```

Layout replaces the source atomically by default. `--output` leaves the source
unchanged; replacing an existing output additionally requires `--force`.
Nothing is published unless the generated XML reloads successfully and its
business-semantic hash exactly matches the input.

Large lint and diff results require an offline JSON report:

```sh
bpmn-cli lint "model.bpmn" --json --report "lint.json"
bpmn-cli diff "before.bpmn" "after.bpmn" --json --report "diff.json"
```

## Profiles and extensions

The standard Zeebe namespace activates the bundled `zeebe-bpmn-moddle`
descriptor automatically:

```sh
bpmn-cli inspect "model.bpmn" --profile zeebe --json
bpmn-cli inspect "model.bpmn" --no-auto-profile --json
bpmn-cli inspect "model.bpmn" --extension custom="descriptor.json" --json
```

`--extension` is repeatable and accepts data-only moddle descriptors. Missing,
invalid, malformed, duplicate, or namespace-colliding descriptors fail
explicitly.

## Bounded and offline output

Default stdout is limited to 32 KiB. JSON is compact unless `--pretty` is used.
Interactive JSON includes only `schemaVersion`, `view`, the requested semantic
payload, context, paging data, and non-empty analysis. The model catalog reports
active profiles once; targeted views do not repeat them.

Request source provenance, the model-wide semantic hash, full profile details,
and empty diagnostics explicitly:

```sh
bpmn-cli inspect "model.bpmn" --element Task_1 --json --metadata
```

Scope JSONL emits independent scope, flow-element, artifact, and page records:

```sh
bpmn-cli inspect "model.bpmn" --scope Process_1 --limit 25 --jsonl
```

Complete inspection output is available only as an explicit offline artifact:

```sh
bpmn-cli inspect "model.bpmn" --process Process_1 --all --json --output "process.json"
bpmn-cli inspect "model.bpmn" --process Process_1 --all --jsonl --output "process.jsonl"
```

Output files are published atomically, never overwrite the BPMN source or a
same-file alias, and require `--force` before replacing an existing artifact.
They always include full provenance metadata.
Full JSONL element records retain complete semantic values and include stable
JSON-pointer paths for addressing.

## Discovery and help

```sh
bpmn-cli --help
bpmn-cli inspect --help
bpmn-cli trace --help
bpmn-cli lint --help
bpmn-cli diff --help
bpmn-cli edit --help
bpmn-cli layout --help
bpmn-cli help inspect
bpmn-cli help trace
bpmn-cli capabilities --json
```

Machine-readable results and errors use `schemaVersion: "1"`. `capabilities`
reports bundled engine versions and pinned commits and implemented commands.
