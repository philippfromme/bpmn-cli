import { parseArgs } from "node:util";

import {
  loadSemanticModel,
  ModelLoadError
} from "./model-loader.js";
import { writeOutputFile } from "./output.js";
import type { JsonObject, JsonValue } from "./project.js";
import { renderTraceMermaid } from "./trace-mermaid.js";
import {
  createTraceEnvelope,
  TraceGraphError,
  type TraceEnvelope
} from "./trace-graph.js";

export const traceLimits = {
  defaultElementBudget: 50,
  maxElementBudget: 100,
  maxStdoutBytes: 32 * 1024
} as const;

export interface TraceResult {
  exitCode: number;
  output: string;
  stream: "stderr" | "stdout";
}

type TraceFormat = "json" | "mermaid" | "text";

interface TraceOptions {
  all: boolean;
  autoProfile: boolean;
  extensions: string[];
  file: string;
  followMessageFlows: boolean;
  force: boolean;
  format: TraceFormat;
  from?: string;
  limit: number;
  metadata: boolean;
  output?: string;
  pretty: boolean;
  profile?: "zeebe";
  to?: string;
}

export const traceHelpText = `Usage:
  bpmn-cli trace <file> (--from <id> | --to <id>) [options]

Trace bounded BPMN business behavior without simulating execution.

Selection:
  --from <id>             Trace forward from a FlowNode or SequenceFlow
  --to <id>               Trace backward to a FlowNode or SequenceFlow
                           Use both selectors for all connecting routes
  --follow-message-flows  Cross explicit MessageFlows between participants

Bounds:
  --limit <n>             Element budget (default: 50, maximum: 100)

Profiles:
  --profile zeebe         Load the built-in Zeebe moddle profile
  --no-auto-profile       Disable namespace-based profile detection
  --extension <name>=<descriptor.json>
                           Load a data-only moddle descriptor; repeatable

Output:
  --json                  Emit compact, versioned JSON
  --mermaid               Emit a human-review Mermaid flowchart
  --pretty                Pretty-print JSON
  --metadata              Include source, semantic hash, and profile metadata
  --all                   Include the complete graph; requires --json --output
  --output <path>         Write JSON or Mermaid to a new file
  --force                 Allow replacing the output file
  -h, --help              Display this help message

Default stdout is limited to 50 elements and 32 KiB. Trace does not evaluate
conditions; exact expressions and modeled alternatives are preserved.
`;

function inferFormat(args: readonly string[]): TraceFormat {
  if (args.includes("--json")) {
    return "json";
  }

  return args.includes("--mermaid") ? "mermaid" : "text";
}

function errorResult(
  exitCode: number,
  code: string,
  message: string,
  format: TraceFormat
): TraceResult {
  return format === "json"
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

function parseLimit(value: string | undefined): number {
  if (value === undefined) {
    return traceLimits.defaultElementBudget;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("--limit must be a positive integer");
  }

  const limit = Number(value);

  if (limit > traceLimits.maxElementBudget) {
    throw new Error(
      `--limit must not exceed ${traceLimits.maxElementBudget}`
    );
  }

  return limit;
}

function parseTraceOptions(
  args: readonly string[]
): TraceOptions | TraceResult | "help" {
  const format = inferFormat(args);

  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        all: { type: "boolean" },
        extension: { type: "string", multiple: true },
        "follow-message-flows": { type: "boolean" },
        force: { type: "boolean" },
        from: { type: "string" },
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        limit: { type: "string" },
        mermaid: { type: "boolean" },
        metadata: { type: "boolean" },
        "no-auto-profile": { type: "boolean" },
        output: { type: "string" },
        pretty: { type: "boolean" },
        profile: { type: "string" },
        to: { type: "string" }
      }
    });

    if (parsed.values.help) {
      if (parsed.positionals.length > 0 || args.length > 1) {
        throw new Error("--help cannot be combined with other arguments");
      }

      return "help";
    }

    if (parsed.positionals.length !== 1) {
      throw new Error("trace requires exactly one BPMN file");
    }

    if (
      parsed.values.from === undefined &&
      parsed.values.to === undefined
    ) {
      throw new Error("trace requires --from, --to, or both");
    }

    if (
      parsed.values.profile !== undefined &&
      parsed.values.profile !== "zeebe"
    ) {
      throw new Error(`unknown profile: ${parsed.values.profile}`);
    }

    if (parsed.values.json && parsed.values.mermaid) {
      throw new Error("--json and --mermaid are mutually exclusive");
    }

    if (parsed.values.all && parsed.values.limit !== undefined) {
      throw new Error("--all and --limit are mutually exclusive");
    }

    if (
      parsed.values.all &&
      (!parsed.values.json || parsed.values.output === undefined)
    ) {
      throw new Error("--all requires --json and --output");
    }

    if (
      parsed.values.output !== undefined &&
      !parsed.values.json &&
      !parsed.values.mermaid
    ) {
      throw new Error("--output requires --json or --mermaid");
    }

    if (parsed.values.pretty && !parsed.values.json) {
      throw new Error("--pretty requires --json");
    }

    if (parsed.values.metadata && !parsed.values.json) {
      throw new Error("--metadata requires --json");
    }

    if (parsed.values.force && parsed.values.output === undefined) {
      throw new Error("--force requires --output");
    }

    return {
      all: parsed.values.all ?? false,
      autoProfile: !(parsed.values["no-auto-profile"] ?? false),
      extensions: parsed.values.extension ?? [],
      file: parsed.positionals[0] as string,
      followMessageFlows:
        parsed.values["follow-message-flows"] ?? false,
      force: parsed.values.force ?? false,
      format,
      from: parsed.values.from,
      limit: parseLimit(parsed.values.limit),
      metadata: parsed.values.metadata ?? false,
      output: parsed.values.output,
      pretty: parsed.values.pretty ?? false,
      profile: parsed.values.profile,
      to: parsed.values.to
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      1,
      "INVALID_ARGUMENTS",
      `${message}. Run "bpmn-cli trace --help" for usage.`,
      format
    );
  }
}

function minimalEnvelope(envelope: TraceEnvelope): JsonObject {
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

  if (Object.keys(analysis).length > 0) {
    result.analysis = analysis;
  }

  return result;
}

function renderJson(
  envelope: TraceEnvelope,
  options: TraceOptions
): string {
  const value =
    options.metadata || options.output !== undefined
      ? envelope
      : minimalEnvelope(envelope);

  return `${JSON.stringify(value, null, options.pretty ? 2 : undefined)}\n`;
}

function textList(value: JsonValue | undefined): string {
  return Array.isArray(value) && value.length > 0
    ? value.join(", ")
    : "(none)";
}

function renderText(envelope: TraceEnvelope): string {
  const trace = envelope.trace;
  const analysis = envelope.analysis;
  const scopes = (trace.scopes as JsonValue[] | undefined) ?? [];

  return `bpmn-cli trace

Mode: ${String(trace.mode)}
From: ${String(trace.fromRef ?? "(none)")}
To: ${String(trace.toRef ?? "(none)")}
Scopes: ${scopes.length}
Connected: ${String(analysis.connected ?? "(not applicable)")}
Truncated: ${String(analysis.truncated)}
Frontier: ${textList(analysis.frontierRefs)}
End events: ${textList(analysis.endEventRefs)}
Dead ends: ${textList(analysis.deadEndRefs)}
Start events: ${textList(analysis.startEventRefs)}
Source elements: ${textList(analysis.sourceElementRefs)}
`;
}

function serialize(
  envelope: TraceEnvelope,
  options: TraceOptions
): string {
  if (options.format === "json") {
    return renderJson(envelope, options);
  }

  return options.format === "mermaid"
    ? renderTraceMermaid(envelope)
    : renderText(envelope);
}

export async function executeTrace(
  args: readonly string[]
): Promise<TraceResult> {
  const parsed = parseTraceOptions(args);

  if (parsed === "help") {
    return { exitCode: 0, output: traceHelpText, stream: "stdout" };
  }

  if ("exitCode" in parsed) {
    return parsed;
  }

  const options = parsed;
  let model;

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

    throw error;
  }

  let envelope: TraceEnvelope;
  let effectiveLimit = options.limit;
  let exceededByteBudget = false;

  while (true) {
    try {
      envelope = createTraceEnvelope(model, {
        all: options.all,
        followMessageFlows: options.followMessageFlows,
        from: options.from,
        limit: effectiveLimit,
        to: options.to
      });
    } catch (error) {
      if (error instanceof TraceGraphError) {
        if (exceededByteBudget) {
          return errorResult(
            1,
            "OUTPUT_TOO_LARGE",
            `Trace output exceeds ${traceLimits.maxStdoutBytes} bytes; use --output or select a narrower trace`,
            options.format
          );
        }

        return errorResult(1, error.code, error.message, options.format);
      }

      throw error;
    }

    const output = serialize(envelope, options);

    if (
      options.output !== undefined ||
      Buffer.byteLength(output) <= traceLimits.maxStdoutBytes
    ) {
      if (options.output !== undefined) {
        try {
          await writeOutputFile(
            options.output,
            output,
            options.force,
            options.file
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return errorResult(
            2,
            "OUTPUT_WRITE_FAILED",
            `Unable to write trace output: ${message}`,
            options.format
          );
        }

        return { exitCode: 0, output: "", stream: "stdout" };
      }

      return { exitCode: 0, output, stream: "stdout" };
    }

    effectiveLimit -= 1;
    exceededByteBudget = true;

    if (effectiveLimit < 1) {
      return errorResult(
        1,
        "OUTPUT_TOO_LARGE",
        `Trace output exceeds ${traceLimits.maxStdoutBytes} bytes; use --output or select a narrower trace`,
        options.format
      );
    }
  }
}
