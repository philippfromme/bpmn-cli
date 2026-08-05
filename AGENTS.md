# AGENTS.md

## Purpose

`bpmn-cli` is a focused TypeScript library for safe, fluent BPMN model changes.
Optimize for semantic correctness, deterministic behavior, and low agent
context cost.

## Public contract

- Keep the public API semantic: no XML editing, JSON Pointers, generic edit
  operations, or executable command surface.
- Treat exported types, method names, error codes, and publication result fields
  as versioned API.
- Use exact IDs and typed extension builders. Do not expose moddle internals as
  the primary API.
- Keep direct library use independent from runners, network access, and plugins.

## Safety

- The library owns IDs, containment, and reciprocal references.
- `publish` must serialize, reload, verify intended semantics, and write
  atomically.
- Reject ambiguous targets, foreign model elements, malformed BPMN, and
  unsupported or unparsed extension data. Never silently discard data.
- Diagram Interchange and presentation-only data must not affect semantic hashes
  or change reports.

## Implementation

- Keep parsing, semantic projection, model mutation, and publication separate.
- Use loaded moddle descriptors for standard and custom extensions.
- Preserve strict typing; avoid broad casts and silent fallbacks.
- Add dependencies only when they improve correctness or maintainability.

## Verification

- Test public library behavior and compiled imports.
- Cover Zeebe and custom extensions, publication failures, DI invariance, and
  atomic output.
- Do not weaken tests. Complete relevant build, typecheck, lint, and tests
  before finishing.
