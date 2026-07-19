import { createHash } from "node:crypto";

import type {
  ModdleElement,
  ModdlePropertyDescriptor
} from "bpmn-moddle";

import { typedDescriptorProperties } from "./moddle.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ProjectionDiagnostic {
  code: "UNRESOLVED_REFERENCE" | "UNSUPPORTED_EXTENSION_DATA";
  elementRef?: string;
  message: string;
  property?: string;
  severity: "warning";
}

export interface ProjectionResult {
  diagnostics: ProjectionDiagnostic[];
  value: JsonObject;
}

export interface ProjectOptions {
  omitProperties?: ReadonlySet<string>;
  semanticHash?: boolean;
}

const HARD_EXCLUDED_PREFIXES = new Set([
  "bpmndi",
  "di",
  "dc",
  "bioc",
  "color",
  "xml",
  "xmlns",
  "xsi"
]);

const HARD_EXCLUDED_PROPERTIES = new Set([
  "zeebe:modelerTemplateIcon"
]);

const HASH_EXCLUDED_PROPERTIES = new Set([
  "bpmn:exporter",
  "bpmn:exporterVersion",
  "modeler:executionPlatform",
  "modeler:executionPlatformVersion"
]);

function isExcludedAttribute(name: string, semanticHash: boolean): boolean {
  const prefix = name.includes(":") ? name.slice(0, name.indexOf(":")) : "";

  return (
    name === "xmlns" ||
    HARD_EXCLUDED_PREFIXES.has(prefix) ||
    HARD_EXCLUDED_PROPERTIES.has(name) ||
    HASH_EXCLUDED_PROPERTIES.has(name) ||
    (semanticHash && HASH_EXCLUDED_PROPERTIES.has(name))
  );
}

function descriptorPrefix(element: ModdleElement): string {
  return element.$descriptor.ns.prefix ?? element.$type.split(":")[0] ?? "";
}

export function isHardExcludedElement(element: ModdleElement): boolean {
  return HARD_EXCLUDED_PREFIXES.has(descriptorPrefix(element));
}

function qualifiedPropertyName(
  element: ModdleElement,
  property: ModdlePropertyDescriptor
): string {
  return (
    property.ns?.name ??
    `${element.$descriptor.ns.prefix ?? element.$type.split(":")[0]}:${property.name}`
  );
}

export function classifyProperty(
  element: ModdleElement,
  property: ModdlePropertyDescriptor,
  semanticHash = false
): "exclude" | "primitive" | "reference" | "semantic-child" {
  const qualifiedName = qualifiedPropertyName(element, property);
  const prefix = property.ns?.prefix;

  if (
    (prefix !== undefined && HARD_EXCLUDED_PREFIXES.has(prefix)) ||
    HARD_EXCLUDED_PROPERTIES.has(qualifiedName) ||
    (semanticHash && HASH_EXCLUDED_PROPERTIES.has(qualifiedName))
  ) {
    return "exclude";
  }

  if (property.isReference) {
    return "reference";
  }

  const primitiveTypes = new Set([
    "Boolean",
    "Integer",
    "Real",
    "String"
  ]);

  return primitiveTypes.has(property.type) ? "primitive" : "semantic-child";
}

function referenceValue(
  value: unknown,
  element: ModdleElement,
  property: ModdlePropertyDescriptor,
  diagnostics: ProjectionDiagnostic[]
): JsonValue | undefined {
  const projectOne = (reference: unknown): JsonValue | undefined => {
    if (
      typeof reference === "object" &&
      reference !== null &&
      "$type" in reference
    ) {
      const id = (reference as ModdleElement).id;

      if (id !== undefined) {
        return id;
      }

      diagnostics.push({
        code: "UNRESOLVED_REFERENCE",
        elementRef: element.id,
        message: `Reference "${property.name}" points to an element without an ID`,
        property: property.name,
        severity: "warning"
      });
      return null;
    }

    if (
      typeof reference === "string" ||
      typeof reference === "number" ||
      typeof reference === "boolean"
    ) {
      return reference;
    }

    return undefined;
  };

  if (Array.isArray(value)) {
    return value
      .map(projectOne)
      .filter((entry): entry is JsonValue => entry !== undefined);
  }

  return projectOne(value);
}

function plainValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(plainValue)
      .filter((entry): entry is JsonValue => entry !== undefined);
  }

  if (typeof value === "object" && value !== null) {
    const result: JsonObject = {};

    for (const [key, entry] of Object.entries(value).sort(([left], [right]) =>
      compareStrings(left, right)
    )) {
      if (key.startsWith("$") || typeof entry === "function") {
        continue;
      }

      const projected = plainValue(entry);

      if (projected !== undefined) {
        result[key] = projected;
      }
    }

    return result;
  }

  return undefined;
}

export function projectElement(
  element: ModdleElement,
  options: ProjectOptions = {}
): ProjectionResult {
  const diagnostics: ProjectionDiagnostic[] = [];
  const visiting = new Set<ModdleElement>();

  const project = (current: ModdleElement): JsonObject | undefined => {
    if (isHardExcludedElement(current)) {
      return undefined;
    }

    if (current.$descriptor.isGeneric) {
      diagnostics.push({
        code: "UNSUPPORTED_EXTENSION_DATA",
        elementRef: current.id,
        message: `Generic extension element "${current.$type}" is not supported`,
        severity: "warning"
      });
      return undefined;
    }

    if (visiting.has(current)) {
      return current.id === undefined
        ? { $type: current.$type }
        : { $type: current.$type, id: current.id };
    }

    visiting.add(current);

    const result: JsonObject = { $type: current.$type };

    for (const property of typedDescriptorProperties(current)) {
      if (options.omitProperties?.has(property.name)) {
        continue;
      }

      const classification = classifyProperty(
        current,
        property,
        options.semanticHash
      );

      if (classification === "exclude") {
        continue;
      }

      const ownsProperty = Object.prototype.hasOwnProperty.call(
        current,
        property.name
      );
      const value = current.get(property.name);

      if (
        value === undefined ||
        value === null ||
        (Array.isArray(value) && value.length === 0)
      ) {
        if (property.default === undefined) {
          continue;
        }
      } else if (!ownsProperty && property.default === undefined) {
        continue;
      }

      if (classification === "reference") {
        const projected = referenceValue(
          value ?? property.default,
          current,
          property,
          diagnostics
        );

        if (projected !== undefined) {
          result[property.name] = projected;
        }

        continue;
      }

      if (classification === "primitive") {
        const projected = plainValue(value ?? property.default);

        if (projected !== undefined) {
          result[property.name] = projected;
        }

        continue;
      }

      const projectChild = (child: unknown): JsonValue | undefined => {
        if (
          typeof child === "object" &&
          child !== null &&
          "$type" in child
        ) {
          return project(child as ModdleElement);
        }

        return plainValue(child);
      };

      if (Array.isArray(value)) {
        const children = value
          .map(projectChild)
          .filter((entry): entry is JsonValue => entry !== undefined);

        if (children.length > 0) {
          result[property.name] = children;
        }
      } else {
        const child = projectChild(value ?? property.default);

        if (child !== undefined) {
          result[property.name] = child;
        }
      }
    }

    for (const [name, value] of Object.entries(current.$attrs ?? {})) {
      if (
        result[name] !== undefined ||
        isExcludedAttribute(name, options.semanticHash ?? false)
      ) {
        continue;
      }

      result[name] = value;
      diagnostics.push({
        code: "UNSUPPORTED_EXTENSION_DATA",
        elementRef: current.id,
        message: `Unregistered extension attribute "${name}" was preserved without a moddle descriptor`,
        property: name,
        severity: "warning"
      });
    }

    visiting.delete(current);
    return result;
  };

  return {
    diagnostics,
    value: project(element) ?? { $type: element.$type }
  };
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }

  return value;
}

export function semanticHash(root: ModdleElement): string {
  const projected = projectElement(root, { semanticHash: true }).value;
  const canonical = JSON.stringify(canonicalize(projected));

  return createHash("sha256").update(canonical).digest("hex");
}

export function descriptorCoverage(
  elements: readonly ModdleElement[]
): Array<{
  classification: ReturnType<typeof classifyProperty>;
  property: string;
  type: string;
}> {
  const coverage = new Map<string, {
    classification: ReturnType<typeof classifyProperty>;
    property: string;
    type: string;
  }>();

  for (const element of elements) {
    for (const property of typedDescriptorProperties(element)) {
      const key = `${element.$type}#${property.name}`;
      coverage.set(key, {
        classification: classifyProperty(element, property),
        property: property.name,
        type: element.$type
      });
    }
  }

  return [...coverage.values()].sort((left, right) =>
    compareStrings(
      `${left.type}#${left.property}`,
      `${right.type}#${right.property}`
    )
  );
}
