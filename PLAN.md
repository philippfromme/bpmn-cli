# BPMN CLI Plan

## Purpose

Build an agent-first Node.js CLI for understanding, creating, reviewing, and
safely editing BPMN models through the BPMN moddle ecosystem. The CLI must
expose business semantics rather than XML or diagram layout, conserve agent
context, preserve model integrity, and produce verifiable outcomes.

Repository-wide product and engineering principles are defined in
[AGENTS.md](AGENTS.md).

## Delivery gates

Implementation beyond the approved increment is gated. A phase begins only
after its contract is agreed and its predecessor's acceptance criteria pass.

## Phases

### 0. Foundation

**Status:** complete.

Node.js 20.12+ TypeScript ESM CLI package with help, version, capabilities,
build, typecheck, lint, tests, and coverage.

### 1. Semantic inspection

**Status:** complete.

The bounded, descriptor-faithful inspection contract below is implemented.

### 2. Targeted path analysis

Add `trace` only after inspection is stable. Define loop handling, path limits,
traversal direction, nested-container behavior, and truncation first.

### 3. Safe mutation

Design a versioned edit request, then implement plan, review, apply, and verify.
No mutation command or edit DSL is currently in scope.

### 4. Release hardening

Add compatibility coverage, packaging, CI, security review, and release
documentation after command contracts stabilize.

## Inspect v1

### Goal

Give an agent enough precise, bounded information to:

- identify processes, subprocesses, collaborations, and referenced roots;
- understand activities, ordering, branches, loops, and modeled outcomes;
- understand events, boundary attachments, interruption, and event subprocesses;
- understand participant communication and message flows;
- inspect exact local context for one BPMN element;
- inspect relevant Zeebe execution configuration;
- identify structural ambiguity without inventing business intent;
- retrieve large models incrementally without arbitrary line-range reading;
- ignore Diagram Interchange and presentation-only data completely.

### Core representation rule

The semantic payload is a descriptor-faithful JSON projection, not a second
hand-written BPMN schema.

1. Use `$type` as the qualified type discriminator.
2. Preserve property names from loaded moddle descriptors exactly.
3. Serialize references under their descriptor names (`sourceRef`,
   `targetRef`, `attachedToRef`, `messageRef`, `incoming`, `outgoing`) as IDs
   or ID arrays.
4. Preserve semantic containment names (`rootElements`, `flowElements`,
   `artifacts`, `eventDefinitions`, `participants`, `messageFlows`,
   `extensionElements`, `values`).
5. Recursively project contained semantic moddle elements.
6. Include effective semantic defaults so explicit and implicit defaults have
   equivalent projections and hashes.
7. Put CLI-derived navigation, paging, counts, and diagnostics only in
   `context`, `analysis`, or `page`; never mix invented fields into projected
   BPMN elements.

`$type` is an intentional public contract. It avoids collision with semantic
properties such as `zeebe:TaskDefinition.type`.

### Descriptor-driven projection

Follow the proven traversal pattern in bpmn-js `ModdleCopy`, adapted for
inspection:

```text
moddle element
  -> enumerate element.$descriptor.properties
  -> classify each qualified property
  -> copy effective primitive values
  -> normalize references to IDs
  -> recursively project contained semantic elements
  -> guard cycles by object identity
```

Do not depend on bpmn-js or copy its transport tree. Copy/paste excludes
business-critical properties such as `flowElements`, `artifacts`, `incoming`,
`outgoing`, `default`, lanes, and data associations, then reconstructs them
through diagram-js `parent`, `host`, `source`, and `target`. Inspect must retain
the BPMN descriptor names instead.

Every loaded descriptor property must be classified as:

- projected primitive;
- normalized reference;
- recursively projected semantic child;
- hard-excluded presentation property;
- unsupported semantic property with an explicit diagnostic.

A dependency update that introduces an unclassified property fails the
descriptor coverage test.

### User contract

```text
# Small model catalog
bpmn-cli inspect <file>
bpmn-cli inspect <file> --json

# Bounded process outline
bpmn-cli inspect <file> --process <process-id>
bpmn-cli inspect <file> --process <process-id> --json

# Page through one process/subprocess's direct flowElements and artifacts
bpmn-cli inspect <file> --scope <process-or-subprocess-id> --json
bpmn-cli inspect <file> --scope <id> --limit <n> --cursor <cursor> --json
bpmn-cli inspect <file> --scope <id> --limit <n> --jsonl

# Exact element plus immediate context
bpmn-cli inspect <file> --element <element-id>
bpmn-cli inspect <file> --element <element-id> --json

# Full offline artifact; never emitted unbounded to stdout
bpmn-cli inspect <file> --process <id> --all --jsonl --output <path>

# Profile control
bpmn-cli inspect <file> --profile zeebe
bpmn-cli inspect <file> --no-auto-profile
bpmn-cli inspect <file> --extension <name>=<descriptor.json>
```

Selectors are mutually exclusive. IDs match exactly; missing or ambiguous
selection fails. `--extension` is repeatable and data-only. Executable plugin
loading is out of scope.

The legacy `--include elements` prototype option has been removed.

`--all` requires `--output`; it is rejected for stdout. Output files never
modify or alias the BPMN source, are published atomically, and are not
overwritten by default.

Standard input, URLs, and directory traversal are deferred.

### Formats and output budget

- Text is concise and derived from the same bounded view as JSON.
- `--json` emits one compact atomic document; `--pretty` opts into indentation.
- Interactive structured output omits repeated source provenance, semantic
  hashes, profile details outside the model catalog, and empty diagnostics.
- `--metadata` restores the full provenance envelope for explicit verification.
- Structured `--output` artifacts always include full provenance.
- `--jsonl` emits independent records only for paged collection views or
  offline artifacts. Offline element records retain complete semantic values;
  record-envelope paths never alter BPMN properties.
- JSONL alone does not solve context pressure; pagination and targeting do.
- Default page size is 25 records; the maximum is 100.
- Default stdout budget is 32 KiB of UTF-8 JSON.
- Never emit partial JSON or split one semantic record across pages.
- If the next record exceeds the remaining budget, return a continuation
  cursor without that record.
- If one requested record exceeds the budget, return an explicit
  `OUTPUT_TOO_LARGE` diagnostic and direct the caller to `--output`.
- Never silently truncate modeled strings or expressions.

Large exact values are available through an explicit element artifact written
with `--output`. Bounded stdout views may omit them only when `analysis`
identifies the exact property path, byte count, hash, and omission reason.

### Cursor contract

Cursors are opaque and bind to:

- source SHA-256;
- schema version;
- selector and selected ID;
- deterministic property/order;
- current offset.

Reusing a cursor after the BPMN file changes fails explicitly. Pages preserve
moddle/XML semantic order and contain no duplicates or gaps.

### Default JSON envelope

```json
{
  "schemaVersion": "1",
  "view": "element",
  "element": {},
  "context": {}
}
```

`view` is `model`, `process`, `scope`, or `element`.
Requested payload, context, paging data, and non-empty `analysis` follow the
selected view. Empty diagnostics are omitted. The model catalog includes active
profiles once because they define how the model was interpreted.

`--metadata` and structured `--output` artifacts additionally include:

```json
{
  "source": {
    "path": "test/fixtures/AI Email Support Agent.bpmn",
    "sha256": "<source-byte-hash>",
    "bytes": 1234
  },
  "semanticHash": "<canonical-business-logic-hash>",
  "profiles": [],
  "analysis": {
    "diagnostics": []
  }
}
```

`source.sha256` hashes exact source bytes. `semanticHash` hashes the canonical
descriptor-faithful semantic projection after hard exclusions. It is unchanged
by XML formatting, namespace-prefix choices, DI, colors, or template icons.

### Model view

The default response is a catalog, not a model dump. For the system acceptance
fixture it must expose:

- definitions identity and target namespace;
- process `Process_0j5qzil`;
- root `Escalation_1qaovql`, `Error_1xmh0a2`, and two Messages;
- 76 semantic BPMN elements and 26 SequenceFlows;
- nested container IDs and direct element counts;
- active profiles and structural diagnostics.

Process and collaboration entries contain IDs, names, executable status,
counts by `$type`, direct `flowElements` count, nested container IDs, and
relevant root references. They do not contain full elements or extension data.

### Process view

`--process` is a bounded outline. It returns:

- a descriptor-faithful shallow `bpmn:Process` projection;
- each contained Process/SubProcess/AdHocSubProcess/Transaction as a container
  summary;
- counts by `$type`, condition count, artifact count, and referenced roots;
- start/end event IDs and diagnostics under `analysis`;
- relevant collaboration summaries.

For `Process_0j5qzil`, the outline must identify:

- 30 direct `flowElements`;
- `Activity_04glkkx` (`bpmn:AdHocSubProcess`) with 23 direct `flowElements`;
- `Activity_0sw5ued` (`bpmn:SubProcess`, `triggeredByEvent: true`) with five
  direct `flowElements`;
- five ExclusiveGateways, six conditioned SequenceFlows, two BoundaryEvents,
  three Associations, and three TextAnnotations across the process tree.

The process view does not inline every `flowElement`, complete documentation,
I/O mapping, task header, or extension value.

### Scope view

`--scope` selects a `bpmn:Process` or any BPMN element implementing
`FlowElementsContainer`. It pages that element's direct `flowElements`.

Each returned record:

- contains `$type`, `id`, and populated business properties required to
  understand control flow;
- preserves `incoming`, `outgoing`, `sourceRef`, `targetRef`, `default`,
  `attachedToRef`, `eventDefinitions`, and exact condition expressions;
- summarizes nested `flowElements` and bulky extension content rather than
  recursively expanding them;
- identifies omitted exact values under `analysis`.

The payload collection is named `flowElements`, matching the descriptor.
Paging metadata is isolated under `page`.

### Element view

`--element` returns:

- a descriptor-faithful projection of the selected semantic element;
- its containing Process/SubProcess under `context.containerRef`;
- owning process under `context.processRef`;
- immediate referenced incoming/outgoing SequenceFlows;
- immediate source/target elements for a selected SequenceFlow;
- attached BoundaryEvents or `attachedToRef` activity where applicable;
- resolved Message, Error, Escalation, Signal, and DataObject references;
- supported Zeebe execution data.

Derived predecessor/successor or reachability information belongs under
`analysis`, never inside the projected BPMN element.

No recursive graph expansion occurs. Bounded path traversal belongs to `trace`.

### Boundary and event semantics

Boundary events remain ordinary descriptor-faithful `bpmn:BoundaryEvent`
records with `cancelActivity`, `attachedToRef`, `eventDefinitions`, `incoming`,
and `outgoing`. Do not introduce a separate `handler` abstraction.

Event subprocesses remain `bpmn:SubProcess` elements with
`triggeredByEvent`; their contained StartEvent carries `isInterrupting` and its
`eventDefinitions`.

Preserve Message, Timer, Error, Escalation, Signal, Conditional, Link,
Terminate, Cancel, and Compensation event-definition properties exactly.

### Collaboration semantics

Collaborations retain descriptor names:

- `participants`;
- `messageFlows`;
- `artifacts`;
- conversation-related properties when present.

Participants retain `processRef`. MessageFlows retain `sourceRef`,
`targetRef`, and `messageRef`. Do not merge MessageFlows with SequenceFlows or
rename both as generic transitions.

The model view summarizes collaborations. Selecting a Collaboration through
`--element` returns its bounded descriptor projection and relevant reference
context. A realistic multi-participant collaboration fixture is required;
toy collaboration examples are not acceptance evidence.

### Zeebe semantics

The built-in `zeebe` profile uses the pinned `zeebe-bpmn-moddle` descriptor. It
is selected explicitly with `--profile zeebe` or auto-detected from the exact
namespace `http://camunda.org/schema/zeebe/1.0`. `--no-auto-profile` disables
detection. Activation source is observable.

Registered Zeebe extension elements use `$type` and exact descriptor property
names. Scope/process views summarize extension types and counts. Element views
project supported extension content within the output budget. Full exact
content requires `--output` when oversized.

Unknown configured extension data produces a diagnostic rather than
disappearing silently.

### Hard projection exclusions

Presentation-only data is completely ignored, not truncated or diagnosed per
occurrence. It does not affect output, counts, indexes, or `semanticHash`.

Initial hard exclusions:

- all `bpmndi`, `di`, and `dc` elements and properties;
- all `bioc` and non-normative `color` properties;
- `zeebe:modelerTemplateIcon`, including embedded data URIs.

Keep `zeebe:modelerTemplate` and `zeebe:modelerTemplateVersion` because they
identify execution configuration. Keep modeler execution-platform metadata as
source/profile context but exclude it from `semanticHash`.

Match exclusions by qualified descriptor property name or descriptor package,
never by an unqualified name.

### DI invariance

Never traverse or expose:

- `definitions.diagrams`;
- BPMN shapes, edges, labels, bounds, or waypoints;
- layout, color, or presentation metadata;
- moddle `$model`, descriptors, parents, or functions.

Parse XML normally; do not strip DI with regular expressions. Project only
semantic roots and descriptor properties allowed by policy.

Two models with identical semantics and different DI have identical semantic
payloads and hashes. Only source path, source hash, and byte size may differ.

### Diagnostics

Initial stable codes:

- `UNREACHABLE_FLOW_NODE`;
- `DEAD_END_FLOW_NODE`;
- `MISSING_START_EVENT`;
- `MULTIPLE_UNCONDITIONAL_OUTGOING`;
- `GATEWAY_BRANCH_WITHOUT_CONDITION`;
- `GATEWAY_WITHOUT_DEFAULT`;
- `UNRESOLVED_REFERENCE`;
- `UNSUPPORTED_EXTENSION_DATA`;
- `PROFILE_DISABLED_DATA_IGNORED`;
- `OUTPUT_TOO_LARGE`;
- `STALE_CURSOR`.

Diagnostics report modeled facts or likely ambiguity. They do not claim BPMN
invalidity unless a validation rule establishes it.

### Errors and streams

- Exit `0`: inspection succeeds, including warnings.
- Exit `1`: invalid options, selectors, IDs, cursor, or output combinations.
- Exit `2`: source/profile/output file failure.
- Exit `3`: descriptor or BPMN parse failure.
- Successful results go to stdout unless `--output` is used.
- Diagnostics and errors go to stderr.
- Under `--json`/`--jsonl`, errors use versioned JSON records.
- Never write progress logging to stdout.

### Architecture

```text
BPMN bytes
  -> profile resolution
  -> bpmn-moddle parse
  -> descriptor property classification
  -> descriptor-faithful semantic projection
  -> semantic/reference index
  -> structural analysis
  -> bounded model/process/scope/element view
  -> text/JSON/JSONL renderer
```

Modules:

1. `profiles`: namespace detection and data-only descriptor loading.
2. `projection-policy`: property classification and hard exclusions.
3. `project`: descriptor traversal, reference normalization, and cycle guards.
4. `index`: lookup by ID, container, process, root, and reference.
5. `analysis`: structural graph diagnostics and canonical semantic hash.
6. `views`: bounded catalog, outline, page, and element context.
7. `cursor`: stable opaque cursor encode/decode and stale-source checks.
8. `render`: deterministic text, compact JSON, and JSONL.
9. `commands/inspect`: arguments, files, budgets, errors, and streams.

No renderer reads moddle objects directly.

### Implementation slices

All slices below are complete for Inspect v1.

#### A. Contract and refactor

- Add TypeScript contracts for envelope and four views.
- Split current single-file implementation into the modules above.
- Remove `--include elements`.
- Add process/scope/element selectors and updated help.

#### B. Descriptor projector

- Implement property enumeration inspired by `ModdleCopy`.
- Normalize references while preserving descriptor property names.
- Add package/property exclusion policy and descriptor coverage tests.
- Implement canonical semantic projection and hash.

#### C. Bounded views and paging

- Implement model catalog and process outline.
- Implement scope pages, limits, cursors, compact JSON, and JSONL.
- Enforce stdout budget and `--all`/`--output` rules.
- Implement bounded element context.

#### D. BPMN relationships

- Cover nested containers, conditions, defaults, boundary attachment, events,
  artifacts, lanes, data associations, root references, and collaborations.
- Add structural diagnostics without invented intent.

#### E. Extensions and polish

- Implement exact Zeebe projection and bulky-value handling.
- Implement custom data-only descriptor loading.
- Add text rendering, JSON errors, capabilities, README, and actual examples.

### System acceptance fixture

`test/fixtures/AI Email Support Agent.bpmn` is the primary acceptance fixture,
not an illustrative example. Acceptance assertions include:

- 76 semantic BPMN elements and 26 SequenceFlows;
- six conditioned SequenceFlows with exact expression bodies;
- 30 direct process `flowElements`;
- 23 direct `flowElements` in `Activity_04glkkx`;
- five direct `flowElements` in event subprocess `Activity_0sw5ued`;
- two attached BoundaryEvents with ErrorEventDefinitions;
- five ExclusiveGateways, including default flow `Flow_0a79ens`;
- Escalation, Error, Message, and event-definition references;
- three Associations and three TextAnnotations;
- Zeebe AdHoc, FormDefinition, IoMapping, Properties, Subscription,
  TaskDefinition, TaskHeaders, and UserTask extension types;
- no `modelerTemplateIcon` key or embedded `data:image` value in any output;
- complete retrieval through bounded model, process, scope, and element calls;
- no default stdout response larger than 32 KiB;
- full artifact retrieval without semantic loss when explicitly written.

Small synthetic fixtures may isolate a single edge case, but they are not proof
that inspect handles realistic BPMN.

`test/fixtures/car rental booking process.bpmn` is the realistic collaboration
fixture. It covers four participants, one executable process reference, 14
MessageFlows, Messages, and three black-box pools.

### Invariance and regression tests

- Identical semantics with different DI, coordinates, labels, colors, template
  icons, formatting, and namespace prefixes produce identical semantic hashes.
- Changing business semantics changes the semantic hash.
- Scope pages reconstruct direct `flowElements` without gaps or duplicates.
- Cursors fail after source changes.
- References resolve correctly across nested containers and root elements.
- Unknown registered/unregistered extension behavior is explicit.
- Output ordering, budgets, streams, exits, and paths containing spaces work.
- Help, version, capabilities, profiles, and existing command behavior regressions
  remain covered.

### Acceptance gate

Inspect v1 is complete when:

- output uses descriptor names consistently and contains no generic
  node/transition schema;
- the acceptance fixture is understandable through bounded sequential calls;
- exact business properties and references are retrievable without DI;
- scope paging and JSONL support incremental agent workflows;
- element output exposes exact local and Zeebe execution context;
- descriptor coverage and DI/presentation invariance tests pass;
- no unsupported semantic extension data is silently lost;
- default output budgets are enforced without truncating records;
- help and capabilities match actual behavior;
- typecheck, lint, standard tests, and coverage tests pass.
