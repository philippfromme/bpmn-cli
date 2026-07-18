# bpmn-cli

Agent-first Node.js CLI for bounded, descriptor-faithful inspection and trace
analysis of BPMN business semantics. Diagram Interchange, colors, and
presentation-only modeler data are excluded.

Mutation is intentionally unavailable. Its contract remains gated by
[PLAN.md](PLAN.md) and the agent-first principles in [AGENTS.md](AGENTS.md).

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

The default budget is 50 unique semantic elements; the maximum is 100. Bounded
results report deterministic `frontierRefs`. Complete output requires an
offline artifact:

```sh
bpmn-cli trace "model.bpmn" --from Task_1 --all --json --output "trace.json"
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
bpmn-cli help inspect
bpmn-cli help trace
bpmn-cli capabilities --json
```

Machine-readable results and errors use `schemaVersion: "1"`. `capabilities`
distinguishes implemented inspection and tracing from planned validation and
mutation commands.
