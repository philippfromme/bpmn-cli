import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { Linter, type LintReport } from "bpmnlint";
import NodeResolver from "bpmnlint/lib/resolver/node-resolver.js";

import { engines } from "./engines.js";
import {
  loadSemanticModel,
  ModelLoadError
} from "./model-loader.js";
import { writeOutputFile } from "./output.js";
import {
  validateDescriptor,
  type ActiveProfile,
  type ModdlePackageDescriptor,
  ProfileError
} from "./profiles.js";
import type { JsonObject, JsonValue } from "./project.js";

export const lintLimits = {
  maxStdoutBytes: 32 * 1024
} as const;

export interface LintResult {
  exitCode: number;
  output: string;
  stream: "stderr" | "stdout";
}

interface LintOptions {
  autoProfile: boolean;
  config?: string;
  extensions: string[];
  file: string;
  force: boolean;
  json: boolean;
  profile?: "zeebe";
  report?: string;
}

interface LoadedLintConfig {
  config: Record<string, unknown>;
  packages: Record<string, ModdlePackageDescriptor>;
  profiles: ActiveProfile[];
  resolver: NodeResolver;
  source: JsonObject;
}

interface Finding {
  category: "error" | "warning";
  elementRef?: string;
  message: string;
  path?: JsonValue[];
  rule: string;
}

export const lintHelpText = `Usage:
  bpmn-cli lint <file> [options]

Lint one BPMN model with bpmnlint.

Configuration:
  --config <path>         Use an explicit bpmnlint configuration
                          Default: .bpmnlintrc or bpmnlint:correctness

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

Configured errors exit 1. Warning-only results exit 0.
`;

function errorResult(
  exitCode: number,
  code: string,
  message: string,
  json: boolean
): LintResult {
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

function parseLintOptions(
  args: readonly string[]
): LintOptions | LintResult | "help" {
  const json = args.includes("--json");

  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string" },
        extension: { type: "string", multiple: true },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
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

    if (parsed.positionals.length !== 1) {
      throw new Error("lint requires exactly one BPMN file");
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
      autoProfile: !(parsed.values["no-auto-profile"] ?? false),
      config: parsed.values.config,
      extensions: parsed.values.extension ?? [],
      file: parsed.positionals[0] as string,
      force: parsed.values.force ?? false,
      json,
      profile: parsed.values.profile,
      report: parsed.values.report
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      1,
      "INVALID_ARGUMENTS",
      `${message}. Run "bpmn-cli lint --help" for usage.`,
      json
    );
  }
}

function packageDescriptor(value: unknown): unknown {
  return (
    typeof value === "object" &&
    value !== null &&
    "default" in value
      ? (value as { default: unknown }).default
      : value
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function loadLintConfig(
  explicitPath: string | undefined
): Promise<LoadedLintConfig> {
  const fallback = { extends: "bpmnlint:correctness" };
  const defaultPath = resolve(".bpmnlintrc");
  const path =
    explicitPath === undefined
      ? (await pathExists(defaultPath))
        ? defaultPath
        : undefined
      : resolve(explicitPath);
  let config: Record<string, unknown>;

  if (path === undefined) {
    config = fallback;
  } else {
    let contents: string;

    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelLoadError(
        2,
        "LINT_CONFIG_READ_FAILED",
        `Unable to read bpmnlint configuration "${path}": ${message}`
      );
    }

    try {
      const parsed = JSON.parse(contents) as unknown;

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("expected a JSON object");
      }
      config = parsed as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelLoadError(
        1,
        "LINT_CONFIG_INVALID",
        `Invalid bpmnlint configuration "${path}": ${message}`
      );
    }
  }

  const scopedRequire = createRequire(path ?? resolve("package.json"));
  const resolver = new NodeResolver({ require: scopedRequire });
  const packages: Record<string, ModdlePackageDescriptor> = {};
  const profiles: ActiveProfile[] = [];
  const configuredExtensions = config.moddleExtensions;

  if (
    configuredExtensions !== undefined &&
    (typeof configuredExtensions !== "object" ||
      configuredExtensions === null ||
      Array.isArray(configuredExtensions))
  ) {
    throw new ModelLoadError(
      1,
      "LINT_CONFIG_INVALID",
      "bpmnlint moddleExtensions must be an object"
    );
  }

  for (const [name, specification] of Object.entries(
    (configuredExtensions ?? {}) as Record<string, unknown>
  )) {
    if (typeof specification !== "string") {
      throw new ModelLoadError(
        1,
        "LINT_CONFIG_INVALID",
        `bpmnlint moddle extension "${name}" must be a module name`
      );
    }

    let descriptor: unknown;
    let resolvedPath: string;

    try {
      resolvedPath = scopedRequire.resolve(specification);
      descriptor = packageDescriptor(scopedRequire(specification));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelLoadError(
        2,
        "LINT_EXTENSION_LOAD_FAILED",
        `Unable to load bpmnlint moddle extension "${specification}": ${message}`
      );
    }

    try {
      validateDescriptor(descriptor, specification);
    } catch (error) {
      if (error instanceof ProfileError) {
        throw new ModelLoadError(
          1,
          "LINT_CONFIG_INVALID",
          error.message
        );
      }
      throw error;
    }
    packages[name] = descriptor;
    profiles.push({
      name,
      namespace: descriptor.uri,
      package: specification,
      path: resolvedPath,
      source: "file"
    });
  }

  return {
    config,
    packages,
    profiles,
    resolver,
    source:
      path === undefined
        ? { source: "fallback", extends: "bpmnlint:correctness" }
        : { source: "file", path }
  };
}

function normalizedFindings(
  reports: Record<string, LintReport[]>,
  modelOrder: ReadonlyMap<string, number>,
  importFindings: readonly Finding[]
): Finding[] {
  const findings: Finding[] = [...importFindings];

  for (const [rule, ruleReports] of Object.entries(reports)) {
    for (const report of ruleReports) {
      findings.push({
        rule,
        category: report.category === "error" ? "error" : "warning",
        message: report.message,
        ...(report.id === undefined ? {} : { elementRef: report.id }),
        ...(report.path === undefined
          ? {}
          : { path: report.path as JsonValue[] })
      });
    }
  }

  return findings.sort((left, right) => {
    const leftIndex =
      left.elementRef === undefined
        ? Number.MAX_SAFE_INTEGER
        : (modelOrder.get(left.elementRef) ?? Number.MAX_SAFE_INTEGER);
    const rightIndex =
      right.elementRef === undefined
        ? Number.MAX_SAFE_INTEGER
        : (modelOrder.get(right.elementRef) ?? Number.MAX_SAFE_INTEGER);

    return (
      leftIndex - rightIndex ||
      left.rule.localeCompare(right.rule) ||
      JSON.stringify(left.path ?? []).localeCompare(
        JSON.stringify(right.path ?? [])
      )
    );
  });
}

function renderText(envelope: JsonObject): string {
  const findings = envelope.findings as JsonObject[];
  const counts = envelope.counts as JsonObject;
  const lines = findings.map((finding) => {
    const target =
      typeof finding.elementRef === "string" ? ` ${finding.elementRef}` : "";
    return `${String(finding.category).padEnd(7)}${target} ${String(finding.rule)}: ${String(finding.message)}`;
  });

  return `bpmn-cli lint

${lines.length === 0 ? "No findings." : lines.join("\n")}

Errors: ${String(counts.errors)}
Warnings: ${String(counts.warnings)}
`;
}

export async function executeLint(
  args: readonly string[]
): Promise<LintResult> {
  const parsed = parseLintOptions(args);

  if (parsed === "help") {
    return { exitCode: 0, output: lintHelpText, stream: "stdout" };
  }

  if ("exitCode" in parsed) {
    return parsed;
  }

  const options = parsed;

  try {
    const lintConfig = await loadLintConfig(options.config);
    const model = await loadSemanticModel({
      additionalPackages: lintConfig.packages,
      additionalProfiles: lintConfig.profiles,
      autoProfile: options.autoProfile,
      extensions: options.extensions,
      file: options.file,
      profile: options.profile
    });
    const linter = new Linter({
      config: lintConfig.config,
      resolver: lintConfig.resolver
    });
    const reports = await linter.lint(model.definitions);
    const modelOrder = new Map(
      model.allElements.flatMap((element, index) =>
        element.id === undefined ? [] : [[element.id, index] as const]
      )
    );
    const importFindings = model.diagnostics
      .filter(
        ({ code }) =>
          code === "BPMN_PARSE_WARNING" || code === "UNRESOLVED_REFERENCE"
      )
      .map(
        ({ elementRef, message, property }): Finding => ({
          rule: "bpmn-import",
          category: "error",
          message,
          ...(elementRef === undefined ? {} : { elementRef }),
          ...(property === undefined ? {} : { path: [property] })
        })
      );
    const findings = normalizedFindings(
      reports,
      modelOrder,
      importFindings
    );
    const errors = findings.filter(
      ({ category }) => category === "error"
    ).length;
    const warnings = findings.length - errors;
    const envelope: JsonObject = {
      schemaVersion: "1",
      view: "lint",
      source: model.source as unknown as JsonObject,
      semanticHash: model.semanticHash,
      profiles: model.profiles as unknown as JsonValue[],
      config: lintConfig.source,
      engine: engines.lint,
      counts: { errors, warnings },
      findings: findings as unknown as JsonValue[]
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
          options.file
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(
          2,
          "OUTPUT_WRITE_FAILED",
          `Unable to write lint report: ${message}`,
          options.json
        );
      }
      return { exitCode: errors > 0 ? 1 : 0, output: "", stream: "stdout" };
    }

    if (Buffer.byteLength(output) > lintLimits.maxStdoutBytes) {
      return errorResult(
        1,
        "OUTPUT_TOO_LARGE",
        `Lint output exceeds ${lintLimits.maxStdoutBytes} bytes; use --json --report`,
        options.json
      );
    }

    return {
      exitCode: errors > 0 ? 1 : 0,
      output,
      stream: errors > 0 ? "stderr" : "stdout"
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
      "LINT_FAILED",
      `Unable to lint BPMN: ${message}`,
      options.json
    );
  }
}
