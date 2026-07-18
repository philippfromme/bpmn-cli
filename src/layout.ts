import { parseArgs } from "node:util";

import { LayoutError, layoutProcess } from "bpmn-auto-layout";

import { engines } from "./engines.js";
import {
  loadSemanticModelFromDocument,
  ModelLoadError,
  readSourceDocument
} from "./model-loader.js";
import {
  replaceSourceFile,
  writeOutputFile
} from "./output.js";
import type { JsonObject, JsonValue } from "./project.js";

export interface LayoutResult {
  exitCode: number;
  output: string;
  stream: "stderr" | "stdout";
}

interface LayoutOptions {
  autoProfile: boolean;
  extensions: string[];
  file: string;
  force: boolean;
  json: boolean;
  output?: string;
  profile?: "zeebe";
}

export const layoutHelpText = `Usage:
  bpmn-cli layout <file> [options]

Replace BPMN DI with a complete greenfield layout.

Profiles:
  --profile zeebe         Load the built-in Zeebe moddle profile
  --no-auto-profile       Disable namespace-based profile detection
  --extension <name>=<descriptor.json>
                          Load a data-only moddle descriptor; repeatable

Output:
  --output <path>         Write a separate BPMN file instead of replacing source
  --force                 Allow replacing the separate output file
  --json                  Emit versioned JSON
  -h, --help              Display this help message

Layout is published only when semantic hashes before and after are identical.
`;

function errorResult(
  exitCode: number,
  code: string,
  message: string,
  json: boolean
): LayoutResult {
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

function parseLayoutOptions(
  args: readonly string[]
): LayoutOptions | LayoutResult | "help" {
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
        json: { type: "boolean" },
        "no-auto-profile": { type: "boolean" },
        output: { type: "string" },
        profile: { type: "string" }
      }
    });

    if (parsed.values.help) {
      if (parsed.positionals.length > 0 || args.length > 1) {
        throw new Error("--help cannot be combined with other arguments");
      }
      return "help";
    }

    if (parsed.positionals.length !== 1) {
      throw new Error("layout requires exactly one BPMN file");
    }

    if (
      parsed.values.profile !== undefined &&
      parsed.values.profile !== "zeebe"
    ) {
      throw new Error(`unknown profile: ${parsed.values.profile}`);
    }

    if (parsed.values.force && parsed.values.output === undefined) {
      throw new Error("--force requires --output");
    }

    return {
      autoProfile: !(parsed.values["no-auto-profile"] ?? false),
      extensions: parsed.values.extension ?? [],
      file: parsed.positionals[0] as string,
      force: parsed.values.force ?? false,
      json,
      output: parsed.values.output,
      profile: parsed.values.profile
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      1,
      "INVALID_ARGUMENTS",
      `${message}. Run "bpmn-cli layout --help" for usage.`,
      json
    );
  }
}

function profileRecords(profiles: readonly object[]): JsonValue[] {
  return profiles.map(
    (profile) =>
      Object.fromEntries(
        Object.entries(profile).filter(([, value]) => value !== undefined)
      ) as JsonObject
  );
}

function renderText(envelope: JsonObject): string {
  return `bpmn-cli layout

Status: ${String(envelope.status)}
Destination: ${String(envelope.destination)}
Source SHA-256: ${String(envelope.sourceSha256)}
Output SHA-256: ${String(envelope.outputSha256)}
Semantic hash: ${String(envelope.semanticHash)}
`;
}

export async function executeLayout(
  args: readonly string[]
): Promise<LayoutResult> {
  const parsed = parseLayoutOptions(args);

  if (parsed === "help") {
    return { exitCode: 0, output: layoutHelpText, stream: "stdout" };
  }

  if ("exitCode" in parsed) {
    return parsed;
  }

  const options = parsed;

  try {
    const source = await readSourceDocument(options.file);
    const loaderOptions = {
      autoProfile: options.autoProfile,
      extensions: options.extensions,
      profile: options.profile
    };
    const before = await loadSemanticModelFromDocument(source, loaderOptions);
    let laidOutXml: string;

    try {
      laidOutXml = await layoutProcess(source.xml);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(
        1,
        error instanceof LayoutError ? "LAYOUT_UNSUPPORTED" : "LAYOUT_FAILED",
        `Unable to layout BPMN: ${message}`,
        options.json
      );
    }

    const outputBytes = Buffer.from(laidOutXml, "utf8");
    const staged = {
      bytes: outputBytes,
      path: options.output ?? options.file,
      xml: laidOutXml
    };
    const after = await loadSemanticModelFromDocument(staged, loaderOptions);

    if (before.semanticHash !== after.semanticHash) {
      return errorResult(
        1,
        "LAYOUT_SEMANTICS_CHANGED",
        "Layout changed BPMN business semantics; no output was published",
        options.json
      );
    }

    const destination = options.output ?? options.file;

    try {
      if (options.output === undefined) {
        await replaceSourceFile(options.file, laidOutXml);
      } else {
        await writeOutputFile(
          options.output,
          laidOutXml,
          options.force,
          options.file
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(
        2,
        "OUTPUT_WRITE_FAILED",
        `Unable to publish laid-out BPMN: ${message}`,
        options.json
      );
    }

    const envelope: JsonObject = {
      schemaVersion: "1",
      view: "layout",
      status: "written",
      destination,
      sourceSha256: before.source.sha256,
      outputSha256: after.source.sha256,
      semanticHash: after.semanticHash,
      profiles: profileRecords(after.profiles),
      engine: engines.autoLayout
    };

    return {
      exitCode: 0,
      output: options.json
        ? `${JSON.stringify(envelope)}\n`
        : renderText(envelope),
      stream: "stdout"
    };
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
      "LAYOUT_FAILED",
      `Unable to layout BPMN: ${message}`,
      options.json
    );
  }
}
