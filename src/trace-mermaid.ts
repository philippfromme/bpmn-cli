import type { JsonObject, JsonValue } from "./project.js";
import type { TraceEnvelope } from "./trace-graph.js";

interface ScopeRecord {
  artifacts: JsonObject[];
  flowElements: JsonObject[];
  laneSets: JsonObject[];
  scope: JsonObject;
}

interface RenderedEdge {
  elementRef?: string;
  statement: string;
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function objectArray(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value)
    ? value
        .map((entry) => objectValue(entry))
        .filter((entry): entry is JsonObject => entry !== undefined)
    : [];
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replaceAll("\n", "<br/>");
}

function typeName(element: JsonObject): string {
  return (stringValue(element.$type) ?? "bpmn:Element").replace(/^bpmn:/, "");
}

function elementLabel(
  element: JsonObject,
  lanes: ReadonlyMap<string, readonly string[]>
): string {
  const id = stringValue(element.id) ?? "(unidentified)";
  const name =
    stringValue(element.name) ??
    stringValue(element.text) ??
    typeName(element);
  const laneNames = lanes.get(id) ?? [];
  const details = [
    typeName(element),
    id,
    ...(laneNames.length === 0 ? [] : [`lane: ${laneNames.join(", ")}`])
  ].join(" · ");

  return `${escapeLabel(name)}<br/><small>${escapeLabel(details)}</small>`;
}

function nodeStatement(alias: string, label: string, type: string): string {
  if (type.endsWith("Gateway")) {
    return `${alias}{"${label}"}`;
  }

  if (type.endsWith("Event")) {
    return `${alias}(("${label}"))`;
  }

  if (
    type === "DataObject" ||
    type === "DataObjectReference" ||
    type === "DataStoreReference"
  ) {
    return `${alias}[("${label}")]`;
  }

  if (
    type.endsWith("Task") ||
    type === "Activity" ||
    type === "CallActivity" ||
    type === "SubProcess" ||
    type === "Transaction"
  ) {
    return `${alias}(["${label}"])`;
  }

  if (type === "TextAnnotation") {
    return `${alias}["${label}"]`;
  }

  return `${alias}["${label}"]`;
}

function conditionBody(flow: JsonObject): string | undefined {
  const expression = objectValue(flow.conditionExpression);
  return expression === undefined ? undefined : stringValue(expression.body);
}

function edgeLabel(element: JsonObject): string {
  const values = [
    stringValue(element.id),
    stringValue(element.name),
    conditionBody(element)
  ].filter((value): value is string => value !== undefined && value !== "");

  return escapeLabel(values.join(" · "));
}

function parseScopes(trace: JsonObject): ScopeRecord[] {
  return objectArray(trace.scopes)
    .map((record) => ({
      artifacts: objectArray(record.artifacts),
      flowElements: objectArray(record.flowElements),
      laneSets: objectArray(record.laneSets),
      scope: objectValue(record.scope) ?? {}
    }))
    .filter(({ scope }) => stringValue(scope.id) !== undefined);
}

function laneMembership(scopes: readonly ScopeRecord[]): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const { laneSets } of scopes) {
    for (const laneSet of laneSets) {
      for (const lane of objectArray(laneSet.lanes)) {
        const laneName =
          stringValue(lane.name) ?? stringValue(lane.id) ?? "unnamed";

        for (const flowNodeRef of stringArray(lane.flowNodeRef)) {
          result.set(flowNodeRef, [
            ...(result.get(flowNodeRef) ?? []),
            laneName
          ]);
        }
      }
    }
  }

  return result;
}

function collectElements(
  scopes: readonly ScopeRecord[],
  trace: JsonObject
): JsonObject[] {
  const result: JsonObject[] = [];
  const ids = new Set<string>();
  const add = (element: JsonObject): void => {
    const id = stringValue(element.id);

    if (
      id !== undefined &&
      !ids.has(id) &&
      stringValue(element.$type) !== "bpmn:SequenceFlow" &&
      stringValue(element.$type) !== "bpmn:Association"
    ) {
      ids.add(id);
      result.push(element);
    }
  };

  for (const record of scopes) {
    add(record.scope);
    record.flowElements.forEach(add);
    record.artifacts.forEach(add);
  }

  objectArray(trace.participants).forEach(add);
  objectArray(trace.rootElements).forEach(add);

  return result;
}

function className(element: JsonObject): string {
  const type = typeName(element);

  if (type.endsWith("Event")) {
    return "event";
  }

  if (type.endsWith("Gateway")) {
    return "gateway";
  }

  if (type === "Participant") {
    return "participant";
  }

  if (type === "TextAnnotation") {
    return "artifact";
  }

  if (
    type === "Error" ||
    type === "Escalation" ||
    type === "Message" ||
    type === "Signal"
  ) {
    return "definition";
  }

  if (
    type === "DataObject" ||
    type === "DataObjectReference" ||
    type === "DataStoreReference"
  ) {
    return "data";
  }

  return "activity";
}

function transitionEdges(
  records: readonly JsonObject[],
  aliases: ReadonlyMap<string, string>
): RenderedEdge[] {
  return records.flatMap((record) => {
    const sourceRef = stringValue(record.sourceRef);
    const targetRef = stringValue(record.targetRef);
    const kind = stringValue(record.kind);
    const source = sourceRef === undefined ? undefined : aliases.get(sourceRef);
    const target = targetRef === undefined ? undefined : aliases.get(targetRef);

    if (
      source === undefined ||
      target === undefined ||
      kind === undefined
    ) {
      return [];
    }

    return [
      {
        statement: `${source} -. "${escapeLabel(kind)}" .-> ${target}`
      }
    ];
  });
}

function renderEdge(edge: RenderedEdge): string {
  return `  ${edge.statement}`;
}

export function renderTraceMermaid(envelope: TraceEnvelope): string {
  const trace = envelope.trace;
  const analysis = envelope.analysis;
  const scopes = parseScopes(trace);
  const lanes = laneMembership(scopes);
  const elements = collectElements(scopes, trace);
  const aliases = new Map(
    elements.map((element, index) => [
      stringValue(element.id) as string,
      `n${index}`
    ])
  );
  const elementsById = new Map(
    elements.map((element) => [stringValue(element.id) as string, element])
  );
  const scopeById = new Map(
    scopes.map((record) => [stringValue(record.scope.id) as string, record])
  );
  const childScopeIds = new Set<string>();

  for (const parent of scopes) {
    const parentId = stringValue(parent.scope.id) as string;

    for (const element of parent.flowElements) {
      const id = stringValue(element.id);

      if (id !== undefined && scopeById.has(id) && id !== parentId) {
        childScopeIds.add(id);
      }
    }
  }

  const lines = ["flowchart LR"];
  const renderedNodes = new Set<string>();
  const renderNode = (element: JsonObject, indent: string): void => {
    const id = stringValue(element.id);

    if (id === undefined || renderedNodes.has(id)) {
      return;
    }

    const alias = aliases.get(id);

    if (alias === undefined) {
      return;
    }

    renderedNodes.add(id);
    lines.push(
      `${indent}${nodeStatement(alias, elementLabel(element, lanes), typeName(element))}`
    );
  };
  const renderScope = (scopeId: string, indent: string): void => {
    const record = scopeById.get(scopeId);

    if (record === undefined) {
      return;
    }

    const scopeAlias = aliases.get(scopeId) as string;
    const title = elementLabel(record.scope, lanes);
    lines.push(`${indent}subgraph sg_${scopeAlias}["${title}"]`);
    lines.push(`${indent}  direction LR`);
    renderNode(record.scope, `${indent}  `);

    for (const element of record.flowElements) {
      const id = stringValue(element.id);

      if (id !== undefined && scopeById.has(id) && id !== scopeId) {
        renderScope(id, `${indent}  `);
      } else {
        renderNode(element, `${indent}  `);
      }
    }

    record.artifacts.forEach((artifact) =>
      renderNode(artifact, `${indent}  `)
    );
    lines.push(`${indent}end`);
  };

  for (const record of scopes) {
    const scopeId = stringValue(record.scope.id) as string;

    if (!childScopeIds.has(scopeId)) {
      renderScope(scopeId, "  ");
    }
  }

  const participants = objectArray(trace.participants);
  if (participants.length > 0) {
    lines.push('  subgraph sg_participants["Participants"]');
    lines.push("    direction TB");
    participants.forEach((participant) => renderNode(participant, "    "));
    lines.push("  end");
  }

  const roots = objectArray(trace.rootElements);
  if (roots.length > 0) {
    lines.push('  subgraph sg_definitions["Referenced definitions"]');
    lines.push("    direction TB");
    roots.forEach((root) => renderNode(root, "    "));
    lines.push("  end");
  }

  const frontierRefs = new Set(stringArray(analysis.frontierRefs));
  const omittedFrontiers = [...frontierRefs].filter((id) => !aliases.has(id));
  const frontierAliases = new Map(
    omittedFrontiers.map((id, index) => [id, `frontier${index}`])
  );
  if (omittedFrontiers.length > 0) {
    lines.push('  subgraph sg_frontier["Truncated frontier"]');
    lines.push("    direction TB");
    for (const id of omittedFrontiers) {
      lines.push(
        `    ${frontierAliases.get(id)}["Frontier<br/><small>${escapeLabel(id)}</small>"]`
      );
    }
    lines.push("  end");
  }

  if (renderedNodes.size === 0) {
    lines.push('  empty["No modeled route connects the selected elements"]');
  }

  const edges: RenderedEdge[] = [];
  for (const { flowElements, artifacts } of scopes) {
    for (const flow of flowElements.filter(
      (element) => stringValue(element.$type) === "bpmn:SequenceFlow"
    )) {
      const sourceRef = stringValue(flow.sourceRef);
      const targetRef = stringValue(flow.targetRef);
      const source = sourceRef === undefined ? undefined : aliases.get(sourceRef);
      const target = targetRef === undefined ? undefined : aliases.get(targetRef);

      if (source !== undefined && target !== undefined) {
        const label = edgeLabel(flow);
        edges.push({
          elementRef: stringValue(flow.id),
          statement:
            label === ""
              ? `${source} --> ${target}`
              : `${source} -->|"${label}"| ${target}`
        });
      }
    }

    for (const association of artifacts.filter(
      (element) => stringValue(element.$type) === "bpmn:Association"
    )) {
      const sourceRef = stringValue(association.sourceRef);
      const targetRef = stringValue(association.targetRef);
      const source = sourceRef === undefined ? undefined : aliases.get(sourceRef);
      const target = targetRef === undefined ? undefined : aliases.get(targetRef);

      if (source !== undefined && target !== undefined) {
        edges.push({
          elementRef: stringValue(association.id),
          statement: `${source} -. "${edgeLabel(association)}" .-> ${target}`
        });
      }
    }
  }

  for (const messageFlow of objectArray(trace.messageFlows)) {
    const sourceRef = stringValue(messageFlow.sourceRef);
    const targetRef = stringValue(messageFlow.targetRef);
    const source = sourceRef === undefined ? undefined : aliases.get(sourceRef);
    const target = targetRef === undefined ? undefined : aliases.get(targetRef);

    if (source !== undefined && target !== undefined) {
      edges.push({
        elementRef: stringValue(messageFlow.id),
        statement: `${source} -. "${edgeLabel(messageFlow)}" .-> ${target}`
      });
    }
  }

  edges.push(
    ...transitionEdges(objectArray(analysis.eventTransitions), aliases),
    ...transitionEdges(objectArray(analysis.scopeTransitions), aliases)
  );
  lines.push(...edges.map(renderEdge));

  const endpointRefs = new Set(
    [stringValue(trace.fromRef), stringValue(trace.toRef)].filter(
      (value): value is string => value !== undefined
    )
  );

  for (const [id, alias] of aliases) {
    const classes = [className(elementsById.get(id) as JsonObject)];

    if (endpointRefs.has(id)) {
      classes.push("endpoint");
    }

    if (frontierRefs.has(id)) {
      classes.push("frontier");
    }

    for (const name of classes) {
      lines.push(`  class ${alias} ${name};`);
    }
  }
  for (const alias of frontierAliases.values()) {
    lines.push(`  class ${alias} frontier;`);
  }

  edges.forEach((edge, index) => {
    if (edge.elementRef !== undefined && endpointRefs.has(edge.elementRef)) {
      lines.push(`  linkStyle ${index} stroke:#d97706,stroke-width:4px;`);
    } else if (
      edge.elementRef !== undefined &&
      frontierRefs.has(edge.elementRef)
    ) {
      lines.push(
        `  linkStyle ${index} stroke:#dc2626,stroke-width:3px,stroke-dasharray:5 5;`
      );
    }
  });

  lines.push(
    "  classDef activity fill:#eff6ff,stroke:#2563eb,color:#172554;",
    "  classDef artifact fill:#fffbeb,stroke:#a16207,color:#422006,stroke-dasharray:4 3;",
    "  classDef data fill:#ecfdf5,stroke:#059669,color:#022c22;",
    "  classDef definition fill:#f1f5f9,stroke:#64748b,color:#0f172a,stroke-dasharray:2 2;",
    "  classDef event fill:#f8fafc,stroke:#475569,color:#0f172a;",
    "  classDef gateway fill:#fefce8,stroke:#ca8a04,color:#422006;",
    "  classDef participant fill:#f5f3ff,stroke:#7c3aed,color:#2e1065;",
    "  classDef endpoint stroke:#d97706,stroke-width:4px;",
    "  classDef frontier stroke:#dc2626,stroke-width:3px,stroke-dasharray:5 5;"
  );

  if (analysis.truncated === true) {
    lines.push(
      `  %% Trace truncated. Continue from: ${stringArray(analysis.frontierRefs)
        .map(escapeLabel)
        .join(", ")}`
    );
  }

  return `${lines.join("\n")}\n`;
}
