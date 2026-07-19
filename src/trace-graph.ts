import type { ModdleElement } from "bpmn-moddle";

import { typedDescriptorProperties } from "./moddle.js";
import {
  projectElement,
  type JsonObject,
  type JsonValue
} from "./project.js";
import type {
  InspectionDiagnostic,
  SemanticModel
} from "./semantic.js";

export type TraceMode = "backward" | "connecting" | "forward";

export interface TraceSelectionOptions {
  all: boolean;
  followMessageFlows: boolean;
  from?: string;
  limit: number;
  to?: string;
}

export interface TraceEnvelope extends JsonObject {
  analysis: JsonObject;
  profiles: JsonValue[];
  schemaVersion: "1";
  semanticHash: string;
  source: JsonObject;
  trace: JsonObject;
  view: "trace";
}

type EdgeKind =
  | "boundary"
  | "cancel"
  | "compensation"
  | "error"
  | "escalation"
  | "eventSubprocess"
  | "link"
  | "messageFlow"
  | "scopeCompletion"
  | "scopeEntry"
  | "sequence"
  | "signal";

interface TraceEdge {
  from: ModdleElement;
  kind: EdgeKind;
  scope?: ModdleElement;
  to: ModdleElement;
}

interface TraceGraph {
  backward: Map<ModdleElement, TraceEdge[]>;
  edges: TraceEdge[];
  forward: Map<ModdleElement, TraceEdge[]>;
}

interface TraversalResult {
  order: ModdleElement[];
  visited: Set<ModdleElement>;
}

const TRACE_OMISSIONS = new Set([
  "artifacts",
  "documentation",
  "extensionElements",
  "flowElements",
  "laneSets",
  "modelerTemplate",
  "modelerTemplateVersion",
  "rootElements"
]);

const SCOPE_OMISSIONS = new Set([
  ...TRACE_OMISSIONS,
  "incoming",
  "outgoing"
]);

const EVENT_EDGE_KINDS = new Set<EdgeKind>([
  "boundary",
  "cancel",
  "compensation",
  "error",
  "escalation",
  "eventSubprocess",
  "link",
  "signal"
]);

export class TraceGraphError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function isModdleElement(value: unknown): value is ModdleElement {
  return typeof value === "object" && value !== null && "$type" in value;
}

function referenceArray(
  element: ModdleElement,
  property: string
): ModdleElement[] {
  const value = element.get(property);

  if (Array.isArray(value)) {
    return value.filter(isModdleElement);
  }

  return isModdleElement(value) ? [value] : [];
}

function isFlowNode(element: ModdleElement): boolean {
  return element.$instanceOf("bpmn:FlowNode");
}

function isSequenceFlow(element: ModdleElement): boolean {
  return element.$type === "bpmn:SequenceFlow";
}

function isMessageFlow(element: ModdleElement): boolean {
  return element.$type === "bpmn:MessageFlow";
}

function isContainer(element: ModdleElement): boolean {
  return element.$instanceOf("bpmn:FlowElementsContainer");
}

function isTriggeredSubProcess(element: ModdleElement): boolean {
  return (
    element.$type === "bpmn:SubProcess" &&
    element.get("triggeredByEvent") === true
  );
}

function isAdHocSubProcess(element: ModdleElement): boolean {
  return element.$type === "bpmn:AdHocSubProcess";
}

function parentScope(element: ModdleElement): ModdleElement | undefined {
  let parent = element.$parent;

  while (parent !== undefined) {
    if (isContainer(parent)) {
      return parent;
    }

    parent = parent.$parent;
  }

  return undefined;
}

function ancestorScopes(element: ModdleElement): ModdleElement[] {
  const scopes: ModdleElement[] = [];
  let current = parentScope(element);

  while (current !== undefined) {
    scopes.push(current);
    current = parentScope(current);
  }

  return scopes;
}

function processOf(element: ModdleElement): ModdleElement | undefined {
  return ancestorScopes(element).find((scope) =>
    scope.$instanceOf("bpmn:Process")
  );
}

function isAncestor(
  ancestor: ModdleElement,
  element: ModdleElement
): boolean {
  let parent = element.$parent;

  while (parent !== undefined) {
    if (parent === ancestor) {
      return true;
    }

    parent = parent.$parent;
  }

  return false;
}

function addEdge(graph: TraceGraph, edge: TraceEdge): void {
  if (
    edge.from.id === undefined ||
    edge.to.id === undefined ||
    graph.edges.some(
      (candidate) =>
        candidate.from === edge.from &&
        candidate.to === edge.to &&
        candidate.kind === edge.kind
    )
  ) {
    return;
  }

  graph.edges.push(edge);
  graph.forward.set(edge.from, [
    ...(graph.forward.get(edge.from) ?? []),
    edge
  ]);
  graph.backward.set(edge.to, [
    ...(graph.backward.get(edge.to) ?? []),
    edge
  ]);
}

function directFlowNodes(scope: ModdleElement): ModdleElement[] {
  return (scope.flowElements ?? []).filter(isFlowNode);
}

function scopeEntryNodes(scope: ModdleElement): ModdleElement[] {
  const nodes = directFlowNodes(scope);
  const starts = nodes.filter(
    (element) => element.$type === "bpmn:StartEvent"
  );

  return starts.length > 0
    ? starts
    : nodes.filter((element) => referenceArray(element, "incoming").length === 0);
}

function isAbnormalScopeTerminationEnd(element: ModdleElement): boolean {
  return (
    element.$type === "bpmn:EndEvent" &&
    eventDefinitions(element).some(
      ({ $type }) =>
        $type === "bpmn:ErrorEventDefinition" ||
        $type === "bpmn:CancelEventDefinition"
    )
  );
}

function scopeCompletionNodes(scope: ModdleElement): ModdleElement[] {
  const nodes = directFlowNodes(scope);
  const ends = nodes.filter(
    (element) =>
      element.$type === "bpmn:EndEvent" &&
      !isAbnormalScopeTerminationEnd(element)
  );

  return ends.length > 0
    ? ends
    : nodes.filter(
        (element) =>
          !isAbnormalScopeTerminationEnd(element) &&
          referenceArray(element, "outgoing").length === 0
      );
}

function eventDefinitions(element: ModdleElement): ModdleElement[] {
  return [
    ...referenceArray(element, "eventDefinitions"),
    ...referenceArray(element, "eventDefinitionRef")
  ];
}

function eventOfDefinition(
  definition: ModdleElement
): ModdleElement | undefined {
  let parent = definition.$parent;

  while (parent !== undefined) {
    if (
      parent.$instanceOf("bpmn:CatchEvent") ||
      parent.$instanceOf("bpmn:ThrowEvent")
    ) {
      return parent;
    }

    parent = parent.$parent;
  }

  return undefined;
}

function matchingReference(
  left: ModdleElement,
  right: ModdleElement,
  property: string
): boolean {
  const expected = left.get(property);
  const actual = right.get(property);

  return actual === undefined || (expected !== undefined && actual === expected);
}

function catchHandlerDepth(
  throwingEvent: ModdleElement,
  catchingEvent: ModdleElement
): number | undefined {
  const scopes = ancestorScopes(throwingEvent);

  if (catchingEvent.$type === "bpmn:BoundaryEvent") {
    const attached = catchingEvent.get("attachedToRef");

    if (!isModdleElement(attached) || !isAncestor(attached, throwingEvent)) {
      return undefined;
    }

    const index = scopes.indexOf(attached);
    return index >= 0 ? index : undefined;
  }

  if (catchingEvent.$type !== "bpmn:StartEvent") {
    return undefined;
  }

  const eventSubProcess = parentScope(catchingEvent);

  if (
    eventSubProcess === undefined ||
    !isTriggeredSubProcess(eventSubProcess)
  ) {
    return undefined;
  }
  const containingScope = parentScope(eventSubProcess);
  const index =
    containingScope === undefined ? -1 : scopes.indexOf(containingScope);

  return index >= 0 ? index : undefined;
}

function eventTransitionKind(
  definition: ModdleElement
):
  | {
      kind: "error" | "escalation";
      referenceProperty: "errorRef" | "escalationRef";
    }
  | {
      kind: "cancel";
    }
  | undefined {
  if (definition.$type === "bpmn:ErrorEventDefinition") {
    return { kind: "error", referenceProperty: "errorRef" };
  }

  if (definition.$type === "bpmn:EscalationEventDefinition") {
    return { kind: "escalation", referenceProperty: "escalationRef" };
  }

  return definition.$type === "bpmn:CancelEventDefinition"
    ? { kind: "cancel" }
    : undefined;
}

function isCancelHandler(
  throwingEvent: ModdleElement,
  catchingEvent: ModdleElement
): boolean {
  if (catchingEvent.$type !== "bpmn:BoundaryEvent") {
    return false;
  }

  const attached = catchingEvent.get("attachedToRef");
  return (
    isModdleElement(attached) &&
    attached.$type === "bpmn:Transaction" &&
    isAncestor(attached, throwingEvent)
  );
}

function addEventDefinitionEdges(
  model: SemanticModel,
  graph: TraceGraph
): void {
  const definitions = model.allElements.filter((element) =>
    element.$type.endsWith("EventDefinition")
  );
  const catchDefinitions = definitions.filter((definition) => {
    const event = eventOfDefinition(definition);
    return event?.$instanceOf("bpmn:CatchEvent") ?? false;
  });

  for (const throwingDefinition of definitions) {
    const throwingEvent = eventOfDefinition(throwingDefinition);

    if (
      throwingEvent === undefined ||
      !throwingEvent.$instanceOf("bpmn:ThrowEvent")
    ) {
      continue;
    }

    if (throwingDefinition.$type === "bpmn:LinkEventDefinition") {
      for (const target of referenceArray(throwingDefinition, "target")) {
        const targetEvent = eventOfDefinition(target);

        if (targetEvent !== undefined) {
          addEdge(graph, {
            from: throwingEvent,
            kind: "link",
            to: targetEvent
          });
        }
      }
      continue;
    }

    if (throwingDefinition.$type === "bpmn:SignalEventDefinition") {
      for (const catchingDefinition of catchDefinitions) {
        const catchingEvent = eventOfDefinition(catchingDefinition);

        if (
          catchingDefinition.$type === "bpmn:SignalEventDefinition" &&
          catchingEvent !== undefined &&
          matchingReference(
            throwingDefinition,
            catchingDefinition,
            "signalRef"
          ) &&
          processOf(throwingEvent) === processOf(catchingEvent)
        ) {
          addEdge(graph, {
            from: throwingEvent,
            kind: "signal",
            to: catchingEvent
          });
        }
      }
      continue;
    }

    if (throwingDefinition.$type === "bpmn:CompensateEventDefinition") {
      const activity = throwingDefinition.get("activityRef");

      if (isModdleElement(activity)) {
        const handlers = model.allElements.filter(
          (element) =>
            element.$type === "bpmn:BoundaryEvent" &&
            element.get("attachedToRef") === activity &&
            eventDefinitions(element).some(
              ({ $type }) => $type === "bpmn:CompensateEventDefinition"
            )
        );

        for (const association of model.allElements.filter(
          (element) => element.$type === "bpmn:Association"
        )) {
          const source = association.get("sourceRef");
          const target = association.get("targetRef");

          if (
            isModdleElement(source) &&
            handlers.includes(source) &&
            isModdleElement(target) &&
            target.get("isForCompensation") === true
          ) {
            addEdge(graph, {
              from: throwingEvent,
              kind: "compensation",
              to: target
            });
          }
        }
      }
      continue;
    }

    const transition = eventTransitionKind(throwingDefinition);

    if (transition === undefined) {
      continue;
    }

    const matches = catchDefinitions
      .filter((definition) => {
        if (definition.$type !== throwingDefinition.$type) {
          return false;
        }

        if (transition.kind === "cancel") {
          const catchingEvent = eventOfDefinition(definition);
          return (
            catchingEvent !== undefined &&
            isCancelHandler(throwingEvent, catchingEvent)
          );
        }

        return matchingReference(
          throwingDefinition,
          definition,
          transition.referenceProperty
        );
      })
      .map((definition) => ({
        depth: catchHandlerDepth(
          throwingEvent,
          eventOfDefinition(definition) as ModdleElement
        ),
        event: eventOfDefinition(definition)
      }))
      .filter(
        (
          candidate
        ): candidate is { depth: number; event: ModdleElement } =>
          candidate.depth !== undefined && candidate.event !== undefined
      );
    const nearest = Math.min(...matches.map(({ depth }) => depth));

    for (const match of matches.filter(({ depth }) => depth === nearest)) {
      addEdge(graph, {
        from: throwingEvent,
        kind: transition.kind,
        to: match.event
      });
    }
  }
}

function buildGraph(model: SemanticModel): TraceGraph {
  const graph: TraceGraph = {
    backward: new Map(),
    edges: [],
    forward: new Map()
  };

  for (const element of model.allElements) {
    if (isSequenceFlow(element)) {
      const source = element.get("sourceRef");
      const target = element.get("targetRef");

      if (isModdleElement(source) && isModdleElement(target)) {
        if (
          !(
            source.$instanceOf("bpmn:SubProcess") &&
            !isAdHocSubProcess(source)
          )
        ) {
          addEdge(graph, {
            from: source,
            kind: "sequence",
            to: element
          });
        }

        addEdge(graph, {
          from: element,
          kind: "sequence",
          to: target
        });
      }
    }

    if (element.$type === "bpmn:BoundaryEvent") {
      const attached = element.get("attachedToRef");

      if (isModdleElement(attached)) {
        addEdge(graph, {
          from: attached,
          kind: "boundary",
          to: element
        });
      }
    }
  }

  for (const scope of model.allElements.filter((element) =>
    element.$instanceOf("bpmn:SubProcess")
  )) {
    if (isTriggeredSubProcess(scope)) {
      const containingScope = parentScope(scope);

      if (containingScope !== undefined) {
        for (const entry of scopeEntryNodes(scope)) {
          addEdge(graph, {
            from: containingScope,
            kind: "eventSubprocess",
            scope,
            to: entry
          });
        }
      }
      continue;
    }

    for (const entry of scopeEntryNodes(scope)) {
      addEdge(graph, {
        from: scope,
        kind: "scopeEntry",
        scope,
        to: entry
      });
    }

    const outgoing = referenceArray(scope, "outgoing");

    if (isAdHocSubProcess(scope)) {
      for (const sequenceFlow of outgoing) {
        addEdge(graph, {
          from: scope,
          kind: "scopeCompletion",
          scope,
          to: sequenceFlow
        });
      }
    } else {
      for (const completion of scopeCompletionNodes(scope)) {
        for (const sequenceFlow of outgoing) {
          addEdge(graph, {
            from: completion,
            kind: "scopeCompletion",
            scope,
            to: sequenceFlow
          });
        }
      }
    }
  }

  for (const messageFlow of model.allElements.filter(isMessageFlow)) {
    const source = messageFlow.get("sourceRef");
    const target = messageFlow.get("targetRef");

    if (isModdleElement(source) && isModdleElement(target)) {
      addEdge(graph, {
        from: source,
        kind: "messageFlow",
        to: messageFlow
      });
      addEdge(graph, {
        from: messageFlow,
        kind: "messageFlow",
        to: target
      });
    }
  }

  addEventDefinitionEdges(model, graph);

  for (const association of model.allElements.filter(
    (element) => element.$type === "bpmn:Association"
  )) {
    const source = association.get("sourceRef");
    const target = association.get("targetRef");

    if (
      isModdleElement(source) &&
      isModdleElement(target) &&
      eventDefinitions(source).some(
        ({ $type }) => $type === "bpmn:CompensateEventDefinition"
      ) &&
      target.get("isForCompensation") === true
    ) {
      addEdge(graph, {
        from: source,
        kind: "compensation",
        to: target
      });
    }
  }

  return graph;
}

function enabledEdge(
  edge: TraceEdge,
  followMessageFlows: boolean
): boolean {
  return edge.kind !== "messageFlow" || followMessageFlows;
}

function activeEventSubprocessEdges(
  graph: TraceGraph,
  element: ModdleElement
): TraceEdge[] {
  return ancestorScopes(element).flatMap((scope) =>
    (graph.forward.get(scope) ?? []).filter(
      ({ kind }) => kind === "eventSubprocess"
    )
  );
}

function traversalEdges(
  graph: TraceGraph,
  element: ModdleElement,
  direction: "backward" | "forward",
  followMessageFlows: boolean
): TraceEdge[] {
  if (element.$type === "bpmn:Participant") {
    return [];
  }

  const edges =
    direction === "forward"
      ? graph.forward.get(element) ?? []
      : graph.backward.get(element) ?? [];
  const contextual =
    direction === "forward"
      ? activeEventSubprocessEdges(graph, element)
      : [];

  return [...edges, ...contextual].filter((edge) =>
    enabledEdge(edge, followMessageFlows)
  );
}

function adjacentElement(
  edge: TraceEdge,
  direction: "backward" | "forward"
): ModdleElement {
  return direction === "forward" ? edge.to : edge.from;
}

function traverse(
  graph: TraceGraph,
  seed: ModdleElement,
  direction: "backward" | "forward",
  followMessageFlows: boolean,
  allowed?: ReadonlySet<ModdleElement>
): TraversalResult {
  const queue = [seed];
  const visited = new Set<ModdleElement>();
  const order: ModdleElement[] = [];

  while (queue.length > 0) {
    const element = queue.shift() as ModdleElement;

    if (
      visited.has(element) ||
      (allowed !== undefined && !allowed.has(element))
    ) {
      continue;
    }

    visited.add(element);
    order.push(element);

    for (const edge of traversalEdges(
      graph,
      element,
      direction,
      followMessageFlows
    )) {
      const adjacent = adjacentElement(edge, direction);

      if (!visited.has(adjacent)) {
        queue.push(adjacent);
      }
    }
  }

  return { order, visited };
}

function shortestPath(
  graph: TraceGraph,
  from: ModdleElement,
  to: ModdleElement,
  followMessageFlows: boolean,
  allowed: ReadonlySet<ModdleElement>
): ModdleElement[] | undefined {
  const queue = [from];
  const visited = new Set([from]);
  const previous = new Map<ModdleElement, ModdleElement>();

  while (queue.length > 0) {
    const element = queue.shift() as ModdleElement;

    if (element === to) {
      const path: ModdleElement[] = [];
      let current: ModdleElement | undefined = to;

      while (current !== undefined) {
        path.unshift(current);
        current = previous.get(current);
      }

      return path;
    }

    for (const edge of traversalEdges(
      graph,
      element,
      "forward",
      followMessageFlows
    )) {
      const adjacent = edge.to;

      if (allowed.has(adjacent) && !visited.has(adjacent)) {
        visited.add(adjacent);
        previous.set(adjacent, element);
        queue.push(adjacent);
      }
    }
  }

  return undefined;
}

function traceMode(options: TraceSelectionOptions): TraceMode {
  return options.from !== undefined && options.to !== undefined
    ? "connecting"
    : options.from !== undefined
      ? "forward"
      : "backward";
}

function endpoint(
  model: SemanticModel,
  id: string | undefined,
  followMessageFlows: boolean,
  option: "--from" | "--to"
): ModdleElement | undefined {
  if (id === undefined) {
    return undefined;
  }

  const element = model.byId.get(id);

  if (element === undefined) {
    throw new TraceGraphError(
      "SELECTOR_NOT_FOUND",
      `Unable to find ${option} element "${id}"`
    );
  }

  if (
    !isFlowNode(element) &&
    !isSequenceFlow(element) &&
    !(followMessageFlows && isMessageFlow(element))
  ) {
    throw new TraceGraphError(
      "UNSUPPORTED_TRACE_ENDPOINT",
      `${option} element "${id}" must be a FlowNode or SequenceFlow${
        followMessageFlows ? " or MessageFlow" : ""
      }`
    );
  }

  return element;
}

function requiredScopes(elements: Iterable<ModdleElement>): ModdleElement[] {
  const result: ModdleElement[] = [];

  for (const element of elements) {
    for (const scope of ancestorScopes(element).reverse()) {
      if (!result.includes(scope)) {
        result.push(scope);
      }
    }
  }

  return result;
}

function messageFlowCompanions(element: ModdleElement): ModdleElement[] {
  if (!isMessageFlow(element)) {
    return [];
  }

  return ["sourceRef", "targetRef"]
    .flatMap((property) => referenceArray(element, property))
    .filter(({ $type }) => $type === "bpmn:Participant");
}

function addWithContext(
  selected: Set<ModdleElement>,
  ordered: ModdleElement[],
  element: ModdleElement,
  limit: number
): boolean {
  const additions = [
    ...requiredScopes([element]),
    element,
    ...messageFlowCompanions(element)
  ].filter((candidate) => !selected.has(candidate));

  if (selected.size + additions.length > limit) {
    return false;
  }

  for (const addition of additions) {
    selected.add(addition);
    ordered.push(addition);
  }

  return true;
}

function relatedMessageFlows(
  model: SemanticModel,
  elements: ReadonlySet<ModdleElement>
): ModdleElement[] {
  return model.allElements.filter(
    (element) =>
      isMessageFlow(element) &&
      (referenceArray(element, "sourceRef").some(
        (value) => value.$type !== "bpmn:Participant" && elements.has(value)
      ) ||
        referenceArray(element, "targetRef").some(
          (value) => value.$type !== "bpmn:Participant" && elements.has(value)
        ))
  );
}

function referencedRootElements(
  model: SemanticModel,
  elements: Iterable<ModdleElement>
): ModdleElement[] {
  const roots = new Set(model.definitions.rootElements);
  const result: ModdleElement[] = [];
  const visited = new Set<ModdleElement>();

  const visit = (element: ModdleElement): void => {
    if (visited.has(element)) {
      return;
    }

    visited.add(element);

    for (const property of typedDescriptorProperties(element)) {
      const values = referenceArray(element, property.name);

      if (property.isReference) {
        for (const value of values) {
          if (roots.has(value) && !result.includes(value)) {
            result.push(value);
          }
        }
      } else {
        const contained = element.get(property.name);
        const children = Array.isArray(contained) ? contained : [contained];

        for (const child of children) {
          if (isModdleElement(child)) {
            visit(child);
          }
        }
      }
    }
  };

  for (const element of elements) {
    visit(element);
  }

  return result;
}

function relatedReferences(
  elements: Iterable<ModdleElement>
): ModdleElement[] {
  const result: ModdleElement[] = [];
  const visited = new Set<ModdleElement>();

  const visit = (element: ModdleElement): void => {
    if (visited.has(element)) {
      return;
    }

    visited.add(element);

    for (const property of typedDescriptorProperties(element)) {
      const value = element.get(property.name);
      const values = Array.isArray(value) ? value : [value];

      for (const candidate of values) {
        if (!isModdleElement(candidate)) {
          continue;
        }

        if (property.isReference) {
          if (!result.includes(candidate)) {
            result.push(candidate);
          }
        } else {
          visit(candidate);
        }
      }
    }
  };

  for (const element of elements) {
    visit(element);
  }

  return result;
}

function isTraceDataElement(element: ModdleElement): boolean {
  return new Set([
    "bpmn:DataInput",
    "bpmn:DataObject",
    "bpmn:DataObjectReference",
    "bpmn:DataOutput",
    "bpmn:DataStoreReference"
  ]).has(element.$type);
}

function relatedContextElements(
  model: SemanticModel,
  selected: ReadonlySet<ModdleElement>
): ModdleElement[] {
  const result: ModdleElement[] = [];
  const add = (element: ModdleElement): void => {
    if (!selected.has(element) && !result.includes(element)) {
      result.push(element);
    }
  };

  for (const element of relatedReferences(selected)) {
    if (isTraceDataElement(element)) {
      add(element);
    }
  }

  for (const lane of model.allElements.filter(
    (element) => element.$type === "bpmn:Lane"
  )) {
    if (
      referenceArray(lane, "flowNodeRef").some((node) => selected.has(node))
    ) {
      const laneSet = lane.$parent;

      if (laneSet !== undefined && laneSet.$type === "bpmn:LaneSet") {
        add(laneSet);
      }
      add(lane);
    }
  }

  for (const association of model.allElements.filter(
    (element) => element.$type === "bpmn:Association"
  )) {
    const endpoints = [
      ...referenceArray(association, "sourceRef"),
      ...referenceArray(association, "targetRef")
    ];

    if (endpoints.some((endpoint) => selected.has(endpoint))) {
      add(association);

      for (const endpoint of endpoints) {
        if (endpoint.$instanceOf("bpmn:Artifact")) {
          add(endpoint);
        }
      }
    }
  }

  return result;
}

function compactProjection(element: ModdleElement): JsonObject {
  return projectElement(element, {
    omitProperties: TRACE_OMISSIONS
  }).value;
}

function scopeProjection(element: ModdleElement): JsonObject {
  return projectElement(element, {
    omitProperties: SCOPE_OMISSIONS
  }).value;
}

function profileProjection(model: SemanticModel): JsonValue[] {
  return model.profiles.map(
    (profile) =>
      Object.fromEntries(
        Object.entries(profile).filter(([, value]) => value !== undefined)
      ) as JsonObject
  );
}

function scopeRecords(
  selected: ReadonlySet<ModdleElement>,
  ordered: readonly ModdleElement[]
): JsonObject[] {
  const scopes = requiredScopes(ordered).filter((scope) => selected.has(scope));

  return scopes.map((scope) => {
    const flowElements = (scope.flowElements ?? [])
      .filter((element) => selected.has(element))
      .map(compactProjection);
    const artifacts = (scope.artifacts ?? [])
      .filter((element) => selected.has(element))
      .map(compactProjection);
    const laneSets = referenceArray(scope, "laneSets")
      .filter((laneSet) => selected.has(laneSet))
      .map((laneSet) => {
        const projection = compactProjection(laneSet);
        const lanes = referenceArray(laneSet, "lanes")
          .filter((lane) => selected.has(lane))
          .map((lane) => {
            const laneProjection = compactProjection(lane);
            laneProjection.flowNodeRef = referenceArray(lane, "flowNodeRef")
              .filter((node) => selected.has(node))
              .map(({ id }) => id ?? null);
            return laneProjection;
          });

        projection.lanes = lanes;
        return projection;
      });

    return {
      scope: scopeProjection(scope),
      flowElements,
      ...(laneSets.length === 0 ? {} : { laneSets }),
      ...(artifacts.length === 0 ? {} : { artifacts })
    };
  });
}

function relevantDiagnostics(
  diagnostics: readonly InspectionDiagnostic[],
  selected: ReadonlySet<ModdleElement>
): JsonValue[] {
  const ids = new Set(
    [...selected]
      .map(({ id }) => id)
      .filter((id): id is string => id !== undefined)
  );

  return diagnostics
    .filter(
      ({ code, elementRef }) =>
        elementRef === undefined ||
        ids.has(elementRef) ||
        code === "PROFILE_DISABLED_DATA_IGNORED"
    )
    .map((diagnostic) => diagnostic as unknown as JsonObject);
}

function branchAnalysis(
  selected: ReadonlySet<ModdleElement>
): JsonObject[] {
  const records: JsonObject[] = [];

  for (const gateway of selected) {
    if (!gateway.$instanceOf("bpmn:Gateway")) {
      continue;
    }

    const defaultFlow = gateway.get("default");

    for (const sequenceFlow of referenceArray(gateway, "outgoing")) {
      if (!selected.has(sequenceFlow)) {
        continue;
      }

      records.push({
        gatewayRef: gateway.id ?? null,
        sequenceFlowRef: sequenceFlow.id ?? null,
        kind:
          sequenceFlow === defaultFlow
            ? "default"
            : sequenceFlow.get("conditionExpression") === undefined
              ? "unconditional"
              : "conditioned"
      });
    }
  }

  return records;
}

function transitionAnalysis(
  graph: TraceGraph,
  selected: ReadonlySet<ModdleElement>,
  kinds: ReadonlySet<EdgeKind>
): JsonObject[] {
  return graph.edges
    .filter(
      (edge) =>
        kinds.has(edge.kind) &&
        selected.has(edge.from) &&
        selected.has(edge.to)
    )
    .map((edge) => {
      const target =
        edge.kind === "scopeCompletion" &&
        edge.scope !== undefined &&
        edge.from !== edge.scope
          ? edge.scope
          : edge.to;

      return {
        kind:
          edge.kind === "scopeEntry"
            ? "entry"
            : edge.kind === "scopeCompletion"
              ? "completion"
              : edge.kind,
        sourceRef: edge.from.id ?? null,
        targetRef: target.id ?? null,
        ...(edge.scope?.id === undefined ? {} : { scopeRef: edge.scope.id })
      };
    });
}

function scopeCompensationAnalysis(
  selected: ReadonlySet<ModdleElement>
): JsonObject[] {
  const transitions: JsonObject[] = [];

  for (const event of [...selected].filter((element) =>
    element.$instanceOf("bpmn:ThrowEvent")
  )) {
    for (const definition of eventDefinitions(event)) {
      if (
        definition.$type !== "bpmn:CompensateEventDefinition" ||
        isModdleElement(definition.get("activityRef"))
      ) {
        continue;
      }

      const scope = parentScope(event);

      if (scope !== undefined && selected.has(scope)) {
        transitions.push({
          kind: "compensation",
          sourceRef: event.id ?? null,
          targetRef: scope.id ?? null,
          scopeRef: scope.id ?? null
        });
      }
    }
  }

  return transitions;
}

function scopeTransitionAnalysis(
  graph: TraceGraph,
  selected: ReadonlySet<ModdleElement>
): JsonObject[] {
  const transitions = transitionAnalysis(
    graph,
    selected,
    new Set(["scopeCompletion", "scopeEntry"])
  );

  for (const scope of [...selected].filter(
    (element) =>
      element.$instanceOf("bpmn:SubProcess") &&
      !isTriggeredSubProcess(element) &&
      !isAdHocSubProcess(element)
  )) {
    for (const completion of scopeCompletionNodes(scope)) {
      if (
        selected.has(completion) &&
        !transitions.some(
          ({ kind, scopeRef, sourceRef }) =>
            kind === "completion" &&
            scopeRef === scope.id &&
            sourceRef === completion.id
        )
      ) {
        transitions.push({
          kind: "completion",
          scopeRef: scope.id ?? null,
          sourceRef: completion.id ?? null,
          targetRef: scope.id ?? null
        });
      }
    }
  }

  return transitions;
}

function sequenceFlowCycles(
  selected: ReadonlySet<ModdleElement>
): JsonObject[] {
  const nodes = [...selected].filter(isFlowNode);
  const adjacency = new Map<ModdleElement, ModdleElement[]>();

  for (const node of nodes) {
    adjacency.set(
      node,
      referenceArray(node, "outgoing")
        .filter((flow) => selected.has(flow))
        .flatMap((flow) => referenceArray(flow, "targetRef"))
        .filter((target) => selected.has(target))
    );
  }

  let index = 0;
  const indexes = new Map<ModdleElement, number>();
  const lowLinks = new Map<ModdleElement, number>();
  const stack: ModdleElement[] = [];
  const onStack = new Set<ModdleElement>();
  const components: ModdleElement[][] = [];

  const discover = (node: ModdleElement): void => {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
  };

  for (const node of nodes) {
    if (!indexes.has(node)) {
      discover(node);
      const frames: Array<{
        nextAdjacentIndex: number;
        node: ModdleElement;
      }> = [{ node, nextAdjacentIndex: 0 }];

      while (frames.length > 0) {
        const frame = frames[frames.length - 1] as {
          nextAdjacentIndex: number;
          node: ModdleElement;
        };
        const adjacent = adjacency.get(frame.node) ?? [];

        if (frame.nextAdjacentIndex < adjacent.length) {
          const candidate = adjacent[frame.nextAdjacentIndex] as ModdleElement;
          frame.nextAdjacentIndex += 1;

          if (!indexes.has(candidate)) {
            discover(candidate);
            frames.push({ node: candidate, nextAdjacentIndex: 0 });
          } else if (onStack.has(candidate)) {
            lowLinks.set(
              frame.node,
              Math.min(
                lowLinks.get(frame.node) as number,
                indexes.get(candidate) as number
              )
            );
          }

          continue;
        }

        frames.pop();

        if (lowLinks.get(frame.node) === indexes.get(frame.node)) {
          const component: ModdleElement[] = [];
          let member: ModdleElement;

          do {
            member = stack.pop() as ModdleElement;
            onStack.delete(member);
            component.push(member);
          } while (member !== frame.node);

          const selfLoop =
            component.length === 1 &&
            (adjacency.get(component[0] as ModdleElement) ?? []).includes(
              component[0] as ModdleElement
            );

          if (component.length > 1 || selfLoop) {
            components.push(component);
          }
        }

        const parent = frames[frames.length - 1];

        if (parent !== undefined) {
          lowLinks.set(
            parent.node,
            Math.min(
              lowLinks.get(parent.node) as number,
              lowLinks.get(frame.node) as number
            )
          );
        }
      }
    }
  }

  return components.map((component) => {
    const members = new Set(component);
    const flows = component.flatMap((node) =>
      referenceArray(node, "outgoing").filter(
        (flow) =>
          selected.has(flow) &&
          referenceArray(flow, "targetRef").some((target) => members.has(target))
      )
    );

    return {
      scopeRef: parentScope(component[0] as ModdleElement)?.id ?? null,
      flowElementRefs: component.map(({ id }) => id ?? null),
      sequenceFlowRefs: [...new Set(flows)].map(({ id }) => id ?? null)
    };
  });
}

function activityLoops(
  selected: ReadonlySet<ModdleElement>
): JsonObject[] {
  return [...selected].flatMap((element) => {
    const loopCharacteristics = element.get("loopCharacteristics");

    return isModdleElement(loopCharacteristics)
      ? [
          {
            elementRef: element.id ?? null,
            loopCharacteristics: compactProjection(loopCharacteristics)
          }
        ]
      : [];
  });
}

function adHocScopes(
  selected: ReadonlySet<ModdleElement>
): JsonObject[] {
  return [...selected]
    .filter(isAdHocSubProcess)
    .map((scope) => ({
      scopeRef: scope.id ?? null,
      availableActivityRefs: directFlowNodes(scope)
        .filter(
          (node) =>
            node.$instanceOf("bpmn:Activity") &&
            referenceArray(node, "incoming").length === 0
        )
        .map(({ id }) => id ?? null)
    }));
}

function terminalAnalysis(
  graph: TraceGraph,
  selected: ReadonlySet<ModdleElement>,
  mode: TraceMode,
  followMessageFlows: boolean,
  frontier: ReadonlySet<ModdleElement>
): JsonObject {
  if (mode === "connecting") {
    return {};
  }

  const direction = mode === "forward" ? "forward" : "backward";
  const nodes = [...selected].filter(
    (element) =>
      isFlowNode(element) ||
      (followMessageFlows && element.$type === "bpmn:Participant")
  );
  const terminal = nodes.filter((node) => {
    if (frontier.has(node)) {
      return false;
    }

    if (node.$type === "bpmn:Participant") {
      return true;
    }

    const directEdges = (
      direction === "forward"
        ? graph.forward.get(node)
        : graph.backward.get(node)
    ) ?? [];

    return !directEdges.some(
      (edge) =>
        edge.kind !== "eventSubprocess" &&
        enabledEdge(edge, followMessageFlows) &&
        (selected.has(adjacentElement(edge, direction)) ||
          frontier.has(adjacentElement(edge, direction)))
    );
  });

  if (mode === "forward") {
    return {
      endEventRefs: terminal
        .filter(({ $type }) => $type === "bpmn:EndEvent")
        .map(({ id }) => id ?? null),
      deadEndRefs: terminal
        .filter(({ $type }) => $type !== "bpmn:EndEvent")
        .map(({ id }) => id ?? null)
    };
  }

  return {
    startEventRefs: terminal
      .filter(({ $type }) => $type === "bpmn:StartEvent")
      .map(({ id }) => id ?? null),
    sourceElementRefs: terminal
      .filter(({ $type }) => $type !== "bpmn:StartEvent")
      .map(({ id }) => id ?? null)
  };
}

function compactAnalysis(analysis: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(analysis).filter(([, value]) => {
      if (Array.isArray(value)) {
        return value.length > 0;
      }

      return value !== undefined;
    })
  ) as JsonObject;
}

export function createTraceEnvelope(
  model: SemanticModel,
  options: TraceSelectionOptions
): TraceEnvelope {
  const mode = traceMode(options);
  const graph = buildGraph(model);
  const from = endpoint(
    model,
    options.from,
    options.followMessageFlows,
    "--from"
  );
  const to = endpoint(
    model,
    options.to,
    options.followMessageFlows,
    "--to"
  );
  let candidates: TraversalResult;
  let mandatory: ModdleElement[];
  let connected: boolean | undefined;

  if (mode === "forward") {
    candidates = traverse(
      graph,
      from as ModdleElement,
      "forward",
      options.followMessageFlows
    );
    mandatory = [from as ModdleElement];
  } else if (mode === "backward") {
    candidates = traverse(
      graph,
      to as ModdleElement,
      "backward",
      options.followMessageFlows
    );
    mandatory = [to as ModdleElement];
  } else {
    const forward = traverse(
      graph,
      from as ModdleElement,
      "forward",
      options.followMessageFlows
    );
    const backward = traverse(
      graph,
      to as ModdleElement,
      "backward",
      options.followMessageFlows
    );
    const intersection = new Set(
      forward.order.filter((element) => backward.visited.has(element))
    );
    const route = shortestPath(
      graph,
      from as ModdleElement,
      to as ModdleElement,
      options.followMessageFlows,
      intersection
    );
    connected = route !== undefined;

    if (route === undefined) {
      return {
        schemaVersion: "1",
        view: "trace",
        source: model.source as unknown as JsonObject,
        semanticHash: model.semanticHash,
        profiles: profileProjection(model),
        trace: {
          mode,
          fromRef: options.from as string,
          toRef: options.to as string,
          scopes: [],
          participants: [],
          messageFlows: [],
          rootElements: []
        },
        analysis: {
          connected: false,
          truncated: false
        }
      };
    }

    candidates = {
      order: forward.order.filter((element) => intersection.has(element)),
      visited: intersection
    };
    mandatory = route;
  }

  const effectiveLimit = options.all ? Number.POSITIVE_INFINITY : options.limit;
  const selected = new Set<ModdleElement>();
  const ordered: ModdleElement[] = [];

  for (const element of mandatory) {
    if (!addWithContext(selected, ordered, element, effectiveLimit)) {
      throw new TraceGraphError(
        mode === "connecting"
          ? "TRACE_ROUTE_TOO_LARGE"
          : "TRACE_CONTEXT_TOO_LARGE",
        `Required trace context exceeds the ${options.limit}-element limit`
      );
    }
  }

  for (const element of candidates.order) {
    if (!addWithContext(selected, ordered, element, effectiveLimit)) {
      break;
    }
  }

  const contextFrontier: ModdleElement[] = [];

  for (const messageFlow of relatedMessageFlows(model, selected)) {
    if (!addWithContext(selected, ordered, messageFlow, effectiveLimit)) {
      contextFrontier.push(messageFlow);
    }
  }

  const referenceSources = [...selected].filter(
    (element) => !isContainer(element)
  );

  for (const root of referencedRootElements(model, referenceSources)) {
    if (!addWithContext(selected, ordered, root, effectiveLimit)) {
      contextFrontier.push(root);
    }
  }

  for (const contextElement of relatedContextElements(model, selected)) {
    if (
      !addWithContext(
        selected,
        ordered,
        contextElement,
        effectiveLimit
      )
    ) {
      contextFrontier.push(contextElement);
    }
  }

  const frontier: ModdleElement[] = [];
  const traversalDirection = mode === "backward" ? "backward" : "forward";

  for (const element of ordered) {
    for (const edge of traversalEdges(
      graph,
      element,
      traversalDirection,
      options.followMessageFlows
    )) {
      const adjacent = adjacentElement(edge, traversalDirection);

      if (
        candidates.visited.has(adjacent) &&
        !selected.has(adjacent) &&
        !frontier.includes(adjacent)
      ) {
        frontier.push(adjacent);
      }
    }
  }

  for (const contextElement of contextFrontier) {
    if (!frontier.includes(contextElement)) {
      frontier.push(contextElement);
    }
  }

  const selectedMessageFlows = [...selected].filter(isMessageFlow);
  const selectedParticipants = [...selected].filter(
    ({ $type }) => $type === "bpmn:Participant"
  );
  const selectedRoots = model.definitions.rootElements.filter(
    (element) =>
      selected.has(element) &&
      !element.$instanceOf("bpmn:Process") &&
      !element.$instanceOf("bpmn:Collaboration")
  );
  const diagnostics = relevantDiagnostics(model.diagnostics, selected);
  const eventTransitions = transitionAnalysis(
    graph,
    selected,
    EVENT_EDGE_KINDS
  ).concat(scopeCompensationAnalysis(selected));
  const scopeTransitions = scopeTransitionAnalysis(graph, selected);
  const cycles = sequenceFlowCycles(selected);
  const loops = activityLoops(selected);
  const adHoc = adHocScopes(selected);
  const frontierSet = new Set(frontier);
  const analysis = compactAnalysis({
    ...(connected === undefined ? {} : { connected }),
    branches: branchAnalysis(selected),
    eventTransitions,
    scopeTransitions,
    sequenceFlowCycles: cycles,
    activityLoops: loops,
    adHocScopes: adHoc,
    ...terminalAnalysis(
      graph,
      selected,
      mode,
      options.followMessageFlows,
      frontierSet
    ),
    frontierRefs: frontier.map(({ id }) => id ?? null),
    truncated: frontier.length > 0,
    diagnostics
  });

  return {
    schemaVersion: "1",
    view: "trace",
    source: model.source as unknown as JsonObject,
    semanticHash: model.semanticHash,
    profiles: profileProjection(model),
    trace: {
      mode,
      ...(options.from === undefined ? {} : { fromRef: options.from }),
      ...(options.to === undefined ? {} : { toRef: options.to }),
      scopes: scopeRecords(selected, ordered),
      participants: selectedParticipants.map(compactProjection),
      messageFlows: selectedMessageFlows.map(compactProjection),
      rootElements: selectedRoots.map(compactProjection)
    },
    analysis
  };
}
