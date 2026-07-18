import { parseArgs } from "node:util";

import { diff, type ChangedElement } from "bpmn-js-differ";
import type { ModdleElement } from "bpmn-moddle";

import { engines } from "./engines.js";
import {
  loadSemanticModelFromDocument,
  ModelLoadError,
  readSourceDocument
} from "./model-loader.js";
import { writeOutputFile } from "./output.js";
import {
  isHardExcludedElement,
  projectElement,
  type JsonObject,
  type JsonValue
} from "./project.js";
import type { SemanticModel } from "./semantic.js";

export const diffLimits = {
  maxStdoutBytes: 32 * 1024
} as const;

export interface DiffCommandResult {
  exitCode: number;
  output: string;
  stream: "stderr" | "stdout";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface DiffOptions {
  autoProfile: boolean;
  before: string;
  extensions: string[];
  force: boolean;
  includeLayout: boolean;
  json: boolean;
  after: string;
  profile?: "zeebe";
  report?: string;
}

export const diffHelpText = `Usage:
  bpmn-cli diff <before.bpmn> <after.bpmn> [options]

Compare two BPMN models with bpmn-js-differ.

Selection:
  --include-layout        Include DI changes separately

Profiles:
  --profile zeebe         Load the built-in Zeebe moddle profile
  --no-auto-profile       Disable namespace-based profile detection
  --extension <name>=<descriptor.json>
                          Load a data-only moddle descriptor; repeatable

Output:
  --json                  Emit versioned JSON
  --report <path>         Write complete JSON to a new file
  --force                 Allow replacing the report file
  -h, --help              Display this help message

Different models are successful results with changed=true.
`;

function errorResult(
  exitCode: number,
  code: string,
  message: string,
  json: boolean
): DiffCommandResult {
  return json
    ? {
        exitCode,
        output: `${JSON.stringify({
          schemaVersion: "1",
          error: { code, exitCode, message }
        })}\n`,
        stream: "stderr"
      }
    : {
        exitCode,
        output: `${message}\n`,
        stream: "stderr"
      };
}

function parseDiffOptions(
  args: readonly string[]
): DiffOptions | DiffCommandResult | "help" {
  const json = args.includes("--json");

  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        extension: { type: "string", multiple: true },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        "include-layout": { type: "boolean" },
        json: { type: "boolean" },
        "no-auto-profile": { type: "boolean" },
        profile: { type: "string" },
        report: { type: "string" }
      }
    });

    if (parsed.values.help) {
      if (parsed.positionals.length > 0 || args.length > 1) {
        throw new Error("--help cannot be combined with other arguments");
      }
      return "help";
    }

    if (parsed.positionals.length !== 2) {
      throw new Error("diff requires before and after BPMN files");
    }

    if (
      parsed.values.profile !== undefined &&
      parsed.values.profile !== "zeebe"
    ) {
      throw new Error(`unknown profile: ${parsed.values.profile}`);
    }

    if (parsed.values.report !== undefined && !parsed.values.json) {
      throw new Error("--report requires --json");
    }

    if (parsed.values.force && parsed.values.report === undefined) {
      throw new Error("--force requires --report");
    }

    return {
      after: parsed.positionals[1] as string,
      autoProfile: !(parsed.values["no-auto-profile"] ?? false),
      before: parsed.positionals[0] as string,
      extensions: parsed.values.extension ?? [],
      force: parsed.values.force ?? false,
      includeLayout: parsed.values["include-layout"] ?? false,
      json,
      profile: parsed.values.profile,
      report: parsed.values.report
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      1,
      "INVALID_ARGUMENTS",
      `${message}. Run "bpmn-cli diff --help" for usage.`,
      json
    );
  }
}

function pathSegments(path: string): Array<number | string> {
  const result: Array<number | string> = [];

  for (const match of path.matchAll(/([^[.\]]+)|\[(\d+)\]/g)) {
    result.push(match[2] === undefined ? (match[1] as string) : Number(match[2]));
  }

  return result;
}

function valueAtPath(
  element: ModdleElement | undefined,
  path: readonly (number | string)[]
): unknown {
  let value: unknown = element;

  for (const segment of path) {
    if (typeof segment === "number") {
      value = Array.isArray(value) ? value[segment] : undefined;
    } else if (
      typeof value === "object" &&
      value !== null &&
      "$type" in value
    ) {
      value =
        segment === "$type"
          ? (value as ModdleElement).$type
          : (value as ModdleElement).get(segment);
    } else if (typeof value === "object" && value !== null) {
      value = (value as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }

  return value;
}

function normalizedValue(
  value: unknown,
  visiting = new Set<object>()
): JsonValue | undefined {
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
      .map((entry) => normalizedValue(entry, visiting))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }

  if (typeof value !== "object") {
    return undefined;
  }

  if ("$type" in value) {
    const element = value as ModdleElement;

    if (element.id !== undefined) {
      return element.id;
    }

    return projectElement(element).value;
  }

  if (visiting.has(value)) {
    return undefined;
  }

  visiting.add(value);
  const result: JsonObject = {};

  for (const [key, entry] of Object.entries(value).sort(([left], [right]) =>
    compareStrings(left, right)
  )) {
    if (key.startsWith("$") || typeof entry === "function") {
      continue;
    }

    const normalized = normalizedValue(entry, visiting);

    if (normalized !== undefined) {
      result[key] = normalized;
    }
  }

  visiting.delete(value);
  return result;
}

function excludedPath(path: string): boolean {
  return (
    path === "di" ||
    path.startsWith("di.") ||
    path.startsWith("diagrams") ||
    path.includes("modelerTemplateIcon") ||
    path.includes("background-color") ||
    path.includes("border-color") ||
    path.includes("bioc:")
  );
}

function normalizedChanges(
  id: string,
  raw: ChangedElement,
  before: SemanticModel,
  after: SemanticModel
): JsonObject | undefined {
  const beforeElement = before.byId.get(id);
  const afterElement = after.byId.get(id);
  const changes = Object.entries(raw.attrs)
    .filter(([path]) => !excludedPath(path))
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([path, change]) => {
      const segments = change.path ?? pathSegments(path);
      const beforeValue = normalizedValue(
        valueAtPath(beforeElement, segments)
      );
      const afterValue = normalizedValue(valueAtPath(afterElement, segments));

      return {
        path,
        before: beforeValue ?? null,
        after: afterValue ?? null
      };
    })
    .filter(
      ({ before: oldValue, after: newValue }) =>
        JSON.stringify(oldValue) !== JSON.stringify(newValue)
    );

  if (changes.length === 0) {
    return undefined;
  }

  return {
    elementRef: id,
    $type:
      afterElement?.$type ?? beforeElement?.$type ?? raw.model.$type,
    changes
  };
}

function projectedElements(
  elements: Record<string, ModdleElement>,
  model: SemanticModel
): JsonObject[] {
  const order = new Map(
    model.allElements.flatMap((element, index) =>
      element.id === undefined ? [] : [[element.id, index] as const]
    )
  );

  return Object.entries(elements)
    .filter(([, element]) => !isHardExcludedElement(element))
    .sort(
      ([left], [right]) =>
        (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right) ?? Number.MAX_SAFE_INTEGER) ||
        compareStrings(left, right)
    )
    .map(([, element]) => ({ element: projectElement(element).value }));
}

function modelOrder(model: SemanticModel): ReadonlyMap<string, number> {
  return new Map(
    model.allElements.flatMap((element, index) =>
      element.id === undefined ? [] : [[element.id, index] as const]
    )
  );
}

function profileRecords(model: SemanticModel): JsonValue[] {
  return model.profiles.map(
    (profile) =>
      Object.fromEntries(
        Object.entries(profile).filter(
          ([key, value]) => key !== "descriptorSha256" && value !== undefined
        )
      ) as JsonObject
  );
}

export function semanticChanges(
  before: SemanticModel,
  after: SemanticModel
): JsonObject {
  const raw = diff(before.definitions, after.definitions);
  const added = projectedElements(raw._added, after);
  const removed = projectedElements(raw._removed, before);
  const beforeOrder = modelOrder(before);
  const afterOrder = modelOrder(after);
  const changed =
    before.semanticHash === after.semanticHash
      ? []
      : Object.entries(raw._changed)
          .sort(
            ([left], [right]) =>
              (beforeOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
                (beforeOrder.get(right) ?? Number.MAX_SAFE_INTEGER) ||
              (afterOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
                (afterOrder.get(right) ?? Number.MAX_SAFE_INTEGER) ||
              compareStrings(left, right)
          )
          .map(([id, change]) =>
            normalizedChanges(id, change, before, after)
          )
          .filter((record): record is JsonObject => record !== undefined);

  return { added, removed, changed };
}

function renderText(envelope: JsonObject): string {
  const changes = envelope.changes as JsonObject;
  const added = changes.added as JsonValue[];
  const removed = changes.removed as JsonValue[];
  const changed = changes.changed as JsonValue[];
  const layout = (envelope.layoutChanged as JsonValue[] | undefined) ?? [];

  return `bpmn-cli diff

Changed: ${String(envelope.changed)}
Added: ${added.length}
Removed: ${removed.length}
Changed elements: ${changed.length}
Layout changed: ${layout.length}
`;
}

async function loadModels(options: DiffOptions): Promise<{
  after: SemanticModel;
  before: SemanticModel;
}> {
  const [beforeDocument, afterDocument] = await Promise.all([
    readSourceDocument(options.before),
    readSourceDocument(options.after)
  ]);
  const profileDetectionXml = `${beforeDocument.xml}\n${afterDocument.xml}`;
  const common = {
    autoProfile: options.autoProfile,
    extensions: options.extensions,
    profile: options.profile,
    profileDetectionXml
  };
  const [before, after] = await Promise.all([
    loadSemanticModelFromDocument(beforeDocument, common),
    loadSemanticModelFromDocument(afterDocument, common)
  ]);

  return { after, before };
}

export async function executeDiff(
  args: readonly string[]
): Promise<DiffCommandResult> {
  const parsed = parseDiffOptions(args);

  if (parsed === "help") {
    return { exitCode: 0, output: diffHelpText, stream: "stdout" };
  }

  if ("exitCode" in parsed) {
    return parsed;
  }

  const options = parsed;

  try {
    const { before, after } = await loadModels(options);
    const raw = diff(before.definitions, after.definitions);
    const changes = semanticChanges(before, after);
    const added = changes.added as JsonValue[];
    const removed = changes.removed as JsonValue[];
    const changed = changes.changed as JsonValue[];
    const layoutChanged = options.includeLayout
      ? Object.keys(raw._layoutChanged).sort()
      : [];
    const semanticChanged =
      before.semanticHash !== after.semanticHash ||
      added.length > 0 ||
      removed.length > 0 ||
      changed.length > 0;
    const envelope: JsonObject = {
      schemaVersion: "1",
      view: "diff",
      changed: semanticChanged || layoutChanged.length > 0,
      before: {
        source: before.source as unknown as JsonObject,
        semanticHash: before.semanticHash,
        profiles: profileRecords(before)
      },
      after: {
        source: after.source as unknown as JsonObject,
        semanticHash: after.semanticHash,
        profiles: profileRecords(after)
      },
      engine: engines.differ,
      changes,
      ...(options.includeLayout ? { layoutChanged } : {})
    };
    const output = options.json
      ? `${JSON.stringify(envelope)}\n`
      : renderText(envelope);

    if (options.report !== undefined) {
      try {
        await writeOutputFile(
          options.report,
          `${JSON.stringify(envelope, null, 2)}\n`,
          options.force,
          [options.before, options.after]
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(
          2,
          "OUTPUT_WRITE_FAILED",
          `Unable to write diff report: ${message}`,
          options.json
        );
      }
      return { exitCode: 0, output: "", stream: "stdout" };
    }

    if (Buffer.byteLength(output) > diffLimits.maxStdoutBytes) {
      return errorResult(
        1,
        "OUTPUT_TOO_LARGE",
        `Diff output exceeds ${diffLimits.maxStdoutBytes} bytes; use --json --report`,
        options.json
      );
    }

    return { exitCode: 0, output, stream: "stdout" };
  } catch (error) {
    if (error instanceof ModelLoadError) {
      return errorResult(
        error.exitCode,
        error.code,
        error.message,
        options.json
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      1,
      "DIFF_FAILED",
      `Unable to diff BPMN: ${message}`,
      options.json
    );
  }
}
