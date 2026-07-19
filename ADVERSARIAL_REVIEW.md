# Adversarial Production Review

This review records reproduced production failures found in `bpmn-cli`. Items
are ordered by remediation priority. The immediate release blockers are
extension profile detection in `diff` and generic extension handling in
inspection and tracing.

## 1. `diff` drops extensions introduced by the second model

**Severity:** Critical
**References:** `src/diff.ts:405`, `src/profiles.ts:83-103`

### Trigger

Run `diff` with a plain BPMN model as `before` and a model that introduces a
Zeebe or other extension namespace as `after`.

### Observed behavior

Profile detection receives the two XML documents concatenated together, while
namespace detection examines only the first `<definitions>` opening tag. The
extension descriptor is therefore loaded for neither model when the namespace
exists only in `after`.

The extension payload is omitted from the semantic diff without a diagnostic.
Reversing the arguments loads the profile and changes both the reported
semantic value and semantic hash. The same file therefore has an
argument-position-dependent semantic hash.

### Production impact

An agent cannot reliably review a change that introduces extension behavior.
The command hides the behavior being added and violates the deterministic hash
and no-silent-data-loss contracts.

### Remediation

Detect profiles independently for both documents and load the union for both
models. Do not infer the union by concatenating XML strings.

### Acceptance criteria

- A namespace declared only by `after` is active for the comparison.
- Extension values introduced by `after` appear in the semantic diff.
- A model's semantic hash is independent of whether it is the first or second
  argument.
- Swapping arguments produces an inverse semantic diff, not different semantic
  projections.
- Missing or unsupported extension descriptors produce explicit diagnostics
  rather than silent omission.

## 2. Generic extension elements crash inspection and tracing

**Severity:** Critical
**References:** `src/semantic.ts:387`, `src/trace-graph.ts:874`,
`src/trace-graph.ts:916`, `src/inspect.ts:742-748`

### Trigger

Inspect or trace an element containing an unregistered extension element, for
example:

```xml
<bpmn:extensionElements>
  <foo:customData />
</bpmn:extensionElements>
```

### Observed behavior

Several graph walkers iterate `current.$descriptor.properties` without checking
whether it is an array. Generic moddle elements do not provide that array.

`inspect --element`, `inspect --process`, and `inspect --process --all` fail
with `TypeError: current.$descriptor.properties is not iterable`. Inspection
misclassifies the exception as `INVALID_CURSOR`; tracing emits an uncaught Node
stack trace.

### Production impact

Common vendor-specific BPMN files cannot be inspected or traced. The failure
also prevents agents from discovering the unsupported data and deciding which
descriptor to load.

### Remediation

Apply the generic-element guards already used by `collectElements` and
`projectElement` to `referenceElements`, `referencedRootElements`, and
`relatedReferences`. Restrict `INVALID_CURSOR` to cursor validation failures
and provide a stable internal error envelope for unexpected failures.

### Acceptance criteria

- Generic extension elements never cause an uncaught exception.
- Inspection and tracing return the supported semantic model plus an
  `UNSUPPORTED_EXTENSION_DATA` diagnostic.
- `INVALID_CURSOR` is emitted only for malformed, stale, or incompatible
  cursors.
- Element, process, complete-process, and trace paths share regression
  coverage.

## 3. Report failure leaves an edit applied despite a failure exit

**Severity:** High
**References:** `src/edit.ts:565-607`

### Trigger

Apply a valid edit while requesting a report at an unwritable path:

```sh
bpmn-cli edit model.bpmn --request edit.json \
  --apply-unreviewed --report missing-directory/report.json --json
```

### Observed behavior

The BPMN destination is published before the report. If report publication
fails, the command exits with code `2` and `REPORT_WRITE_FAILED`, but the source
or requested BPMN output has already changed. The error does not state that the
primary artifact was published.

### Production impact

Automation interprets the command as a failed, unapplied transaction even
though persistent state changed. Recovery and retries become ambiguous, which
violates the command's atomic-publication contract.

### Remediation

Prefer validating and publishing the report before committing the BPMN
destination, or stage both outputs and use a publication protocol with an
explicit commit point. If atomic publication across both artifacts is not the
contract, report the BPMN publication state unambiguously and document the
weaker guarantee.

### Acceptance criteria

- A failure exit before the transaction commit leaves the BPMN destination
  unchanged.
- Every error after BPMN publication explicitly reports the published
  destination and resulting semantic hash.
- Tests cover successful BPMN publication followed by report publication
  failure for both in-place and `--output` workflows.

## 4. Error and cancel end events are reported as normal completion

**Severity:** High
**References:** `src/trace-graph.ts:233-248`

### Trigger

Trace through a subprocess whose only terminal node is an error or cancel end
event and which also has a normal outgoing sequence flow.

### Observed behavior

The primary completion filter excludes error and cancel end events, but the
fallback for nodes without outgoing sequence flows adds them back. Trace output
then reports a normal scope completion transition from the throwing end event
to the subprocess and its downstream flow.

### Production impact

The trace claims a normal route that BPMN execution semantics do not allow.
Agents may reason that downstream work executes after an error instead of
following a boundary handler or propagating the error.

### Remediation

Exclude error and cancel end events from both normal completion selection and
fallback selection. Model their propagation through the appropriate handler
transitions.

### Acceptance criteria

- Error and cancel end events never create normal scope-completion transitions.
- A caught error reaches the matching boundary or event-subprocess handler.
- An uncaught error does not reach the subprocess's normal outgoing flow.
- Regression fixtures cover error-only, cancel-only, caught, and uncaught
  termination.

## 5. Complete traces can overflow the JavaScript call stack

**Severity:** Medium
**References:** `src/trace-graph.ts:1249-1297`

### Trigger

Run `trace --all` on a model with a sufficiently long sequence-flow chain. A
linear model of approximately 6,000 tasks reproduced the failure.

### Observed behavior

The recursive Tarjan implementation uses call-stack depth proportional to the
longest path and throws `RangeError: Maximum call stack size exceeded`. The
exception is not converted to a structured trace error.

### Production impact

The explicit large-model/offline workflow crashes with an implementation stack
trace rather than producing an artifact or a stable diagnostic.

### Remediation

Replace recursive strongly connected component traversal with an iterative
implementation using an explicit stack.

### Acceptance criteria

- `trace --all` handles a linear model substantially larger than 6,000 nodes
  without stack overflow.
- Cycle output remains deterministic and equivalent to the current algorithm.
- Resource-limit failures use a stable diagnostic and exit code.

## 6. Non-forced output depends on hard-link support

**Severity:** Medium
**Reference:** `src/output.ts:86`

### Trigger

Write a new `--output` or `--report` destination on a filesystem without hard
links, including common exFAT, SMB, and FUSE configurations.

### Observed behavior

The no-overwrite publication path creates a temporary file and then calls
`fs.link()`. A valid, non-existing destination fails with `EPERM` or `ENOTSUP`
when the filesystem does not support hard links.

### Production impact

Otherwise valid commands fail based on storage implementation. This is
especially likely for shared folders and removable media used to exchange BPMN
artifacts.

### Remediation

Use an atomic exclusive-create strategy that does not require hard links, or
provide a safe fallback preserving the no-overwrite guarantee.

### Acceptance criteria

- New destinations can be written without hard-link support.
- A concurrent destination creation is never overwritten.
- Existing destinations still require `--force`.
- Source aliases remain rejected.

## 7. Element and scope diagnostics are duplicated

**Severity:** Low
**References:** `src/semantic.ts:212`, `src/semantic.ts:227`,
`src/semantic.ts:807-810`, `src/semantic.ts:862-866`

### Trigger

Inspect an element or scope containing unsupported extension data, such as an
unregistered extension attribute.

### Observed behavior

Model-wide projection diagnostics are combined with diagnostics from projecting
the selected view. Identical `UNSUPPORTED_EXTENSION_DATA` records are emitted
twice and counted twice.

### Production impact

Diagnostic counts are inaccurate, and consumers cannot distinguish separate
problems from duplicate reporting of one problem.

### Remediation

Deduplicate diagnostics by their stable semantic identity, or avoid re-adding
view diagnostics already included by the model-wide projection.

### Acceptance criteria

- Each distinct diagnostic appears exactly once in an element or scope result.
- Ordering remains deterministic.
- Tests assert exact diagnostic arrays and counts rather than membership only.

## Recommended implementation order

1. Fix profile unioning in `diff`.
2. Make all semantic walkers safe for generic extension elements and correct
   internal error classification.
3. Define and enforce the edit/report publication transaction contract.
4. Correct error and cancel scope transitions.
5. Replace recursive complete-trace cycle detection.
6. Make exclusive output publication portable.
7. Deduplicate diagnostics.

## Review scope

The review covered mutation planning and application, semantic projection,
inspection, tracing, profile loading, diffing, layout, lint integration, CLI
error contracts, and filesystem publication. Targeted adversarial fixtures
reproduced every issue above. Mutation preconditions, stale-plan binding,
reference normalization, malformed edit paths, semantic DI invariance, and
source-alias rejection otherwise failed closed in the exercised cases.
