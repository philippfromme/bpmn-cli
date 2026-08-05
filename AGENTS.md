# AGENTS.md

## Product principle

`bpmn-cli` exists to help software agents create and safely modify better BPMN
models through a fluent TypeScript API.

Every product, API, architecture, and implementation decision must be evaluated
against that purpose. Prefer the option that gives an agent accurate semantic
context, predictable control, and verifiable outcomes with the least context
window usage and operational risk.

If a feature is convenient for humans but ambiguous, verbose, unstable, or
unsafe for agents, redesign it rather than making the agent compensate.

## Decision rubric

When choosing between approaches, prioritize in this order:

1. Semantic correctness of the BPMN model.
2. Safe and reviewable changes.
3. Deterministic, machine-readable behavior.
4. Efficient use of an agent's context window.
5. Precise diagnostics and recoverability.
6. Human usability.
7. Implementation convenience.

Document meaningful tradeoffs with the relevant contract, tests, and user
documentation. Do not expand mutation behavior until its contract and safety
properties are approved.

## Agent-first library contract

- The public TypeScript API must use semantic BPMN operations rather than XML,
  JSON Pointers, or generic mutation operations.
- Preserve stable exported types, error codes, method names, and publication
  result fields as public APIs.
- Prefer exact element lookup and focused extension builders over broad model
  dumps.
- Keep direct library use independent from executable runners or command
  parsing.

## BPMN semantic model

- BPMN XML is the source format, not the agent-facing abstraction.
- Expose business behavior: processes, scopes, activities, control flow,
  gateways, conditions, events, handlers, communication, and execution
  metadata.
- Use `$type` and loaded descriptor property names deliberately as the stable
  semantic contract; do not expose incidental moddle internals such as
  `$model`, `$descriptor`, `$parent`, methods, or object identity.
- Diagram Interchange is not business logic. Bounds, waypoints, labels, colors,
  and layout must not affect semantic inspection output.
- Presentation-only extension data, including
  `zeebe:modelerTemplateIcon`, must be excluded completely: it does not appear
  in output, counts, diagnostics, or semantic hashes.
- Semantic output for models that differ only in DI must be identical, except
  for source-byte metadata such as hashes and sizes.
- Preserve modeled identifiers and expressions exactly. Do not invent IDs,
  infer unstated intent, or paraphrase conditions in machine-readable output.
- Separate structural facts from diagnostics and interpretations.
- Support extension models explicitly. Built-in and custom profiles must be
  observable, versioned, collision-safe, and free of silent data loss.

## Safety model

- Mutations use named, fluent BPMN operations and must not expose a generic edit
  language.
- Mutation must be atomic and preserve the original input by default.
- Ambiguous target selection must fail with actionable diagnostics.
- Unsupported or unparsed extension data must never be silently discarded.
- Partial success must not be reported as success.

## Implementation guidance

- Keep parsing, semantic projection, diagnostics, and rendering separate.
- Build reusable immutable semantic representations for inspection, tracing,
  validation, diffing, planning, and verification.
- Derive human and machine output from the same semantic data.
- Prefer Node.js built-ins and established BPMN ecosystem packages. Add
  dependencies only when they materially improve correctness or maintainability.
- Keep type safety strict; avoid broad casts and silent fallbacks.
- Make expensive or unbounded operations explicit and constrainable.
- Do not add network access or executable plugin loading to ordinary model
  inspection.

## Testing requirements

- Test observable library contracts at unit and compiled-module levels.
- Use representative BPMN fixtures, including Camunda 8/Zeebe extensions.
- Assert semantic facts, not incidental XML formatting or moddle object shape.
- Maintain fixtures that cover nested scopes, gateways, conditions, loops,
  events, boundary handlers, collaborations, message flows, and malformed
  models.
- Prove DI invariance with semantically equivalent fixtures using different
  layouts.
- Cover output size boundaries, deterministic ordering, diagnostics, streams,
  and exit codes.
- Never weaken or delete tests to accommodate an implementation.
- A change is complete only after the relevant build, typecheck, lint, tests,
  and output examples pass.

## Scope discipline

- Do not implement an edit DSL by accident through method options.
- Do not expose complete moddle serialization as the primary public API.
- Do not add executable runners or command surfaces without a concrete API
  workflow.
- Keep exported types, documentation, tests, and actual behavior in sync.
