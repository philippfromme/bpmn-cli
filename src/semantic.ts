import { createHash } from "node:crypto";

import type {
  BpmnModdle,
  Definitions,
  ModdleElement,
  ModdleParseWarning,
  ModdlePropertyDescriptor
} from "bpmn-moddle";

import type { ActiveProfile } from "./profiles.js";
import {
  classifyProperty,
  isHardExcludedElement,
  projectElement,
  semanticHash,
  type JsonObject,
  type JsonValue,
  type ProjectionDiagnostic
} from "./project.js";

export interface InspectionSource {
  bytes: number;
  path: string;
  sha256: string;
}

export interface InspectionDiagnostic {
  code: string;
  elementRef?: string;
  message: string;
  property?: string;
  severity: "info" | "warning";
}

export interface SemanticModel {
  allElements: ModdleElement[];
  byId: Map<string, ModdleElement>;
  definitions: Definitions;
  diagnostics: InspectionDiagnostic[];
  moddle: BpmnModdle;
  profiles: ActiveProfile[];
  semanticHash: string;
  source: InspectionSource;
}

export interface InspectionEnvelope extends JsonObject {
  analysis: JsonObject;
  profiles: JsonValue[];
  schemaVersion: "1";
  semanticHash: string;
  source: JsonObject;
  view: "element" | "model" | "process" | "scope";
}

const SUMMARY_OMISSIONS = new Set([
  "artifacts",
  "diagrams",
  "documentation",
  "extensionElements",
  "flowElements",
  "laneSets",
  "rootElements"
]);

const COLLABORATION_SUMMARY_OMISSIONS = new Set([
  ...SUMMARY_OMISSIONS,
  "conversationAssociations",
  "conversationLinks",
  "conversations",
  "messageFlows",
  "participantAssociations",
  "participants"
]);

const SCOPE_RECORD_OMISSIONS = new Set([
  "artifacts",
  "documentation",
  "extensionElements",
  "flowElements",
  "laneSets"
]);

const ELEMENT_OMISSIONS = new Set([
  "artifacts",
  "diagrams",
  "flowElements",
  "laneSets",
  "rootElements"
]);

function isModdleElement(value: unknown): value is ModdleElement {
  return typeof value === "object" && value !== null && "$type" in value;
}

function containedChildren(
  element: ModdleElement,
  property: ModdlePropertyDescriptor
): ModdleElement[] {
  if (property.isReference) {
    return [];
  }

  const value = element.get(property.name);

  if (Array.isArray(value)) {
    return value.filter(isModdleElement);
  }

  return isModdleElement(value) ? [value] : [];
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

    const properties = element.$descriptor.properties;

    if (!Array.isArray(properties)) {
      return;
    }

    for (const property of properties) {
      for (const child of containedChildren(element, property)) {
        visit(child);
      }
    }
  };

  visit(root);
  return elements;
}

function normalizeProjectionDiagnostic(
  diagnostic: ProjectionDiagnostic
): InspectionDiagnostic {
  return diagnostic;
}

function profileJson(profile: ActiveProfile): JsonObject {
  return Object.fromEntries(
    Object.entries(profile).filter(
      ([key, value]) => key !== "descriptorSha256" && value !== undefined
    )
  ) as JsonObject;
}

export function createSemanticModel(options: {
  definitions: Definitions;
  disabledZeebe: boolean;
  moddle: BpmnModdle;
  parseWarnings: ModdleParseWarning[];
  profiles: ActiveProfile[];
  sourceBytes: Buffer;
  sourcePath: string;
}): SemanticModel {
  const duplicateIdWarning = options.parseWarnings.find(
    ({ error, message }) =>
      error?.message.includes("duplicate ID") || message.includes("duplicate ID")
  );

  if (duplicateIdWarning !== undefined) {
    throw new Error(duplicateIdWarning.message);
  }

  for (const warning of options.parseWarnings) {
    if (
      warning.message.startsWith("unresolved reference") &&
      warning.element !== undefined &&
      warning.property !== undefined &&
      typeof warning.value === "string"
    ) {
      const property = warning.property.includes(":")
        ? warning.property.slice(warning.property.indexOf(":") + 1)
        : warning.property;
      const descriptor = warning.element.$descriptor.properties.find(
        ({ name }) => name === property
      );
      const current = warning.element.get(property);
      const restored =
        descriptor?.isMany === true
          ? [
              ...(Array.isArray(current)
                ? current
                : current === undefined
                  ? []
                  : [current]),
              warning.value
            ]
          : warning.value;
      (warning.element as unknown as Record<string, unknown>)[property] = restored;
    }
  }

  const allElements = collectElements(options.definitions);
  const byId = new Map<string, ModdleElement>();

  for (const element of allElements) {
    if (element.id !== undefined) {
      byId.set(element.id, element);
    }
  }

  const projection = projectElement(options.definitions);
  const diagnostics: InspectionDiagnostic[] = [
    ...options.parseWarnings.map((warning) => {
      const unresolved = warning.message.startsWith("unresolved reference");

      return {
        code: unresolved ? "UNRESOLVED_REFERENCE" : "BPMN_PARSE_WARNING",
        elementRef: warning.element?.id,
        message: warning.message,
        property: warning.property?.includes(":")
          ? warning.property.slice(warning.property.indexOf(":") + 1)
          : warning.property,
        severity: "warning" as const
      };
    }),
    ...projection.diagnostics.map(normalizeProjectionDiagnostic)
  ];

  if (options.disabledZeebe) {
    diagnostics.push({
      code: "PROFILE_DISABLED_DATA_IGNORED",
      message:
        "Zeebe namespace is declared but its profile is disabled; Zeebe data was not inspected",
      severity: "warning"
    });
  }

  return {
    allElements,
    byId,
    definitions: options.definitions,
    diagnostics,
    moddle: options.moddle,
    profiles: options.profiles,
    semanticHash: semanticHash(options.definitions),
    source: {
      bytes: options.sourceBytes.byteLength,
      path: options.sourcePath,
      sha256: createHash("sha256").update(options.sourceBytes).digest("hex")
    }
  };
}

function baseEnvelope(
  model: SemanticModel,
  view: InspectionEnvelope["view"],
  diagnostics: readonly InspectionDiagnostic[] = []
): InspectionEnvelope {
  return {
    schemaVersion: "1",
    view,
    source: model.source as unknown as JsonObject,
    semanticHash: model.semanticHash,
    profiles: model.profiles.map(profileJson),
    analysis: {
      diagnostics: [...model.diagnostics, ...diagnostics] as unknown as JsonValue
    }
  };
}

function isBpmnBaseElement(element: ModdleElement): boolean {
  return (
    element.$type !== "bpmn:Definitions" &&
    element.$instanceOf("bpmn:BaseElement")
  );
}

function isAddressableBpmnElement(element: ModdleElement): boolean {
  return isBpmnBaseElement(element) && element.id !== undefined;
}

function isContainer(element: ModdleElement): boolean {
  return element.$instanceOf("bpmn:FlowElementsContainer");
}

function containingElement(
  element: ModdleElement,
  predicate: (candidate: ModdleElement) => boolean
): ModdleElement | undefined {
  let parent = element.$parent;

  while (parent !== undefined) {
    if (predicate(parent)) {
      return parent;
    }

    parent = parent.$parent;
  }

  return undefined;
}

function processOf(element: ModdleElement): ModdleElement | undefined {
  return element.$instanceOf("bpmn:Process")
    ? element
    : containingElement(element, (candidate) =>
        candidate.$instanceOf("bpmn:Process")
      );
}

function containerOf(element: ModdleElement): ModdleElement | undefined {
  return containingElement(element, isContainer);
}

function shallowProjection(element: ModdleElement): JsonObject {
  return projectElement(element, {
    omitProperties: SUMMARY_OMISSIONS
  }).value;
}

function collaborationProjection(element: ModdleElement): JsonObject {
  return projectElement(element, {
    omitProperties: COLLABORATION_SUMMARY_OMISSIONS
  }).value;
}

function scopeRecordProjection(element: ModdleElement): {
  diagnostics: ProjectionDiagnostic[];
  value: JsonObject;
} {
  return projectElement(element, {
    omitProperties: SCOPE_RECORD_OMISSIONS
  });
}

function countByType(elements: readonly ModdleElement[]): JsonObject {
  const counts = new Map<string, number>();

  for (const element of elements) {
    counts.set(element.$type, (counts.get(element.$type) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right))
  );
}

function descendantsOf(
  model: SemanticModel,
  ancestor: ModdleElement
): ModdleElement[] {
  return model.allElements.filter((element) => {
    let parent = element.$parent;

    while (parent !== undefined) {
      if (parent === ancestor) {
        return true;
      }

      parent = parent.$parent;
    }

    return false;
  });
}

function directFlowElements(container: ModdleElement): ModdleElement[] {
  return container.flowElements ?? [];
}

function directArtifacts(container: ModdleElement): ModdleElement[] {
  return container.artifacts ?? [];
}

function referenceElements(element: ModdleElement): ModdleElement[] {
  const references: ModdleElement[] = [];
  const visited = new Set<ModdleElement>();

  const visit = (current: ModdleElement): void => {
    if (visited.has(current)) {
      return;
    }

    visited.add(current);

    for (const property of current.$descriptor.properties) {
      const value = current.get(property.name);

      if (property.isReference) {
        if (Array.isArray(value)) {
          references.push(...value.filter(isModdleElement));
        } else if (isModdleElement(value)) {
          references.push(value);
        }
      } else if (
        classifyProperty(current, property) === "semantic-child"
      ) {
        const children = Array.isArray(value) ? value : [value];

        for (const child of children) {
          if (isModdleElement(child)) {
            visit(child);
          }
        }
      }
    }
  };

  visit(element);
  return references;
}

function referencedRoots(
  model: SemanticModel,
  elements: readonly ModdleElement[]
): ModdleElement[] {
  const roots = new Set(model.definitions.rootElements);
  const result = new Set<ModdleElement>();

  for (const element of elements) {
    for (const reference of referenceElements(element)) {
      if (roots.has(reference)) {
        result.add(reference);
      }
    }
  }

  return [...result];
}

function conditionCount(elements: readonly ModdleElement[]): number {
  return elements.filter(
    (element) =>
      element.$type === "bpmn:SequenceFlow" &&
      element.get("conditionExpression") !== undefined
  ).length;
}

function containerSummary(
  model: SemanticModel,
  container: ModdleElement
): JsonObject {
  const descendants = descendantsOf(model, container).filter(
    isAddressableBpmnElement
  );

  return {
    element: shallowProjection(container),
    directFlowElementCount: directFlowElements(container).length,
    directArtifactCount: directArtifacts(container).length,
    countsByType: countByType(descendants)
  };
}

function processDiagnostics(
  model: SemanticModel,
  process: ModdleElement
): InspectionDiagnostic[] {
  const diagnostics: InspectionDiagnostic[] = [];
  const containers = [process, ...descendantsOf(model, process).filter(isContainer)];

  for (const container of containers) {
    if (container.$type === "bpmn:AdHocSubProcess") {
      continue;
    }

    const flowElements = directFlowElements(container);
    const flowNodes = flowElements.filter((element) =>
      element.$instanceOf("bpmn:FlowNode")
    );
    const startEvents = flowNodes.filter(
      ({ $type }) => $type === "bpmn:StartEvent"
    );
    const implicitStarts = flowNodes.filter(
      (element) =>
        element.$type !== "bpmn:BoundaryEvent" &&
        ((element.get("incoming") as unknown[] | undefined)?.length ?? 0) === 0
    );
    const starts = startEvents.length > 0 ? startEvents : implicitStarts;

    if (starts.length === 0 && flowNodes.length > 0) {
      diagnostics.push({
        code: "MISSING_START_EVENT",
        elementRef: container.id,
        message: `Container "${container.id ?? container.$type}" has no explicit or implicit start`,
        severity: "warning"
      });
    }

    const reachable = new Set<ModdleElement>();
    const queue = [...starts];

    while (queue.length > 0) {
      const current = queue.shift();

      if (current === undefined || reachable.has(current)) {
        continue;
      }

      reachable.add(current);

      for (const outgoing of (current.get("outgoing") as ModdleElement[] | undefined) ?? []) {
        const target = outgoing.get("targetRef");

        if (isModdleElement(target)) {
          queue.push(target);
        }
      }
    }

    for (const flowNode of flowNodes) {
      const isTriggeredEventSubProcess =
        flowNode.$instanceOf("bpmn:SubProcess") &&
        flowNode.get("triggeredByEvent") === true;

      if (
        flowNode.$type !== "bpmn:BoundaryEvent" &&
        !isTriggeredEventSubProcess &&
        starts.length > 0 &&
        !reachable.has(flowNode)
      ) {
        diagnostics.push({
          code: "UNREACHABLE_FLOW_NODE",
          elementRef: flowNode.id,
          message: `Flow node "${flowNode.id ?? flowNode.$type}" is unreachable within its container`,
          severity: "warning"
        });
      }

      const outgoing =
        (flowNode.get("outgoing") as ModdleElement[] | undefined) ?? [];

      if (
        outgoing.length === 0 &&
        !flowNode.$instanceOf("bpmn:EndEvent") &&
        flowNode.$type !== "bpmn:BoundaryEvent" &&
        !isTriggeredEventSubProcess
      ) {
        diagnostics.push({
          code: "DEAD_END_FLOW_NODE",
          elementRef: flowNode.id,
          message: `Flow node "${flowNode.id ?? flowNode.$type}" has no outgoing SequenceFlow`,
          severity: "warning"
        });
      }

      if (
        (flowNode.$type === "bpmn:ExclusiveGateway" ||
          flowNode.$type === "bpmn:InclusiveGateway") &&
        outgoing.length > 1
      ) {
        const conditioned = outgoing.filter(
          (flow) => flow.get("conditionExpression") !== undefined
        );
        const defaultFlow = flowNode.get("default");

        if (conditioned.length < outgoing.length - (defaultFlow ? 1 : 0)) {
          diagnostics.push({
            code: "GATEWAY_BRANCH_WITHOUT_CONDITION",
            elementRef: flowNode.id,
            message: `Gateway "${flowNode.id ?? flowNode.$type}" has a non-default branch without a condition`,
            severity: "warning"
          });
        }

        if (defaultFlow === undefined) {
          diagnostics.push({
            code: "GATEWAY_WITHOUT_DEFAULT",
            elementRef: flowNode.id,
            message: `Gateway "${flowNode.id ?? flowNode.$type}" has no default SequenceFlow`,
            severity: "info"
          });
        }
      } else if (
        outgoing.length > 1 &&
        !flowNode.$instanceOf("bpmn:Gateway") &&
        outgoing.filter(
          (flow) => flow.get("conditionExpression") === undefined
        ).length > 1
      ) {
        diagnostics.push({
          code: "MULTIPLE_UNCONDITIONAL_OUTGOING",
          elementRef: flowNode.id,
          message: `Flow node "${flowNode.id ?? flowNode.$type}" has multiple unconditional outgoing SequenceFlows`,
          severity: "warning"
        });
      }
    }
  }

  return diagnostics;
}

export function createModelView(model: SemanticModel): InspectionEnvelope {
  const envelope = baseEnvelope(model, "model");
  const semanticElements = model.allElements.filter(isAddressableBpmnElement);
  const processes = model.definitions.rootElements.filter((element) =>
    element.$instanceOf("bpmn:Process")
  );
  const collaborations = model.definitions.rootElements.filter((element) =>
    element.$instanceOf("bpmn:Collaboration")
  );

  envelope.model = {
    definitions: shallowProjection(model.definitions),
    rootElements: model.definitions.rootElements.map(shallowProjection)
  };
  envelope.analysis = {
    ...envelope.analysis,
    sourceMetadata: {
      executionPlatform:
        model.definitions.$attrs?.["modeler:executionPlatform"] ?? null,
      executionPlatformVersion:
        model.definitions.$attrs?.["modeler:executionPlatformVersion"] ?? null
    },
    totals: {
      semanticElements: semanticElements.length,
      countsByType: countByType(semanticElements)
    },
    processes: processes.map((process) => ({
      ...containerSummary(model, process),
      nestedContainerRefs: descendantsOf(model, process)
        .filter(isContainer)
        .map(({ id }) => id ?? null)
    })),
    collaborations: collaborations.map((collaboration) => ({
      element: collaborationProjection(collaboration),
      participantCount:
        ((collaboration.get("participants") as unknown[] | undefined)?.length ??
          0),
      messageFlowCount:
        ((collaboration.get("messageFlows") as unknown[] | undefined)?.length ??
          0)
    }))
  };

  return envelope;
}

export function createProcessView(
  model: SemanticModel,
  processId: string
): InspectionEnvelope | undefined {
  const process = model.byId.get(processId);

  if (process === undefined || !process.$instanceOf("bpmn:Process")) {
    return undefined;
  }

  const descendants = descendantsOf(model, process).filter(isBpmnBaseElement);
  const addressableDescendants = descendants.filter(isAddressableBpmnElement);
  const containers = [process, ...descendants.filter(isContainer)];
  const diagnostics = processDiagnostics(model, process);
  const envelope = baseEnvelope(model, "process", diagnostics);
  const processElements = new Set([process, ...descendants]);
  const collaborations = model.definitions.rootElements
    .filter((element) => element.$instanceOf("bpmn:Collaboration"))
    .flatMap((collaboration) => {
      const participants =
        (collaboration.get("participants") as ModdleElement[] | undefined) ?? [];
      const processParticipants = participants.filter(
        (participant) => participant.get("processRef") === process
      );
      const interactionNodes = new Set([
        ...processElements,
        ...processParticipants
      ]);
      const messageFlows =
        (collaboration.get("messageFlows") as ModdleElement[] | undefined) ?? [];
      const relevantMessageFlows = messageFlows.filter(
        (messageFlow) =>
          interactionNodes.has(messageFlow.get("sourceRef") as ModdleElement) ||
          interactionNodes.has(messageFlow.get("targetRef") as ModdleElement)
      );

      if (
        processParticipants.length === 0 &&
        relevantMessageFlows.length === 0
      ) {
        return [];
      }

      return [
        {
          element: collaborationProjection(collaboration),
          participantRefs: processParticipants.map(({ id }) => id ?? null),
          messageFlowRefs: relevantMessageFlows.map(({ id }) => id ?? null)
        }
      ];
    });

  envelope.process = shallowProjection(process);
  envelope.analysis = {
    ...envelope.analysis,
    countsByType: countByType(addressableDescendants),
    conditionCount: conditionCount(addressableDescendants),
    containers: containers.map((container) =>
      containerSummary(model, container)
    ),
    startEventRefs: descendants
      .filter(({ $type }) => $type === "bpmn:StartEvent")
      .map(({ id }) => id ?? null),
    endEventRefs: descendants
      .filter(({ $type }) => $type === "bpmn:EndEvent")
      .map(({ id }) => id ?? null),
    collaborations,
    referencedRootElements: referencedRoots(model, descendants).map(
      shallowProjection
    )
  };

  return envelope;
}

export interface ScopePageOptions {
  limit: number;
  offset: number;
}

export interface ScopePageResult {
  envelope: InspectionEnvelope;
  nextOffset?: number;
}

function projectedPropertyValue(
  element: ModdleElement,
  propertyName: string
): JsonValue | undefined {
  const property = element.$descriptor.properties.find(
    ({ name }) => name === propertyName
  );

  if (property === undefined) {
    return undefined;
  }

  const value = element.get(propertyName);
  const projectOne = (entry: unknown): JsonValue | undefined =>
    isModdleElement(entry) ? projectElement(entry).value : undefined;

  if (Array.isArray(value)) {
    return value
      .map(projectOne)
      .filter((entry): entry is JsonValue => entry !== undefined);
  }

  return projectOne(value);
}

function omissionMetadata(element: ModdleElement): JsonObject[] {
  const omitted: JsonObject[] = [];

  for (const propertyName of SCOPE_RECORD_OMISSIONS) {
    const value = element.get(propertyName);

    if (
      value === undefined ||
      value === null ||
      (Array.isArray(value) && value.length === 0)
    ) {
      continue;
    }

    const projected = projectedPropertyValue(element, propertyName);
    const serialized = JSON.stringify(projected ?? null);

    omitted.push({
      elementRef: element.id ?? null,
      property: propertyName,
      bytes: Buffer.byteLength(serialized ?? ""),
      sha256: createHash("sha256").update(serialized ?? "").digest("hex"),
      reason: "bounded-scope-view"
    });
  }

  return omitted;
}

export function createScopeView(
  model: SemanticModel,
  scopeId: string,
  options: ScopePageOptions
): ScopePageResult | undefined {
  const scope = model.byId.get(scopeId);

  if (scope === undefined || !isContainer(scope)) {
    return undefined;
  }

  const members = [
    ...directFlowElements(scope).map((element) => ({
      element,
      kind: "flowElement" as const
    })),
    ...directArtifacts(scope).map((element) => ({
      element,
      kind: "artifact" as const
    }))
  ];
  const selected = members.slice(options.offset, options.offset + options.limit);
  const projections = selected.map(({ element, kind }) => ({
    ...scopeRecordProjection(element),
    element,
    kind
  }));
  const diagnostics = projections.flatMap(({ diagnostics: itemDiagnostics }) =>
    itemDiagnostics.map(normalizeProjectionDiagnostic)
  );
  const envelope = baseEnvelope(model, "scope", diagnostics);
  const nextOffset =
    options.offset + selected.length < members.length
      ? options.offset + selected.length
      : undefined;

  envelope.scope = shallowProjection(scope);
  envelope.flowElements = projections
    .filter(({ kind }) => kind === "flowElement")
    .map(({ value }) => value);
  envelope.artifacts = projections
    .filter(({ kind }) => kind === "artifact")
    .map(({ value }) => value);
  envelope.analysis = {
    ...envelope.analysis,
    omittedProperties: projections.flatMap(({ element }) =>
      omissionMetadata(element)
    )
  };
  envelope.page = {
    offset: options.offset,
    limit: options.limit,
    returned: selected.length,
    total: members.length,
    nextCursor: null
  };

  return { envelope, nextOffset };
}

function relatedProjection(element: ModdleElement): JsonObject {
  return scopeRecordProjection(element).value;
}

function uniqueElements(elements: readonly ModdleElement[]): ModdleElement[] {
  return [...new Set(elements)];
}

export function createElementView(
  model: SemanticModel,
  elementId: string,
  all = false
): InspectionEnvelope | undefined {
  const element = model.byId.get(elementId);

  if (element === undefined || isHardExcludedElement(element)) {
    return undefined;
  }

  const projection = projectElement(element, {
    omitProperties: all ? undefined : ELEMENT_OMISSIONS
  });
  const envelope = baseEnvelope(
    model,
    "element",
    projection.diagnostics.map(normalizeProjectionDiagnostic)
  );
  const process = processOf(element);
  const container = containerOf(element);
  const incomingValue = element.get("incoming");
  const outgoingValue = element.get("outgoing");
  const incoming = (Array.isArray(incomingValue) ? incomingValue : []).filter(
    isModdleElement
  );
  const outgoing = (Array.isArray(outgoingValue) ? outgoingValue : []).filter(
    isModdleElement
  );
  const attachedBoundaryEvents = model.allElements.filter(
    (candidate) =>
      candidate.$type === "bpmn:BoundaryEvent" &&
      candidate.get("attachedToRef") === element
  );
  const source = element.get("sourceRef");
  const target = element.get("targetRef");
  const references = referenceElements(element);

  envelope.element = projection.value;
  envelope.context = {
    processRef: process?.id ?? null,
    containerRef: container?.id ?? null,
    incomingSequenceFlows: incoming.map(relatedProjection),
    outgoingSequenceFlows: outgoing.map(relatedProjection),
    sourceElement: isModdleElement(source) ? relatedProjection(source) : null,
    targetElement: isModdleElement(target) ? relatedProjection(target) : null,
    attachedBoundaryEvents: attachedBoundaryEvents.map(relatedProjection),
    referencedElements: uniqueElements(references)
      .filter((reference) => reference !== source && reference !== target)
      .map(relatedProjection)
  };

  return envelope;
}

export function createFullProcessProjection(
  model: SemanticModel,
  processId: string
): InspectionEnvelope | undefined {
  const process = model.byId.get(processId);

  if (process === undefined || !process.$instanceOf("bpmn:Process")) {
    return undefined;
  }

  const projection = projectElement(process);
  const descendants = descendantsOf(model, process);
  const envelope = baseEnvelope(
    model,
    "process",
    projection.diagnostics.map(normalizeProjectionDiagnostic)
  );

  envelope.process = projection.value;
  envelope.relatedRootElements = referencedRoots(model, descendants).map(
    (root) => projectElement(root).value
  );

  return envelope;
}

export function allSemanticElements(model: SemanticModel): ModdleElement[] {
  return model.allElements.filter(
    (element) => isBpmnBaseElement(element) || element.$type.includes(":")
  );
}
