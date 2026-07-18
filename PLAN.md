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

**Status:** complete.

The bounded, BPMN-native Trace v1 contract below is implemented. Safe mutation
remains gated by its own approved contract.

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

## Trace v1

### Goal

Connect the exact semantic pieces exposed by `inspect` into a bounded graph that
lets an agent answer:

- what modeled behavior can occur before or after an element;
- which modeled routes connect two elements;
- which branches, handlers, nested scopes, loops, outcomes, origins, and
  communications participate;
- what behavior may be affected by a future edit.

Trace reports modeled possibilities. It does not simulate execution, evaluate
conditions, infer business intent, predict runtime data, or replace validation.

### User contract

```text
# Forward reachable graph
bpmn-cli trace <file> --from <flow-node-or-sequence-flow-id>

# Backward prerequisite graph
bpmn-cli trace <file> --to <flow-node-or-sequence-flow-id>

# All modeled routes connecting two elements
bpmn-cli trace <file> --from <id> --to <id>

# Explicitly cross participant boundaries
bpmn-cli trace <file> --from <id> --follow-message-flows

# Bounded structured output
bpmn-cli trace <file> --from <id> --limit 50 --json
bpmn-cli trace <file> --from <id> --json --pretty
bpmn-cli trace <file> --from <id> --json --metadata

# Full offline graph
bpmn-cli trace <file> --from <id> --all --json --output <path>

# Profile control, identical to inspect
bpmn-cli trace <file> --from <id> --profile zeebe
bpmn-cli trace <file> --from <id> --no-auto-profile
bpmn-cli trace <file> --from <id> \
  --extension <name>=<descriptor.json>
```

The frozen Trace v1 options are:

- exactly one or both of `--from <id>` and `--to <id>`;
- `--follow-message-flows`;
- `--limit <1..100>`, default `50`;
- `--json`, `--pretty`, and `--metadata`;
- `--profile zeebe`, `--no-auto-profile`, and repeatable `--extension`;
- `--all`, `--output <path>`, and `--force`;
- `-h` and `--help`.

Option validity is explicit:

- at least one of `--from` and `--to` is required unless `--help` is present;
- `--help` succeeds without a file or selectors and ignores no other invalid
  options;
- `--limit` must be an integer from 1 through 100;
- `--all` and `--limit` are mutually exclusive;
- `--all` requires `--json` and `--output`;
- `--output` requires `--json`; bounded JSON may also be written without
  `--all`;
- `--pretty` and `--metadata` require `--json`;
- `--force` requires `--output`;
- `--follow-message-flows` is required when either selected endpoint is a
  MessageFlow.

Trace v1 has no direction flag, cursor, JSONL format, scope selector, runtime
variable input, or condition evaluator. Direction follows the selectors:

- `--from`: forward;
- `--to`: backward;
- `--from` plus `--to`: connecting.

Valid endpoints are FlowNodes and SequenceFlows. MessageFlows are valid only
when `--follow-message-flows` is enabled. Other addressable BPMN elements fail
with an actionable selector diagnostic.

### Graph contract

The result is a reachable subgraph, not an enumeration of complete paths.
Branches, joins, and loops remain shared graph structure.

```json
{
  "schemaVersion": "1",
  "view": "trace",
  "trace": {
    "mode": "forward",
    "fromRef": "Activity_1",
    "scopes": [
      {
        "scope": {
          "$type": "bpmn:Process",
          "id": "Process_1"
        },
        "flowElements": [],
        "laneSets": [],
        "artifacts": []
      }
    ],
    "participants": [],
    "messageFlows": [],
    "rootElements": []
  },
  "analysis": {
    "frontierRefs": [],
    "truncated": false
  }
}
```

`trace.mode` is `forward`, `backward`, or `connecting`. `fromRef` and `toRef`
are present when selected.

Each scope:

- preserves the process/subprocess hierarchy;
- uses a compact descriptor-faithful `scope` projection;
- keeps one BPMN-native `flowElements` collection in moddle/XML order;
- keeps SequenceFlows inside `flowElements`; consumers distinguish entries by
  `$type`;
- includes only relevant Lane summaries, preserving their filtered
  `flowNodeRef` values.

`rootElements` contains only referenced semantic roots needed to interpret the
emitted graph, such as Error, Escalation, Signal, and Message definitions. It
does not duplicate Process or Collaboration containers.

Do not introduce generic `nodes`, `edges`, or `transitions`. SequenceFlows keep
`sourceRef`, `targetRef`, and exact `conditionExpression`; BoundaryEvents keep
`attachedToRef` and `cancelActivity`; MessageFlows keep `sourceRef` and
`targetRef`. Derived facts never modify BPMN projections.

Compact projections include the business semantics required to understand the
graph: identity, name, references, gateway defaults and conditions, event
definitions, handler semantics, subprocess characteristics, and loop
characteristics. Bulky documentation, complete execution configuration, and
unrelated extension data remain available through `inspect --element`.

Each unique addressable semantic BPMN element counts once against the element
budget. Contained details such as EventDefinitions travel with their parent and
do not consume separate budget entries.

Required context consists of the selected endpoint(s), every ancestor
Process/SubProcess needed to represent their scope hierarchy, and, for a
connected result, the mandatory complete route. Required elements count against
`--limit`. If required context alone exceeds the selected limit, return
`TRACE_CONTEXT_TOO_LARGE` or `TRACE_ROUTE_TOO_LARGE` without partial output.
Scope projections duplicated as wrappers and parent `flowElements` count once.

Related DataObjects, DataObjectReferences, and DataStoreReferences remain in
their BPMN-native `flowElements` collection. Exact `dataInputAssociations`,
`dataOutputAssociations`, and other descriptor-defined data-association
properties remain on their owning compact element. Relevant Associations and
TextAnnotations remain under each scope's BPMN-native `artifacts`. Trace does
not introduce a generic data wrapper.

### Analysis contract

Derived facts are isolated under `analysis`:

- `connected` for connecting traces;
- `branches`, referencing gateway and SequenceFlow IDs and classifying each as
  `conditioned`, `default`, or `unconditional`;
- `eventTransitions` for Link, Error, Escalation, Signal, and compensation
  semantics;
- `scopeTransitions` for derived subprocess entry and completion;
- `sequenceFlowCycles` for cyclic graph regions;
- `activityLoops` for standard-loop and multi-instance characteristics;
- `adHocScopes` for otherwise available AdHocSubProcess activities;
- `endEventRefs` and `deadEndRefs` for forward outcomes;
- `startEventRefs` and `sourceElementRefs` for backward origins;
- `frontierRefs` and `truncated`;
- non-empty relevant `diagnostics`.

Derived record shapes are frozen:

```text
branches:
  { gatewayRef, sequenceFlowRef, kind }

eventTransitions:
  { kind, sourceRef, targetRef, scopeRef? }
  kind = boundary | eventSubprocess | link | error | escalation |
         signal | compensation

scopeTransitions:
  { kind, scopeRef, sourceRef, targetRef }
  kind = entry | completion

sequenceFlowCycles:
  { scopeRef, flowElementRefs, sequenceFlowRefs }

activityLoops:
  { elementRef, loopCharacteristics }

adHocScopes:
  { scopeRef, availableActivityRefs }
```

All `*Ref` fields contain exact BPMN IDs. `loopCharacteristics` is a compact
descriptor-faithful projection. Diagnostics retain the Inspect v1 diagnostic
shape.

Empty optional analysis collections are omitted. Analysis describes only the
emitted subgraph when truncated. `connected` is the exception: it is an exact
whole-model fact computed before output limiting.

When both endpoints exist but no modeled route connects them, Trace succeeds
with `analysis.connected: false` and empty `scopes` and `messageFlows`;
`fromRef` and `toRef` still identify the request. The endpoint-reservation rule
applies only to connected results. Missing, ambiguous, or unsupported endpoints
are command errors.

Exact condition bodies and gateway default references are preserved. Trace
never translates expressions into prose or claims that a branch will execute.

### Traversal semantics

#### Sequence flow

- Typed adjacency alternates `FlowNode -> SequenceFlow -> FlowNode`.
- Forward traversal from a FlowNode visits each outgoing SequenceFlow, then its
  `targetRef`. Backward traversal visits each incoming SequenceFlow, then its
  `sourceRef`.
- Forward traversal from a selected SequenceFlow includes that SequenceFlow and
  continues at its `targetRef`; it does not add `sourceRef` unless another
  selected relation reaches it. Backward traversal is symmetric.
- BFS depth increases on every typed adjacency step. Collection order breaks
  ties at equal depth.
- A connecting graph is the intersection of elements reachable forward from
  `--from` and backward from `--to`.
- Connecting mode first computes a deterministic shortest complete route using
  typed BFS and BPMN collection-order tie breaking. That route is mandatory.
- If the mandatory route contains more unique elements than `--limit`, return
  `TRACE_ROUTE_TOO_LARGE`; do not emit a disconnected fragment.
- After the mandatory route, spend the remaining budget breadth-first on
  alternate connecting routes. An untruncated result contains every modeled
  connecting route; a truncated result contains one complete route plus
  coherent alternate-route fragments ending at `frontierRefs`.

#### Nested scopes

- Preserve scope hierarchy; never flatten subprocess contents into the parent.
- For an ordinary embedded SubProcess, entry transitions run from the
  SubProcess element to each contained non-event-subprocess StartEvent. If no
  StartEvent exists, contained FlowNodes without incoming SequenceFlows are
  entry targets.
- Completion transitions run from contained EndEvents to the SubProcess
  element, after which traversal may use the SubProcess's parent-scope outgoing
  SequenceFlows. If no EndEvent exists, contained FlowNodes without outgoing
  SequenceFlows are completion sources.
- Backward traversal uses the exact inverse of these entry and completion
  relations. Connecting traversal uses them in both reachability sets.
- Put derived entry/completion relationships under
  `analysis.scopeTransitions`; never invent SequenceFlows.
- Triggered event subprocesses do not receive ordinary entry/completion
  transitions and never continue through the parent SubProcess's outgoing
  SequenceFlows. For each triggered event subprocess, create one scope-level
  `eventSubprocess` transition from its containing scope to each contained
  StartEvent. A scope is active context when the emitted graph contains any
  FlowNode directly or transitively contained by it; its triggered event
  subprocess alternatives are therefore included subject to the same element
  budget. Do not create edges from ordinary parent elements.
- AdHocSubProcesses preserve modeled SequenceFlows, list otherwise available
  FlowNodes without modeled incoming dependencies as available activities, and
  expose exact ordering and completion conditions. Do not derive transitions
  between otherwise unordered activities. Completion is a typed transition
  from the AdHocSubProcess itself into its parent continuation, not a claim that
  any particular internal activity completed it.

#### Boundary events and handlers

- Each BoundaryEvent creates a typed transition from its exact `attachedToRef`
  activity to the BoundaryEvent. Forward traversal from the activity includes
  this relation and the BoundaryEvent's outgoing SequenceFlows. Backward
  traversal uses the inverse.
- Preserve interrupting/non-interrupting behavior through exact
  `cancelActivity`.
- Resolve thrown Error and Escalation events to matching boundary or
  event-subprocess handlers using these rules:
  - a handler with an exact `errorRef`/`escalationRef` matches the same root
    element identity;
  - an omitted catch reference is catch-all for that event kind;
  - an eligible BoundaryEvent must be attached to the activity containing the
    throw or to one of that activity's enclosing SubProcesses; a sibling
    activity's BoundaryEvent is never eligible;
  - an eligible event-subprocess handler must be directly contained by the
    throwing scope or one of its enclosing scopes;
  - search eligible handlers from the innermost containing activity/scope
    outward;
  - stop Error propagation at the first enclosing scope containing any matching
    handler;
  - stop Escalation propagation at the first enclosing scope containing any
    matching handler;
  - never match by name or error/escalation code text alone.
- Keep these derived handler relationships under `analysis.eventTransitions`.

#### Other events

- Link transitions use the loaded descriptor's exact
  `LinkEventDefinition.target`/`source` references. Do not infer links by display
  name when those references are unresolved.
- Signal transitions require the same resolved root `signalRef`. Follow matching
  catches within the current Process. Cross-process matches may be reported as
  related transitions but are not traversed.
- Equal `messageRef` values do not invent communication links. Cross-participant
  message traversal requires an explicit MessageFlow.
- Compensation with an explicit `activityRef` targets only that activity's
  compensation handler. When `activityRef` is absent, report a scope-level
  compensation alternative but do not choose runtime-dependent completed
  activities. Compensation relationships are never ordinary SequenceFlow
  successors.

#### Collaboration

- Related MessageFlows appear as BPMN-native typed communication relationships
  by default.
- Every emitted MessageFlow endpoint that is a Participant appears once in the
  top-level BPMN-native `participants` collection as a compact descriptor
  projection. Participants count against the element budget.
- Participant endpoints are atomic companion context for an emitted
  MessageFlow. Reserve the MessageFlow and all Participant endpoints together.
  If a selected MessageFlow and its required companions exceed `--limit`,
  return `TRACE_CONTEXT_TOO_LARGE`. For a non-selected related MessageFlow that
  does not fit with its companions, omit the entire relationship and place its
  MessageFlow ID in `frontierRefs`.
- Do not recursively traverse into another participant unless
  `--follow-message-flows` is present.
- Following a MessageFlow continues only when its exact receiving endpoint is a
  FlowNode. A Participant endpoint is terminal even when it has `processRef`;
  Trace never invents a Process entry FlowNode.
- A selected MessageFlow follows its `targetRef` in forward mode and
  `sourceRef` in backward mode. The MessageFlow itself remains in the
  collaboration-level `messageFlows` collection.

#### Data and lanes

- Data associations and artifacts are not traversal edges. Include only those
  referenced by, owned by, or directly associated with emitted flow elements.
- Defer complete values to `inspect --element`.
- Preserve relevant Lane responsibility through Lane summaries and filtered
  `flowNodeRef` values.

### Loops, branches, origins, and outcomes

- Emit each element once; never unroll a loop.
- Identify SequenceFlow cycles as cyclic regions with element and flow
  references.
- Report standard-loop and multi-instance activity characteristics separately
  from SequenceFlow cycles.
- Forward traces list reachable EndEvents separately from non-event dead ends.
- Backward traces list reachable StartEvents separately from non-event source
  elements.
- A bounded frontier is not an outcome or origin.

### Ordering, bounds, and continuation

- Traverse breadth-first from the selected endpoint.
- Preserve BPMN collection order among elements discovered at the same depth.
- Serialize scopes in discovery order and each scope's `flowElements` in
  original semantic order.
- Default to 50 unique addressable elements; allow at most 100 on stdout.
- Continue enforcing the shared 32 KiB stdout budget.
- If the graph exceeds either budget, stop deterministically and return
  `truncated: true` plus exact `frontierRefs`.
- `frontierRefs` contains every omitted element directly adjacent through an
  enabled typed traversal relation to the emitted graph. Order by emitted
  source discovery order, then relationship kind order, then original BPMN
  collection order; deduplicate by first occurrence.
- Follow-up traces start from frontier IDs; Trace v1 does not page one graph.
- Never emit partial JSON, split a semantic record, silently truncate exact
  conditions, or classify a frontier as a dead end.
- Connected connecting traces always include both requested endpoints as part
  of the mandatory complete route.
- `--all` requires structured `--output`; it is never emitted to stdout.
- The 32 KiB cap applies to the complete serialized envelope, including
  analysis and frontier IDs. If one compact semantic record, the mandatory
  connecting route, or the exact frontier cannot fit, return
  `OUTPUT_TOO_LARGE` without partial output and direct the caller to `--output`
  or `--all --output`.

### Formats and provenance

- Default text is concise and derived from the same bounded graph as JSON.
- JSON is one compact, atomic, versioned document; `--pretty` opts into
  indentation.
- JSONL is excluded because a graph must remain atomic to preserve shared
  relationships.
- Default structured stdout follows Inspect v1's minimal metadata policy.
- `--metadata` restores source, semantic hash, profiles, and complete diagnostic
  metadata.
- Structured output files always contain full provenance, are published
  atomically, never alias the BPMN source, and require `--force` to replace an
  existing file.

Diagnostics are limited to included elements/scopes, traversal truncation, and
global parse/profile findings that make interpretation incomplete. Unrelated
whole-model diagnostics do not consume trace context.

### Error and exit contract

- Exit `0`: trace succeeds, including disconnected results and warnings.
- Exit `1`: invalid options, selectors, endpoint types, limits, output
  combinations, `TRACE_CONTEXT_TOO_LARGE`, `TRACE_ROUTE_TOO_LARGE`, or
  `OUTPUT_TOO_LARGE`.
- Exit `2`: source, descriptor-file, or output-file I/O failure.
- Exit `3`: invalid descriptor content, moddle construction failure, BPMN parse
  failure, or duplicate-ID model integrity failure.
- Successful results go to stdout unless `--output` is used.
- Machine-readable errors remain atomic and versioned.

### Architecture

Reuse the implemented Inspect v1 foundation:

1. profile resolution and exact source loading;
2. descriptor-driven projection and hard exclusions;
3. semantic indexing by ID, process, scope, containment, and references;
4. output budgets, metadata policy, errors, and atomic file writes.

Add focused modules for:

1. typed BPMN adjacency construction;
2. conservative event and scope transition resolution;
3. forward, backward, and connecting graph selection;
4. breadth-first budgeting and frontier calculation;
5. cycle, branch, origin, outcome, and relevance analysis;
6. trace-specific compact projection and rendering.

Traversal must operate on typed semantic relationships, not serialized JSON or
XML text. Rendering must not read raw moddle objects directly.

### Test strategy

The two real-life fixtures are primary acceptance tests:

- `AI Email Support Agent.bpmn` covers exact gateway conditions, default flows,
  the `query_knowledge_base` Error BoundaryEvent, triggered event subprocess
  `Activity_0sw5ued`, nested scope traversal, and AdHocSubProcess
  `Activity_04glkkx`;
- `car rental booking process.bpmn` covers 218 semantic elements, four
  Participants, 14 MessageFlows, one executable process participant, three
  black-box pools, Messages, default non-following behavior, and explicit
  `--follow-message-flows`.

Concrete acceptance traces include:

```text
# Exact boundary handler
trace "AI Email Support Agent.bpmn" --from query_knowledge_base --json
  includes Event_1wezv96, Error_1xmh0a2, Flow_137dks7, and Event_0wh5ha7
  includes boundary eventTransition query_knowledge_base -> Event_1wezv96

# Exact conditioned branches
trace "AI Email Support Agent.bpmn" --from Gateway_1whb5u5 --json
  includes Flow_1mudddl and Flow_0lexqwn with exact condition bodies

# Triggered event subprocess and AdHoc scope behavior
trace "AI Email Support Agent.bpmn" --from Activity_04glkkx --json
  preserves Activity_04glkkx as AdHocSubProcess
  exposes Activity_0sw5ued only through a scope-level event-subprocess trigger

# Black-box communication remains terminal by default
trace "car rental booking process.bpmn" --from Event_1k76lxn --json
  reports related Flow_05wzjkc but does not traverse Participant_0eew51h

# Explicit collaboration traversal
trace "car rental booking process.bpmn" --to Event_1k76lxn \
  --follow-message-flows --json
  includes Flow_05wzjkc and black-box Participant_0eew51h as a terminal endpoint

# Disconnected contract
trace "AI Email Support Agent.bpmn" \
  --from Event_0wh5ha7 --to Event_1wezv96 --json
  exits 0 with connected=false and empty scopes/messageFlows
```

Deterministic limiting uses a hand-reviewed focused fixture:

```text
Process_1
  Start_1 -> Flow_Start_Gateway -> Gateway_1
  Gateway_1 -> Flow_A -> Task_A
  Gateway_1 -> Flow_B -> Task_B
  Gateway_1 -> Flow_C -> Task_C

trace fixture --from Start_1 --limit 5 --json
  required Process_1 context counts once
  emits Start_1, Flow_Start_Gateway, Gateway_1, Flow_A
  returns frontierRefs [Flow_B, Flow_C, Task_A]
  returns truncated=true
```

The fixture's XML orders `Flow_A`, `Flow_B`, then `Flow_C`. This test freezes
required-context accounting, typed adjacency, equal-depth collection ordering,
frontier ordering, and deduplication independently of implementation output.

Small synthetic fixtures are allowed only to isolate semantics absent from the
real models, including Link transfers, propagated Error/Escalation handlers,
Signal relationships, compensation, graph cycles, and loop/multi-instance
characteristics.

Focused tests must cover:

- forward, backward, connecting, and disconnected selection;
- all connecting routes rather than only the shortest route;
- compact descriptor-faithful projections and no generic graph vocabulary;
- nested scope hierarchy and explicit scope transitions;
- boundary, event-subprocess, Link, Error, Escalation, Signal, and compensation
  behavior;
- exact branch conditions and conservative classifications;
- MessageFlow visibility, opt-in following, and black-box termination;
- Lane and related-data context without traversal;
- deterministic breadth-first limiting, endpoint reservation, frontier
  continuation, and 32 KiB enforcement;
- SequenceFlow cycles versus activity loop characteristics;
- origins, outcomes, diagnostics relevance, and truncation correctness;
- minimal metadata, `--metadata`, full output artifacts, overwrite/source
  safety, streams, exit codes, help, and capabilities;
- DI, color, template-icon, formatting, and namespace-prefix invariance;
- all existing Inspect v1 regression tests.

### Acceptance gate

Trace v1 is complete when:

- both real-life models can be reasoned about through bounded trace calls;
- forward, backward, and connecting graphs are semantically correct and
  deterministic;
- nested scopes, handlers, event transitions, loops, MessageFlows, lanes, and
  data references follow the approved rules without invented BPMN semantics;
- default output remains within 50 elements and 32 KiB, with exact frontiers;
- complete output is available only through a source-safe offline artifact;
- output contains no generic node/edge schema or presentation data;
- help and capabilities match the implemented command exactly;
- focused behavior tests and all Inspect v1 regressions pass;
- typecheck, lint, standard tests, and coverage tests pass.
