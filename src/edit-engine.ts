import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import type {
  ModdleElement,
  ModdlePropertyDescriptor
} from "bpmn-moddle";

import type {
  EditOperation,
  EditRequest,
  Expectation
} from "./edit-schema.js";
import {
  classifyProperty,
  isHardExcludedElement,
  projectElement,
  semanticHash,
  type JsonObject,
  type JsonValue
} from "./project.js";
import type { SemanticModel } from "./semantic.js";

export interface EditEngineResult {
  definitions: ModdleElement;
  operations: JsonObject[];
}

export class EditEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: JsonObject
  ) {
    super(message);
  }
}

interface EngineState {
  aliases: Map<string, ModdleElement>;
  generatedIds: Set<string>;
  generationSeed: string;
  model: SemanticModel;
  operationIndex: number;
}

interface ReadResult {
  present: boolean;
  property?: ModdlePropertyDescriptor;
  value?: unknown;
}

interface PropertyLocation {
  kind: "property";
  owner: ModdleElement;
  property: ModdlePropertyDescriptor;
  value: unknown;
}

interface ArrayLocation {
  array: unknown[];
  index: number;
  kind: "array";
  owner: ModdleElement;
  property: ModdlePropertyDescriptor;
  value: unknown;
}

interface RootLocation {
  kind: "root";
  value: ModdleElement;
}

type MutationLocation = ArrayLocation | PropertyLocation | RootLocation;

interface BuiltValue {
  elements: ModdleElement[];
  value: unknown;
}

const PRIMITIVE_TYPES = new Set(["Boolean", "Integer", "Real", "String"]);
const require = createRequire(import.meta.url);
const canonicalize = require("canonicalize") as (
  input: unknown
) => string | undefined;

function isModdleElement(value: unknown): value is ModdleElement {
  return typeof value === "object" && value !== null && "$type" in value;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalJson(value: unknown): string {
  const result = canonicalize(value);

  if (result === undefined) {
    throw new EditEngineError(
      "EDIT_VALUE_INVALID",
      "Unable to canonicalize edit value"
    );
  }

  return result;
}

function pointerTokens(path: string): string[] {
  if (path === "") {
    return [];
  }

  return path
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function propertyFor(
  element: ModdleElement,
  name: string
): ModdlePropertyDescriptor {
  const property = element.$descriptor.properties.find(
    (candidate) => candidate.name === name
  );

  if (property === undefined) {
    throw new EditEngineError(
      "EDIT_PROPERTY_UNKNOWN",
      `Property "${name}" is not defined on ${element.$type}`,
      { elementRef: element.id ?? null, path: name }
    );
  }

  if (classifyProperty(element, property) === "exclude") {
    throw new EditEngineError(
      "EDIT_PROPERTY_EXCLUDED",
      `Property "${name}" is presentation-only and cannot be edited`,
      { elementRef: element.id ?? null, path: name }
    );
  }

  return property;
}

function arrayIndex(token: string, length: number, allowEnd: boolean): number {
  if (!/^(?:0|[1-9]\d*)$/.test(token)) {
    throw new EditEngineError(
      "EDIT_PATH_INVALID",
      `Expected a zero-based array index, got "${token}"`
    );
  }

  const index = Number(token);
  const maximum = allowEnd ? length : length - 1;

  if (!Number.isSafeInteger(index) || index < 0 || index > maximum) {
    throw new EditEngineError(
      "EDIT_PATH_NOT_FOUND",
      `Array index ${token} is outside the valid range`
    );
  }

  return index;
}

function collectElements(root: ModdleElement): ModdleElement[] {
  const elements: ModdleElement[] = [];
  const visited = new Set<ModdleElement>();

  const visit = (element: ModdleElement): void => {
    if (visited.has(element) || isHardExcludedElement(element)) {
      return;
    }

    visited.add(element);
    elements.push(element);

    for (const property of element.$descriptor.properties) {
      if (
        property.isReference ||
        classifyProperty(element, property) !== "semantic-child"
      ) {
        continue;
      }

      const value = element.get(property.name);
      const children = Array.isArray(value) ? value : [value];

      for (const child of children) {
        if (isModdleElement(child)) {
          visit(child);
        }
      }
    }
  };

  visit(root);
  return elements;
}

function currentById(root: ModdleElement): Map<string, ModdleElement> {
  const byId = new Map<string, ModdleElement>();

  for (const element of collectElements(root)) {
    if (element.id === undefined) {
      continue;
    }

    if (byId.has(element.id)) {
      throw new EditEngineError(
        "EDIT_DUPLICATE_ID",
        `Duplicate BPMN ID after edit: ${element.id}`
      );
    }
    byId.set(element.id, element);
  }

  return byId;
}

function resolveTarget(state: EngineState, reference: string): ModdleElement {
  if (reference === "@definitions") {
    return state.model.definitions;
  }

  const alias = state.aliases.get(reference);

  if (alias !== undefined) {
    return alias;
  }

  const target = currentById(state.model.definitions).get(reference);

  if (target === undefined) {
    throw new EditEngineError(
      "EDIT_TARGET_NOT_FOUND",
      `Edit target not found: ${reference}`,
      { target: reference }
    );
  }

  return target;
}

function resolveRead(
  target: ModdleElement,
  path: string
): ReadResult {
  const tokens = pointerTokens(path);

  if (tokens.length === 0) {
    return { present: true, value: target };
  }

  let current: unknown = target;
  let property: ModdlePropertyDescriptor | undefined;

  for (const token of tokens) {
    if (isModdleElement(current)) {
      if (token === "$type") {
        current = current.$type;
        property = undefined;
        continue;
      }

      property = propertyFor(current, token);
      const owns = Object.prototype.hasOwnProperty.call(current, property.name);
      current = current.get(property.name);

      if (
        current === undefined &&
        property.default === undefined &&
        property.isMany !== true &&
        !owns
      ) {
        return { present: false, property };
      }

      if (current === undefined && property.isMany === true) {
        current = [];
      } else if (current === undefined && property.default !== undefined) {
        current = property.default;
      }
      continue;
    }

    if (Array.isArray(current)) {
      if (token === "-") {
        return { present: false, property };
      }
      const index = arrayIndex(token, current.length, false);
      current = current[index];
      continue;
    }

    return { present: false, property };
  }

  return { present: current !== undefined, property, value: current };
}

function resolveLocation(
  target: ModdleElement,
  path: string,
  allowArrayEnd: boolean
): MutationLocation {
  const tokens = pointerTokens(path);

  if (tokens.length === 0) {
    return { kind: "root", value: target };
  }

  let current: unknown = target;
  let owner = target;
  let owningProperty: ModdlePropertyDescriptor | undefined;

  for (const [position, token] of tokens.entries()) {
    const final = position === tokens.length - 1;

    if (isModdleElement(current)) {
      if (token === "$type") {
        throw new EditEngineError(
          "EDIT_PROPERTY_READ_ONLY",
          "$type cannot be edited directly; replace the contained element"
        );
      }

      const property = propertyFor(current, token);
      const value = current.get(property.name);

      if (final) {
        return {
          kind: "property",
          owner: current,
          property,
          value
        };
      }

      if (property.isReference) {
        throw new EditEngineError(
          "EDIT_PATH_INVALID",
          `Cannot traverse reference property "${property.name}"; target the referenced ID`
        );
      }

      owner = current;
      owningProperty = property;
      current = value ?? (property.isMany ? [] : undefined);
      continue;
    }

    if (Array.isArray(current)) {
      if (owningProperty === undefined) {
        throw new EditEngineError(
          "EDIT_PATH_INVALID",
          "Collection has no descriptor property"
        );
      }

      const index =
        token === "-" && final && allowArrayEnd
          ? current.length
          : arrayIndex(token, current.length, final && allowArrayEnd);

      if (final) {
        return {
          array: current,
          index,
          kind: "array",
          owner,
          property: owningProperty,
          value: current[index]
        };
      }

      current = current[index];
      continue;
    }

    throw new EditEngineError(
      "EDIT_PATH_NOT_FOUND",
      `Path does not resolve at "${token}"`
    );
  }

  throw new EditEngineError("EDIT_PATH_INVALID", `Invalid edit path: ${path}`);
}

function normalizeValue(
  value: unknown,
  property?: ModdlePropertyDescriptor
): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value as JsonValue;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeValue(entry, property))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }

  if (isModdleElement(value)) {
    if (property?.isReference) {
      return value.id ?? null;
    }

    return projectElement(value).value;
  }

  return undefined;
}

function expectationActual(
  state: EngineState,
  expectation: Expectation
): ReadResult & { normalized?: JsonValue } {
  const result = resolveRead(
    resolveTarget(state, expectation.target),
    expectation.path
  );

  return {
    ...result,
    normalized: normalizeValue(result.value, result.property)
  };
}

function assertExpectations(
  state: EngineState,
  expectations: readonly Expectation[]
): void {
  for (const expectation of expectations) {
    const actual = expectationActual(state, expectation);
    let matches = false;

    if (expectation.absent) {
      matches = !actual.present;
    } else if (expectation.length !== undefined) {
      matches =
        Array.isArray(actual.value) &&
        actual.value.length === expectation.length;
    } else if (expectation.equals !== undefined) {
      matches =
        actual.present &&
        actual.normalized !== undefined &&
        canonicalJson(actual.normalized) === canonicalJson(expectation.equals);
    }

    if (!matches) {
      throw new EditEngineError(
        "EDIT_PRECONDITION_FAILED",
        `Edit precondition failed at ${expectation.target}${expectation.path}`,
        {
          expectation: expectation as unknown as JsonObject,
          actual: actual.present ? (actual.normalized ?? null) : { absent: true }
        }
      );
    }
  }
}

function generatedId(
  state: EngineState,
  type: string,
  role: string
): string {
  const prefix = type.slice(type.indexOf(":") + 1).replaceAll(/[^A-Za-z0-9_]/g, "_");
  let counter = 0;

  while (true) {
    const suffix = createHash("sha256")
      .update(
        `${state.generationSeed}\0${state.operationIndex}\0${role}\0${counter}`
      )
      .digest("hex")
      .slice(0, 10);
    const id = `${prefix}_${suffix}`;

    if (
      !state.generatedIds.has(id) &&
      !currentById(state.model.definitions).has(id)
    ) {
      state.generatedIds.add(id);
      return id;
    }
    counter += 1;
  }
}

function validatePrimitive(
  property: ModdlePropertyDescriptor,
  value: JsonValue
): void {
  if (value === null) {
    return;
  }

  const expected =
    property.type === "Boolean"
      ? "boolean"
      : property.type === "Integer" || property.type === "Real"
        ? "number"
        : "string";

  if (typeof value !== expected) {
    throw new EditEngineError(
      "EDIT_VALUE_TYPE_MISMATCH",
      `Property "${property.name}" expects ${property.type}, got ${typeof value}`
    );
  }

  if (property.type === "Integer" && !Number.isInteger(value)) {
    throw new EditEngineError(
      "EDIT_VALUE_TYPE_MISMATCH",
      `Property "${property.name}" expects an integer`
    );
  }
}

function hasIdProperty(element: ModdleElement): boolean {
  return element.$descriptor.properties.some(({ isId }) => isId);
}

function buildValue(
  state: EngineState,
  property: ModdlePropertyDescriptor,
  input: JsonValue,
  role: string,
  item = false
): BuiltValue {
  if (property.isMany && !item) {
    if (!Array.isArray(input)) {
      throw new EditEngineError(
        "EDIT_VALUE_TYPE_MISMATCH",
        `Property "${property.name}" expects an array`
      );
    }

    if (input === null && !item) {
      return { elements: [], value: null };
    }

    const built = input.map((entry, index) =>
      buildValue(state, property, entry, `${role}.${index}`, true)
    );
    return {
      elements: built.flatMap(({ elements }) => elements),
      value: built.map(({ value }) => value)
    };
  }

  if (property.isReference) {
    if (typeof input !== "string") {
      throw new EditEngineError(
        "EDIT_VALUE_TYPE_MISMATCH",
        `Reference property "${property.name}" expects an ID or alias string`
      );
    }

    const reference = resolveTarget(state, input);

    if (!reference.$instanceOf(property.type)) {
      throw new EditEngineError(
        "EDIT_REFERENCE_TYPE_MISMATCH",
        `Reference "${input}" is not compatible with ${property.type}`
      );
    }

    return { elements: [], value: reference };
  }

  if (
    PRIMITIVE_TYPES.has(property.type) ||
    property.isAttr === true
  ) {
    if (Array.isArray(input) || isJsonObject(input)) {
      throw new EditEngineError(
        "EDIT_VALUE_TYPE_MISMATCH",
        `Property "${property.name}" expects a scalar`
      );
    }
    validatePrimitive(property, input);
    return { elements: [], value: input };
  }

  if (!isJsonObject(input) || typeof input.$type !== "string") {
    throw new EditEngineError(
      "EDIT_VALUE_TYPE_MISMATCH",
      `Contained property "${property.name}" requires an object with $type`
    );
  }

  let element: ModdleElement;

  try {
    element = state.model.moddle.create(input.$type);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EditEngineError(
      "EDIT_TYPE_UNKNOWN",
      `Unable to create ${input.$type}: ${message}`
    );
  }

  if (
    element.$descriptor.isAbstract === true ||
    isHardExcludedElement(element) ||
    !element.$instanceOf(property.type)
  ) {
    throw new EditEngineError(
      "EDIT_VALUE_TYPE_MISMATCH",
      `${input.$type} is not compatible with ${property.type}`
    );
  }

  const elements = [element];

  for (const [name, value] of Object.entries(input)) {
    if (name === "$type") {
      continue;
    }

    const childProperty = propertyFor(element, name);
    const built = buildValue(
      state,
      childProperty,
      value,
      `${role}.${name}`
    );
    element.set(childProperty.name, built.value);
    setParents(element, childProperty, built.value);
    elements.push(...built.elements);
  }

  if (element.id === undefined && hasIdProperty(element)) {
    element.set("id", generatedId(state, element.$type, role));
  }

  return { elements, value: element };
}

function setParents(
  owner: ModdleElement,
  property: ModdlePropertyDescriptor,
  value: unknown
): void {
  if (property.isReference) {
    return;
  }

  const children = Array.isArray(value) ? value : [value];

  for (const child of children) {
    if (isModdleElement(child)) {
      child.$parent = owner;
    }
  }
}

function containmentLocation(
  root: ModdleElement,
  target: ModdleElement
): PropertyLocation | ArrayLocation | undefined {
  for (const owner of collectElements(root)) {
    for (const property of owner.$descriptor.properties) {
      if (
        property.isReference ||
        classifyProperty(owner, property) !== "semantic-child"
      ) {
        continue;
      }

      const value = owner.get(property.name);

      if (Array.isArray(value)) {
        const index = value.indexOf(target);

        if (index !== -1) {
          return {
            array: value,
            index,
            kind: "array",
            owner,
            property,
            value: target
          };
        }
      } else if (value === target) {
        return {
          kind: "property",
          owner,
          property,
          value
        };
      }
    }
  }

  return undefined;
}

function setLocationValue(location: MutationLocation, value: unknown): void {
  if (location.kind === "property") {
    location.owner.set(location.property.name, value);
    setParents(location.owner, location.property, value);
    return;
  }

  if (location.kind === "array") {
    location.array[location.index] = value;

    if (isModdleElement(value) && !location.property.isReference) {
      value.$parent = location.owner;
    }
    return;
  }

  throw new EditEngineError(
    "EDIT_ROOT_REPLACE_INVALID",
    "Definitions cannot be replaced"
  );
}

function removeLocationValue(
  state: EngineState,
  location: MutationLocation
): unknown {
  if (location.kind === "root") {
    const containment = containmentLocation(
      state.model.definitions,
      location.value
    );

    if (containment === undefined) {
      throw new EditEngineError(
        "EDIT_ROOT_REMOVE_INVALID",
        "Definitions cannot be removed"
      );
    }
    return removeLocationValue(state, containment);
  }

  if (location.kind === "property") {
    const previous = location.value;
    location.owner.set(location.property.name, undefined);
    return previous;
  }

  return location.array.splice(location.index, 1)[0];
}

function registerAlias(
  state: EngineState,
  alias: string | undefined,
  value: unknown
): void {
  if (alias === undefined) {
    return;
  }

  if (state.aliases.has(alias)) {
    throw new EditEngineError(
      "EDIT_ALIAS_CONFLICT",
      `Duplicate edit alias: ${alias}`
    );
  }

  if (!isModdleElement(value)) {
    throw new EditEngineError(
      "EDIT_ALIAS_INVALID",
      `Alias ${alias} can reference only a contained moddle element`
    );
  }

  state.aliases.set(alias, value);
}

function effect(
  target: ModdleElement,
  path: string,
  before: unknown,
  after: unknown
): JsonObject {
  const property = target.$descriptor.properties.find(
    ({ name, ns }) =>
      name === path.slice(1) ||
      ns?.localName === path.slice(1) ||
      ns?.name === path.slice(1)
  );

  return {
    target: target.id ?? "@definitions",
    path,
    before: normalizeValue(before, property) ?? null,
    after: normalizeValue(after, property) ?? null
  };
}

function setIfChanged(
  owner: ModdleElement,
  propertyName: string,
  value: ModdleElement[],
  effects: JsonObject[]
): void {
  const before = owner.get(propertyName);
  const previous = Array.isArray(before) ? before : [];

  if (
    previous.length === value.length &&
    previous.every((entry, index) => entry === value[index])
  ) {
    return;
  }

  owner.set(propertyName, value);
  effects.push(effect(owner, `/${propertyName}`, previous, value));
}

interface RelationSnapshot {
  activities: Map<ModdleElement, ModdleElement[]>;
  boundaries: Map<ModdleElement, unknown>;
  contained: Set<ModdleElement>;
  flows: Map<
    ModdleElement,
    { source: unknown; target: unknown }
  >;
  links: Map<ModdleElement, unknown>;
  linkSources: Map<ModdleElement, ModdleElement[]>;
  nodes: Map<
    ModdleElement,
    { incoming: ModdleElement[]; outgoing: ModdleElement[] }
  >;
}

function referenceArray(value: unknown): ModdleElement[] {
  return Array.isArray(value)
    ? value.filter(isModdleElement)
    : [];
}

function captureRelations(root: ModdleElement): RelationSnapshot {
  const elements = collectElements(root);
  const flows = elements.filter((element) =>
    element.$instanceOf("bpmn:SequenceFlow")
  );
  const nodes = elements.filter((element) =>
    element.$instanceOf("bpmn:FlowNode")
  );
  const activities = elements.filter((element) =>
    element.$instanceOf("bpmn:Activity")
  );
  const boundaries = elements.filter((element) =>
    element.$instanceOf("bpmn:BoundaryEvent")
  );
  const links = elements.filter((element) =>
    element.$instanceOf("bpmn:LinkEventDefinition")
  );

  return {
    activities: new Map(
      activities.map((activity) => [
        activity,
        referenceArray(activity.get("boundaryEventRefs"))
      ])
    ),
    boundaries: new Map(
      boundaries.map((boundary) => [
        boundary,
        boundary.get("attachedToRef")
      ])
    ),
    contained: new Set(elements),
    flows: new Map(
      flows.map((flow) => [
        flow,
        {
          source: flow.get("sourceRef"),
          target: flow.get("targetRef")
        }
      ])
    ),
    links: new Map(links.map((link) => [link, link.get("target")])),
    linkSources: new Map(
      links.map((link) => [link, referenceArray(link.get("source"))])
    ),
    nodes: new Map(
      nodes.map((node) => [
        node,
        {
          incoming: referenceArray(node.get("incoming")),
          outgoing: referenceArray(node.get("outgoing"))
        }
      ])
    )
  };
}

function sameReferences(
  left: readonly ModdleElement[],
  right: readonly ModdleElement[]
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function normalizeReferences(
  state: EngineState,
  before: RelationSnapshot
): JsonObject[] {
  const effects: JsonObject[] = [];
  const elements = collectElements(state.model.definitions);
  const contained = new Set(elements);
  const flows = elements.filter((element) =>
    element.$instanceOf("bpmn:SequenceFlow")
  );
  const flowNodes = elements.filter((element) =>
    element.$instanceOf("bpmn:FlowNode")
  );
  const affectedNodes = new Set<ModdleElement>();

  for (const flow of new Set([...before.flows.keys(), ...flows])) {
    const previous = before.flows.get(flow);
    const source = flow.get("sourceRef");
    const target = flow.get("targetRef");

    if (
      previous === undefined ||
      !contained.has(flow) ||
      previous.source !== source ||
      previous.target !== target
    ) {
      for (const endpoint of [
        previous?.source,
        previous?.target,
        source,
        target
      ]) {
        if (isModdleElement(endpoint) && contained.has(endpoint)) {
          affectedNodes.add(endpoint);
        }
      }
    }
  }

  for (const node of flowNodes) {
    const previous = before.nodes.get(node);
    const currentIncoming = referenceArray(node.get("incoming"));
    const currentOutgoing = referenceArray(node.get("outgoing"));

    if (
      previous !== undefined &&
      (!sameReferences(previous.incoming, currentIncoming) ||
        !sameReferences(previous.outgoing, currentOutgoing))
    ) {
      affectedNodes.add(node);
    }
  }

  for (const node of affectedNodes) {
    const incoming = flows.filter((flow) => flow.get("targetRef") === node);
    const outgoing = flows.filter((flow) => flow.get("sourceRef") === node);
    setIfChanged(node, "incoming", incoming, effects);
    setIfChanged(node, "outgoing", outgoing, effects);
  }

  const activities = elements.filter((element) =>
    element.$instanceOf("bpmn:Activity")
  );
  const boundaries = elements.filter((element) =>
    element.$instanceOf("bpmn:BoundaryEvent")
  );
  const affectedActivities = new Set<ModdleElement>();

  for (const boundary of new Set([
    ...before.boundaries.keys(),
    ...boundaries
  ])) {
    const previous = before.boundaries.get(boundary);
    const attached = boundary.get("attachedToRef");

    if (
      !before.boundaries.has(boundary) ||
      !contained.has(boundary) ||
      previous !== attached
    ) {
      for (const activity of [previous, attached]) {
        if (isModdleElement(activity) && contained.has(activity)) {
          affectedActivities.add(activity);
        }
      }
    }
  }

  for (const activity of activities) {
    const previous = before.activities.get(activity);
    const current = referenceArray(activity.get("boundaryEventRefs"));

    if (
      previous !== undefined &&
      !sameReferences(previous, current)
    ) {
      affectedActivities.add(activity);
    }
  }

  for (const activity of affectedActivities) {
    const attached = boundaries.filter(
      (boundary) => boundary.get("attachedToRef") === activity
    );
    setIfChanged(activity, "boundaryEventRefs", attached, effects);
  }

  const links = elements.filter((element) =>
    element.$instanceOf("bpmn:LinkEventDefinition")
  );
  const affectedLinks = new Set<ModdleElement>();

  for (const link of new Set([...before.links.keys(), ...links])) {
    const previous = before.links.get(link);
    const target = link.get("target");

    if (
      !before.links.has(link) ||
      !contained.has(link) ||
      previous !== target
    ) {
      for (const candidate of [previous, target]) {
        if (isModdleElement(candidate) && contained.has(candidate)) {
          affectedLinks.add(candidate);
        }
      }
    }
  }

  for (const link of links) {
    const previous = before.linkSources.get(link);
    const current = referenceArray(link.get("source"));

    if (previous !== undefined && !sameReferences(previous, current)) {
      affectedLinks.add(link);
    }
  }

  for (const target of affectedLinks) {
    const sources = links.filter((source) => source.get("target") === target);
    setIfChanged(target, "source", sources, effects);
  }

  for (const owner of elements) {
    const defaultFlow = owner.get("default");

    if (
      isModdleElement(defaultFlow) &&
      before.contained.has(defaultFlow) &&
      !contained.has(defaultFlow)
    ) {
      owner.set("default", undefined);
      effects.push(effect(owner, "/default", defaultFlow, undefined));
    }
  }

  return effects;
}

function rebindReferences(
  state: EngineState,
  previous: ModdleElement,
  replacement: ModdleElement
): JsonObject[] {
  const effects: JsonObject[] = [];

  for (const owner of collectElements(state.model.definitions)) {
    for (const property of owner.$descriptor.properties) {
      if (!property.isReference) {
        continue;
      }

      const current = owner.get(property.name);

      if (Array.isArray(current) && current.includes(previous)) {
        if (!replacement.$instanceOf(property.type)) {
          throw new EditEngineError(
            "EXTERNAL_REFERENCE_CONFLICT",
            `${replacement.$type} cannot replace ${previous.$type} in ${owner.$type}.${property.name}`
          );
        }
        const updated = current.map((entry) =>
          entry === previous ? replacement : entry
        );
        owner.set(property.name, updated);
        effects.push(effect(owner, `/${property.name}`, current, updated));
      } else if (current === previous) {
        if (!replacement.$instanceOf(property.type)) {
          throw new EditEngineError(
            "EXTERNAL_REFERENCE_CONFLICT",
            `${replacement.$type} cannot replace ${previous.$type} in ${owner.$type}.${property.name}`
          );
        }
        owner.set(property.name, replacement);
        effects.push(effect(owner, `/${property.name}`, previous, replacement));
      }
    }
  }

  return effects;
}

function operationRecord(
  operation: EditOperation,
  index: number,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  effects: JsonObject[],
  aliasValue?: ModdleElement
): JsonObject {
  return {
    index,
    op: operation.op,
    ...(operation.op === "move"
      ? { from: operation.from, to: operation.to }
      : { target: operation.target, path: operation.path }),
    before: before ?? null,
    after: after ?? null,
    effects,
    ...("as" in operation && operation.as !== undefined
      ? {
          as: operation.as,
          resolvedId: aliasValue?.id ?? null,
          resolvedType: aliasValue?.$type ?? null
        }
      : {})
  } as unknown as JsonObject;
}

function applyAdd(
  state: EngineState,
  operation: Extract<EditOperation, { op: "add" }>
): { after: JsonValue; aliasValue?: ModdleElement; before?: JsonValue } {
  const target = resolveTarget(state, operation.target);
  const location = resolveLocation(target, operation.path, true);

  if (location.kind === "root") {
    throw new EditEngineError(
      "EDIT_ADD_INVALID",
      "add requires a property or collection insertion path"
    );
  }

  if (location.kind === "property") {
    const current = resolveRead(target, operation.path);

    if (current.present) {
      throw new EditEngineError(
        "EDIT_ADD_CONFLICT",
        `Property already exists at ${operation.target}${operation.path}`
      );
    }

    const built = buildValue(
      state,
      location.property,
      operation.value,
      `add.${location.property.name}`
    );
    location.owner.set(location.property.name, built.value);
    setParents(location.owner, location.property, built.value);
    registerAlias(state, operation.as, built.value);
    return {
      after: normalizeValue(built.value, location.property) ?? null,
      aliasValue: isModdleElement(built.value) ? built.value : undefined
    };
  }

  const built = buildValue(
    state,
    location.property,
    operation.value,
    `add.${location.property.name}.${location.index}`,
    true
  );
  location.array.splice(location.index, 0, built.value);
  setParents(location.owner, location.property, built.value);
  registerAlias(state, operation.as, built.value);
  return {
    after: normalizeValue(built.value, location.property) ?? null,
    aliasValue: isModdleElement(built.value) ? built.value : undefined
  };
}

function applyRemove(
  state: EngineState,
  operation: Extract<EditOperation, { op: "remove" }>
): { after?: JsonValue; before: JsonValue } {
  const target = resolveTarget(state, operation.target);
  const location = resolveLocation(target, operation.path, false);
  const previous = removeLocationValue(state, location);

  return {
    before: normalizeValue(
      previous,
      location.kind === "root" ? undefined : location.property
    ) ?? null
  };
}

function applyReplace(
  state: EngineState,
  operation: Extract<EditOperation, { op: "replace" }>
): {
  after: JsonValue;
  aliasValue?: ModdleElement;
  before: JsonValue;
  effects: JsonObject[];
} {
  const target = resolveTarget(state, operation.target);
  const location = resolveLocation(target, operation.path, false);

  if (location.kind === "root") {
    const containment = containmentLocation(state.model.definitions, target);

    if (containment === undefined) {
      throw new EditEngineError(
        "EDIT_ROOT_REPLACE_INVALID",
        "Definitions cannot be replaced"
      );
    }

    const built = buildValue(
      state,
      containment.property,
      operation.value,
      `replace.${containment.property.name}`,
      containment.kind === "array"
    );
    const replacement = built.value;

    if (!isModdleElement(replacement)) {
      throw new EditEngineError(
        "EDIT_VALUE_TYPE_MISMATCH",
        "Whole-element replacement requires a moddle element"
      );
    }

    const explicitId =
      isJsonObject(operation.value) &&
      Object.prototype.hasOwnProperty.call(operation.value, "id");

    if (!explicitId && target.id !== undefined) {
      replacement.set("id", target.id);
    }
    setLocationValue(containment, replacement);
    const effects = rebindReferences(state, target, replacement);
    registerAlias(state, operation.as, replacement);
    return {
      after: projectElement(replacement).value,
      aliasValue: replacement,
      before: projectElement(target).value,
      effects
    };
  }

  const built = buildValue(
    state,
    location.property,
    operation.value,
    `replace.${location.property.name}`,
    location.kind === "array"
  );
  const previous = location.value;
  setLocationValue(location, built.value);
  const effects =
    !location.property.isReference &&
    isModdleElement(previous) &&
    isModdleElement(built.value)
      ? rebindReferences(state, previous, built.value)
      : [];
  registerAlias(state, operation.as, built.value);
  return {
    after: normalizeValue(built.value, location.property) ?? null,
    aliasValue: isModdleElement(built.value) ? built.value : undefined,
    before: normalizeValue(previous, location.property) ?? null,
    effects
  };
}

function applyMove(
  state: EngineState,
  operation: Extract<EditOperation, { op: "move" }>
): { after: JsonValue; before: JsonValue } {
  const fromTarget = resolveTarget(state, operation.from.target);
  const from = resolveLocation(fromTarget, operation.from.path, false);
  const moved = removeLocationValue(state, from);
  const toTarget = resolveTarget(state, operation.to.target);
  const to = resolveLocation(toTarget, operation.to.path, true);

  if (to.kind === "root") {
    throw new EditEngineError(
      "EDIT_MOVE_INVALID",
      "Move destination must be a property or collection position"
    );
  }

  if (to.kind === "property") {
    const current = resolveRead(toTarget, operation.to.path);

    if (current.present) {
      throw new EditEngineError(
        "EDIT_MOVE_CONFLICT",
        "Move destination property already exists"
      );
    }
    to.owner.set(to.property.name, moved);
    setParents(to.owner, to.property, moved);
  } else {
    if (
      isModdleElement(moved) &&
      !moved.$instanceOf(to.property.type)
    ) {
      throw new EditEngineError(
        "EDIT_VALUE_TYPE_MISMATCH",
        `${moved.$type} is not compatible with ${to.property.type}`
      );
    }
    to.array.splice(to.index, 0, moved);
    setParents(to.owner, to.property, moved);
  }

  const normalized = normalizeValue(
    moved,
    to.property
  ) ?? null;
  return { after: normalized, before: normalized };
}

function validateFinalReferences(root: ModdleElement): void {
  const elements = collectElements(root);
  const contained = new Set(elements);

  for (const owner of elements) {
    for (const property of owner.$descriptor.properties) {
      if (!property.isReference) {
        continue;
      }

      const value = owner.get(property.name);
      const references = Array.isArray(value) ? value : [value];

      for (const reference of references) {
        if (reference === undefined || reference === null) {
          continue;
        }

        if (
          !isModdleElement(reference) ||
          !contained.has(reference) ||
          !reference.$instanceOf(property.type)
        ) {
          throw new EditEngineError(
            "EXTERNAL_REFERENCE_CONFLICT",
            `${owner.$type}.${property.name} contains an unresolved or incompatible reference`,
            {
              elementRef: owner.id ?? null,
              property: property.name
            }
          );
        }
      }
    }
  }
}

function flowScope(element: ModdleElement): ModdleElement | undefined {
  let parent = element.$parent;

  while (parent !== undefined) {
    if (parent.$instanceOf("bpmn:FlowElementsContainer")) {
      return parent;
    }
    parent = parent.$parent;
  }

  return undefined;
}

function hasEventDefinition(element: ModdleElement, type: string): boolean {
  const definitions = element.get("eventDefinitions");
  return (
    Array.isArray(definitions) &&
    definitions.some(
      (definition) =>
        isModdleElement(definition) && definition.$instanceOf(type)
    )
  );
}

function isEventSubProcess(element: ModdleElement): boolean {
  return (
    element.$instanceOf("bpmn:SubProcess") &&
    element.get("triggeredByEvent") === true
  );
}

function sequenceFlowSourceAllowed(element: ModdleElement): boolean {
  return (
    element.$instanceOf("bpmn:FlowNode") &&
    !element.$instanceOf("bpmn:EndEvent") &&
    !isEventSubProcess(element) &&
    !(
      element.$instanceOf("bpmn:IntermediateThrowEvent") &&
      hasEventDefinition(element, "bpmn:LinkEventDefinition")
    ) &&
    !(
      element.$instanceOf("bpmn:BoundaryEvent") &&
      hasEventDefinition(element, "bpmn:CompensateEventDefinition")
    ) &&
    element.get("isForCompensation") !== true
  );
}

function sequenceFlowTargetAllowed(element: ModdleElement): boolean {
  return (
    element.$instanceOf("bpmn:FlowNode") &&
    !element.$instanceOf("bpmn:StartEvent") &&
    !element.$instanceOf("bpmn:BoundaryEvent") &&
    !isEventSubProcess(element) &&
    !(
      element.$instanceOf("bpmn:IntermediateCatchEvent") &&
      hasEventDefinition(element, "bpmn:LinkEventDefinition")
    ) &&
    element.get("isForCompensation") !== true
  );
}

function eventBasedTargetAllowed(element: ModdleElement): boolean {
  return (
    element.$instanceOf("bpmn:ReceiveTask") ||
    (element.$instanceOf("bpmn:IntermediateCatchEvent") &&
      [
        "bpmn:MessageEventDefinition",
        "bpmn:TimerEventDefinition",
        "bpmn:ConditionalEventDefinition",
        "bpmn:SignalEventDefinition"
      ].some((type) => hasEventDefinition(element, type)))
  );
}

function conditionSourceAllowed(element: ModdleElement): boolean {
  return (
    element.$instanceOf("bpmn:Activity") ||
    element.$instanceOf("bpmn:ExclusiveGateway") ||
    element.$instanceOf("bpmn:InclusiveGateway") ||
    element.$instanceOf("bpmn:ComplexGateway")
  );
}

function validateBpmnStructure(root: ModdleElement): void {
  validateFinalReferences(root);
  currentById(root);
  const elements = collectElements(root);
  const sequenceFlows = elements.filter((element) =>
    element.$instanceOf("bpmn:SequenceFlow")
  );

  for (const flow of sequenceFlows) {
    const source = flow.get("sourceRef");
    const target = flow.get("targetRef");
    if (
      !isModdleElement(source) ||
      !isModdleElement(target) ||
      !sequenceFlowSourceAllowed(source) ||
      !sequenceFlowTargetAllowed(target) ||
      flowScope(flow) !== flowScope(source) ||
      flowScope(source) !== flowScope(target) ||
      (source.$instanceOf("bpmn:EventBasedGateway") &&
        (!eventBasedTargetAllowed(target) ||
          ((target.get("incoming") as ModdleElement[] | undefined)?.length ??
            0) !== 1))
    ) {
      throw new EditEngineError(
        "EDIT_BPMN_STRUCTURE_INVALID",
        `Illegal SequenceFlow endpoints: ${flow.id ?? flow.$type}`,
        {
          flowRef: flow.id ?? null,
          sourceRef: isModdleElement(source) ? (source.id ?? null) : null,
          targetRef: isModdleElement(target) ? (target.id ?? null) : null
        }
      );
    }

    const condition = flow.get("conditionExpression");
    const isDefault = source.get("default") === flow;

    if (
      condition !== undefined &&
      (isDefault ||
        !conditionSourceAllowed(source) ||
        source.$instanceOf("bpmn:ParallelGateway") ||
        source.$instanceOf("bpmn:EventBasedGateway"))
    ) {
      throw new EditEngineError(
        "EDIT_BPMN_STRUCTURE_INVALID",
        `SequenceFlow ${flow.id ?? ""} has an illegal condition`
      );
    }
  }

  for (const owner of elements) {
    const defaultFlow = owner.get("default");

    if (defaultFlow === undefined) {
      continue;
    }

    if (
      !isModdleElement(defaultFlow) ||
      !sequenceFlows.includes(defaultFlow) ||
      defaultFlow.get("sourceRef") !== owner ||
      owner.$instanceOf("bpmn:ParallelGateway") ||
      owner.$instanceOf("bpmn:EventBasedGateway")
    ) {
      throw new EditEngineError(
        "EDIT_BPMN_STRUCTURE_INVALID",
        `Illegal default SequenceFlow on ${owner.id ?? owner.$type}`
      );
    }
  }

  for (const boundary of elements.filter((element) =>
    element.$instanceOf("bpmn:BoundaryEvent")
  )) {
    const activity = boundary.get("attachedToRef");

    if (
      !isModdleElement(activity) ||
      !activity.$instanceOf("bpmn:Activity") ||
      flowScope(boundary) !== flowScope(activity)
    ) {
      throw new EditEngineError(
        "EDIT_BPMN_STRUCTURE_INVALID",
        `Illegal BoundaryEvent attachment: ${boundary.id ?? boundary.$type}`
      );
    }
  }

  for (const definition of elements.filter((element) =>
    element.$instanceOf("bpmn:LinkEventDefinition")
  )) {
    const event = definition.$parent;
    const target = definition.get("target");
    const sources = definition.get("source");

    if (
      event?.$instanceOf("bpmn:IntermediateThrowEvent") &&
      (!isModdleElement(target) ||
        !target.$instanceOf("bpmn:LinkEventDefinition") ||
        !target.$parent?.$instanceOf("bpmn:IntermediateCatchEvent") ||
        target.get("name") !== definition.get("name"))
    ) {
      throw new EditEngineError(
        "EDIT_BPMN_STRUCTURE_INVALID",
        `Illegal Link throw target: ${event.id ?? definition.$type}`
      );
    }

    if (
      event?.$instanceOf("bpmn:IntermediateCatchEvent") &&
      (!Array.isArray(sources) ||
        sources.some(
          (source) =>
            !isModdleElement(source) ||
            !source.$parent?.$instanceOf("bpmn:IntermediateThrowEvent") ||
            source.get("target") !== definition ||
            source.get("name") !== definition.get("name")
        ))
    ) {
      throw new EditEngineError(
        "EDIT_BPMN_STRUCTURE_INVALID",
        `Illegal Link catch sources: ${event.id ?? definition.$type}`
      );
    }
  }
}

export function applyEditRequest(
  model: SemanticModel,
  request: EditRequest,
  requestSha256: string
): EditEngineResult {
  const state: EngineState = {
    aliases: new Map(),
    generatedIds: new Set(),
    generationSeed: `${model.source.sha256}\0${requestSha256}`,
    model,
    operationIndex: 0
  };
  const records: JsonObject[] = [];

  for (const [index, operation] of request.operations.entries()) {
    state.operationIndex = index;
    assertExpectations(state, operation.expect);
    const beforeHash = semanticHash(model.definitions);
    const relationsBefore = captureRelations(model.definitions);
    let before: JsonValue | undefined;
    let after: JsonValue | undefined;
    let aliasValue: ModdleElement | undefined;
    const effects: JsonObject[] = [];

    if (operation.op === "add") {
      ({ after, aliasValue, before } = applyAdd(state, operation));
    } else if (operation.op === "remove") {
      ({ after, before } = applyRemove(state, operation));
    } else if (operation.op === "replace") {
      const result = applyReplace(state, operation);
      ({ after, aliasValue, before } = result);
      effects.push(...result.effects);
    } else {
      ({ after, before } = applyMove(state, operation));
    }

    effects.push(...normalizeReferences(state, relationsBefore));
    const afterHash = semanticHash(model.definitions);

    if (beforeHash === afterHash) {
      throw new EditEngineError(
        "EDIT_OPERATION_NOOP",
        `Operation ${index} (${operation.op}) does not change business semantics`
      );
    }

    records.push(
      operationRecord(
        operation,
        index,
        before,
        after,
        effects,
        aliasValue
      )
    );
  }

  validateBpmnStructure(model.definitions);

  return {
    definitions: model.definitions,
    operations: records
  };
}
