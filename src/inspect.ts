import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

import {
  loadSemanticModel,
  ModelLoadError
} from "./model-loader.js";
import { writeOutputFile } from "./output.js";
import type { JsonObject, JsonValue } from "./project.js";
import {
  createElementView,
  createFullProcessProjection,
  createModelView,
  createProcessView,
  createScopeView,
  type InspectionEnvelope,
  type SemanticModel
} from "./semantic.js";

export const inspectLimits = {
  defaultPageSize: 25,
  maxPageSize: 100,
  maxStdoutBytes: 32 * 1024
} as const;

export interface InspectResult {
  exitCode: number;
  output: string;
  stream: "stdout" | "stderr";
}

type InspectFormat = "json" | "jsonl" | "text";
type Selector =
  | { type: "element"; id: string }
  | { type: "model" }
  | { type: "process"; id: string }
  | { type: "scope"; id: string };

interface InspectOptions {
  all: boolean;
  autoProfile: boolean;
  cursor?: string;
  extensions: string[];
  file: string;
  force: boolean;
  format: InspectFormat;
  limit: number;
  metadata: boolean;
  output?: string;
  pretty: boolean;
  profile?: "zeebe";
  selector: Selector;
}

interface CursorPayload {
  boundary: string;
  offset: number;
  schemaVersion: 1;
  scope: string;
  sourceSha256: string;
}

function cursorBoundary(
  member: unknown,
  offset: number,
  scope: string,
  sourceSha256: string
): string {
  const identity =
    typeof member === "object" && member !== null
      ? {
          id: "id" in member ? member.id : null,
          type: "$type" in member ? member.$type : null
        }
      : null;

  return createHash("sha256")
    .update(JSON.stringify({ identity, offset, scope, sourceSha256 }))
    .digest("base64url");
}

export const inspectHelpText = `Usage:
  bpmn-cli inspect <file> [options]

Inspect BPMN business semantics without Diagram Interchange.

Views:
  --process <id>          Show a bounded process and container outline
  --scope <id>            Page through direct flowElements and artifacts
  --element <id>          Show one element and its immediate semantic context

Paging:
  --limit <n>             Scope page size (default: 25, maximum: 100)
  --cursor <cursor>       Continue a scope page

Profiles:
  --profile zeebe         Load the built-in Zeebe moddle profile
  --no-auto-profile       Disable namespace-based profile detection
  --extension <name>=<descriptor.json>
                          Load a data-only moddle descriptor; repeatable

Output:
  --json                  Emit compact, versioned JSON
  --jsonl                 Emit JSON Lines for scope pages or offline artifacts
  --pretty                Pretty-print JSON
  --metadata              Include source, semantic hash, and full profile metadata
  --all                   Include complete selected semantic content
  --output <path>         Write structured output to a new file
  --force                 Allow replacing the output file
  -h, --help              Display this help message

Unbounded --all output requires --output. Default stdout is limited to 32 KiB.
`;

function inferFormat(args: readonly string[]): InspectFormat {
  if (args.includes("--jsonl")) {
    return "jsonl";
  }

  if (args.includes("--json")) {
    return "json";
  }

  return "text";
}

function errorResult(
  exitCode: number,
  code: string,
  message: string,
  format: InspectFormat
): InspectResult {
  if (format === "json" || format === "jsonl") {
    return {
      exitCode,
      output: `${JSON.stringify({
        schemaVersion: "1",
        error: { code, exitCode, message }
      })}\n`,
      stream: "stderr"
    };
  }

  return {
    exitCode,
    output: `${message}\n`,
    stream: "stderr"
  };
}

function integerOption(
  value: string | undefined,
  name: string,
  defaultValue: number
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }

  return Number(value);
}

function parseInspectOptions(
  args: readonly string[]
): InspectOptions | InspectResult | "help" {
  const format = inferFormat(args);

  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        all: { type: "boolean" },
        cursor: { type: "string" },
        element: { type: "string" },
        extension: { type: "string", multiple: true },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        jsonl: { type: "boolean" },
        limit: { type: "string" },
        metadata: { type: "boolean" },
        "no-auto-profile": { type: "boolean" },
        output: { type: "string" },
        pretty: { type: "boolean" },
        process: { type: "string" },
        profile: { type: "string" },
        scope: { type: "string" }
      }
    });

    if (parsed.values.help) {
      return "help";
    }

    if (parsed.positionals.length !== 1) {
      throw new Error("inspect requires exactly one BPMN file");
    }

    if (parsed.values.json && parsed.values.jsonl) {
      throw new Error("--json and --jsonl are mutually exclusive");
    }

    if (
      parsed.values.profile !== undefined &&
      parsed.values.profile !== "zeebe"
    ) {
      throw new Error(`unknown profile: ${parsed.values.profile}`);
    }

    const selectors = [
      parsed.values.process === undefined
        ? undefined
        : { type: "process" as const, id: parsed.values.process },
      parsed.values.scope === undefined
        ? undefined
        : { type: "scope" as const, id: parsed.values.scope },
      parsed.values.element === undefined
        ? undefined
        : { type: "element" as const, id: parsed.values.element }
    ].filter((selector): selector is Exclude<Selector, { type: "model" }> =>
      selector !== undefined
    );

    if (selectors.length > 1) {
      throw new Error("--process, --scope, and --element are mutually exclusive");
    }

    const selector: Selector = selectors[0] ?? { type: "model" };
    const limit = integerOption(
      parsed.values.limit,
      "--limit",
      inspectLimits.defaultPageSize
    );

    if (limit > inspectLimits.maxPageSize) {
      throw new Error(
        `--limit must not exceed ${inspectLimits.maxPageSize}`
      );
    }

    if (
      (parsed.values.limit !== undefined ||
        parsed.values.cursor !== undefined) &&
      selector.type !== "scope"
    ) {
      throw new Error("--limit and --cursor require --scope");
    }

    if (parsed.values.pretty && format !== "json") {
      throw new Error("--pretty requires --json");
    }

    if (parsed.values.metadata && format === "text") {
      throw new Error("--metadata requires --json or --jsonl");
    }

    if (format === "jsonl" && selector.type !== "scope" && !parsed.values.all) {
      throw new Error("--jsonl requires --scope or --all");
    }

    if (parsed.values.all && parsed.values.output === undefined) {
      throw new Error("--all requires --output");
    }

    if (
      parsed.values.all &&
      selector.type !== "process" &&
      selector.type !== "element"
    ) {
      throw new Error("--all requires --process or --element");
    }

    if (
      parsed.values.output !== undefined &&
      format === "text"
    ) {
      throw new Error("--output requires --json or --jsonl");
    }

    if (parsed.values.force && parsed.values.output === undefined) {
      throw new Error("--force requires --output");
    }

    return {
      all: parsed.values.all ?? false,
      autoProfile: !(parsed.values["no-auto-profile"] ?? false),
      cursor: parsed.values.cursor,
      extensions: parsed.values.extension ?? [],
      file: parsed.positionals[0] as string,
      force: parsed.values.force ?? false,
      format,
      limit,
      metadata: parsed.values.metadata ?? false,
      output: parsed.values.output,
      pretty: parsed.values.pretty ?? false,
      profile: parsed.values.profile,
      selector
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      1,
      "INVALID_ARGUMENTS",
      `${message}. Run "bpmn-cli inspect --help" for usage.`,
      format
    );
  }
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string,
  scope: string,
  sourceSha256: string
): CursorPayload {
  let payload: unknown;

  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid scope cursor");
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as Partial<CursorPayload>).schemaVersion !== 1 ||
    (payload as Partial<CursorPayload>).scope !== scope ||
    typeof (payload as Partial<CursorPayload>).boundary !== "string" ||
    !Number.isSafeInteger((payload as Partial<CursorPayload>).offset) ||
    (payload as Partial<CursorPayload>).offset! < 0
  ) {
    throw new Error("Invalid scope cursor");
  }

  if ((payload as Partial<CursorPayload>).sourceSha256 !== sourceSha256) {
    throw new Error("Stale scope cursor: the BPMN source has changed");
  }

  return payload as CursorPayload;
}

function renderJson(
  envelope: JsonObject,
  pretty: boolean
): string {
  return `${JSON.stringify(envelope, null, pretty ? 2 : undefined)}\n`;
}

function renderScopeJsonl(envelope: JsonObject): string {
  const {
    flowElements,
    artifacts,
    page,
    scope,
    ...metadata
  } = envelope;
  const records: JsonObject[] = [
    {
      record: "scope",
      ...metadata,
      scope: scope ?? null
    }
  ];

  if (Array.isArray(flowElements)) {
    for (const element of flowElements) {
      records.push({ record: "flowElement", value: element });
    }
  }

  if (Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      records.push({ record: "artifact", value: artifact });
    }
  }

  records.push({ record: "page", page: page ?? null });
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function renderFullJsonl(envelope: JsonObject): string {
  const { process, element, relatedRootElements, context, ...metadata } =
    envelope;
  const records: JsonObject[] = [
    {
      record: "inspection",
      ...metadata,
      context: context ?? null
    }
  ];

  const escapePointer = (part: string): string =>
    part.replaceAll("~", "~0").replaceAll("/", "~1");

  const addElementRecords = (value: JsonValue, path: string): void => {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof value.$type !== "string"
    ) {
      return;
    }

    const children: Array<{ path: string; value: JsonValue }> = [];

    for (const [property, propertyValue] of Object.entries(value)) {
      if (
        typeof propertyValue === "object" &&
        propertyValue !== null &&
        !Array.isArray(propertyValue) &&
        typeof propertyValue.$type === "string"
      ) {
        children.push({
          path: `${path}/${escapePointer(property)}`,
          value: propertyValue
        });
      }

      if (
        Array.isArray(propertyValue) &&
        propertyValue.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry) &&
            typeof entry.$type === "string"
        )
      ) {
        propertyValue.forEach((entry, index) => {
          if (
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry) &&
            typeof entry.$type === "string"
          ) {
            children.push({
              path: `${path}/${escapePointer(property)}/${index}`,
              value: entry
            });
          }
        });
      }
    }

    records.push({ record: "element", path, value });

    for (const child of children) {
      addElementRecords(child.value, child.path);
    }
  };

  if (process !== undefined) {
    addElementRecords(process, "/process");
  }

  if (element !== undefined) {
    addElementRecords(element, "/element");
  }

  if (Array.isArray(relatedRootElements)) {
    relatedRootElements.forEach((root, index) => {
      addElementRecords(root, `/relatedRootElements/${index}`);
    });
  }

  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function textValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    return "(none)";
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}

function renderText(envelope: InspectionEnvelope): string {
  const header = `bpmn-cli inspect

View: ${envelope.view}
`;

  if (envelope.view === "model") {
    const analysis = envelope.analysis;
    const totals = analysis.totals as JsonObject | undefined;
    const processes = analysis.processes as JsonValue[] | undefined;

    return `${header}
Semantic elements: ${textValue(totals?.semanticElements)}
Processes: ${processes?.length ?? 0}
Profiles: ${envelope.profiles.length}
Diagnostics: ${(analysis.diagnostics as JsonValue[] | undefined)?.length ?? 0}
`;
  }

  if (envelope.view === "process") {
    const process = envelope.process as JsonObject;
    const containers = envelope.analysis.containers as JsonValue[] | undefined;

    return `${header}
Process: ${textValue(process.id)}  ${textValue(process.name)}
Containers: ${containers?.length ?? 0}
Conditions: ${textValue(envelope.analysis.conditionCount)}
Diagnostics: ${(envelope.analysis.diagnostics as JsonValue[] | undefined)?.length ?? 0}
`;
  }

  if (envelope.view === "scope") {
    const scope = envelope.scope as JsonObject;
    const flowElements = envelope.flowElements as JsonObject[];
    const page = envelope.page as JsonObject;
    const lines = flowElements.map(
      (element) =>
        `  ${textValue(element.$type)}  ${textValue(element.id)}  ${textValue(element.name)}`
    );

    return `${header}
Scope: ${textValue(scope.id)}  ${textValue(scope.name)}
Flow elements ${textValue(page.offset)}-${Number(page.offset) + Number(page.returned)} of ${textValue(page.total)}
${lines.join("\n")}
Next cursor: ${textValue(page.nextCursor)}
`;
  }

  return `${header}
${JSON.stringify(envelope.element, null, 2)}

Context:
${JSON.stringify(envelope.context, null, 2)}
`;
}

function minimalEnvelope(envelope: InspectionEnvelope): JsonObject {
  const result: JsonObject = { ...envelope };
  const analysis = { ...envelope.analysis };
  const diagnostics = analysis.diagnostics;

  delete result.source;
  delete result.semanticHash;
  delete result.profiles;
  delete result.analysis;

  if (Array.isArray(diagnostics) && diagnostics.length === 0) {
    delete analysis.diagnostics;
  }

  if (envelope.view === "model") {
    result.profiles = envelope.profiles;
  }

  if (Object.keys(analysis).length > 0) {
    result.analysis = analysis;
  }

  return result;
}

function serializedOutput(
  envelope: InspectionEnvelope,
  options: InspectOptions
): string {
  const structuredEnvelope =
    options.metadata || options.output !== undefined
      ? envelope
      : minimalEnvelope(envelope);

  if (options.format === "json") {
    return renderJson(structuredEnvelope, options.pretty);
  }

  if (options.format === "jsonl") {
    return envelope.view === "scope"
      ? renderScopeJsonl(structuredEnvelope)
      : renderFullJsonl(structuredEnvelope);
  }

  return renderText(envelope);
}

function scopeEnvelope(
  model: SemanticModel,
  options: InspectOptions
): InspectionEnvelope | undefined {
  if (options.selector.type !== "scope") {
    return undefined;
  }

  let offset = 0;

  if (options.cursor !== undefined) {
    const decoded = decodeCursor(
      options.cursor,
      options.selector.id,
      model.source.sha256
    );
    offset = decoded.offset;

    const scope = model.byId.get(options.selector.id);
    const members = [
      ...((scope?.get("flowElements") as unknown[] | undefined) ?? []),
      ...((scope?.get("artifacts") as unknown[] | undefined) ?? [])
    ];

    if (
      (members.length > 0 && offset >= members.length) ||
      decoded.boundary !==
        cursorBoundary(
          members[offset - 1],
          offset,
          options.selector.id,
          model.source.sha256
        )
    ) {
      throw new Error("Invalid scope cursor");
    }
  }

  let limit = options.limit;

  while (limit > 0) {
    const page = createScopeView(model, options.selector.id, { limit, offset });

    if (page === undefined) {
      return undefined;
    }

    const pageMetadata = page.envelope.page as JsonObject;
    const scope = model.byId.get(options.selector.id);
    const members = [
      ...((scope?.get("flowElements") as unknown[] | undefined) ?? []),
      ...((scope?.get("artifacts") as unknown[] | undefined) ?? [])
    ];
    pageMetadata.nextCursor =
      page.nextOffset === undefined
        ? null
        : encodeCursor({
            boundary: cursorBoundary(
              members[page.nextOffset - 1],
              page.nextOffset,
              options.selector.id,
              model.source.sha256
            ),
            offset: page.nextOffset,
            schemaVersion: 1,
            scope: options.selector.id,
            sourceSha256: model.source.sha256
          });

    if (
      options.output !== undefined ||
      Buffer.byteLength(serializedOutput(page.envelope, options)) <=
        inspectLimits.maxStdoutBytes
    ) {
      return page.envelope;
    }

    limit -= 1;
  }

  throw new Error("A single scope record exceeds the stdout output budget");
}

function selectView(
  model: SemanticModel,
  options: InspectOptions
): InspectionEnvelope | undefined {
  if (options.selector.type === "model") {
    return createModelView(model);
  }

  if (options.selector.type === "process") {
    return options.all
      ? createFullProcessProjection(model, options.selector.id)
      : createProcessView(model, options.selector.id);
  }

  if (options.selector.type === "scope") {
    return scopeEnvelope(model, options);
  }

  return createElementView(model, options.selector.id, options.all);
}

export async function executeInspect(
  args: readonly string[]
): Promise<InspectResult> {
  const parsed = parseInspectOptions(args);

  if (parsed === "help") {
    return { exitCode: 0, output: inspectHelpText, stream: "stdout" };
  }

  if ("exitCode" in parsed) {
    return parsed;
  }

  const options = parsed;
  let model: SemanticModel;

  try {
    model = await loadSemanticModel({
      autoProfile: options.autoProfile,
      extensions: options.extensions,
      file: options.file,
      profile: options.profile
    });
  } catch (error) {
    if (error instanceof ModelLoadError) {
      return errorResult(
        error.exitCode,
        error.code,
        error.message,
        options.format
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      3,
      "BPMN_PARSE_FAILED",
      `Unable to parse BPMN file "${options.file}": ${message}`,
      options.format
    );
  }

  let envelope: InspectionEnvelope | undefined;

  try {
    envelope = selectView(model, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Stale")) {
      return errorResult(1, "STALE_CURSOR", message, options.format);
    }

    if (message === "Invalid scope cursor") {
      return errorResult(1, "INVALID_CURSOR", message, options.format);
    }

    if (message.includes("output budget")) {
      return errorResult(1, "OUTPUT_TOO_LARGE", message, options.format);
    }

    return errorResult(
      3,
      "INSPECTION_FAILED",
      `Unable to construct inspection result: ${message}`,
      options.format
    );
  }

  if (envelope === undefined) {
    const selector =
      options.selector.type === "model"
        ? "model"
        : `${options.selector.type} "${options.selector.id}"`;
    return errorResult(
      1,
      "SELECTOR_NOT_FOUND",
      `Unable to find ${selector}`,
      options.format
    );
  }

  const output = serializedOutput(envelope, options);

  if (
    options.output === undefined &&
    Buffer.byteLength(output) > inspectLimits.maxStdoutBytes
  ) {
    return errorResult(
      1,
      "OUTPUT_TOO_LARGE",
      `Inspection output exceeds ${inspectLimits.maxStdoutBytes} bytes; select a narrower view or use --output`,
      options.format
    );
  }

  if (options.output !== undefined) {
    try {
      await writeOutputFile(options.output, output, options.force, options.file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(
        2,
        "OUTPUT_WRITE_FAILED",
        `Unable to write inspection output: ${message}`,
        options.format
      );
    }

    return { exitCode: 0, output: "", stream: "stdout" };
  }

  return { exitCode: 0, output, stream: "stdout" };
}
