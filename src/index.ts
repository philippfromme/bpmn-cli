#!/usr/bin/env node

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { executeDiff, diffLimits } from "./diff.js";
import { engines } from "./engines.js";
import { executeInspect, inspectLimits } from "./inspect.js";
import { executeLayout } from "./layout.js";
import { executeLint, lintLimits } from "./lint.js";
import { executeTrace, traceLimits } from "./trace.js";

interface PackageManifest {
  version: string;
}

export interface CliResult {
  exitCode: number;
  output: string;
  stream: "stdout" | "stderr";
}

export interface Writer {
  write(chunk: string): unknown;
}

interface CapabilityCommand {
  name: string;
  status: "available" | "planned";
  outputFormats?: readonly ("text" | "json" | "jsonl" | "mermaid")[];
}

export interface Capabilities {
  schemaVersion: "1";
  cli: {
    name: "bpmn-cli";
    version: string;
    node: ">=20.12";
  };
  commands: readonly CapabilityCommand[];
  bpmn: {
    parsing: true;
    mutation: false;
    moddleExtensions: readonly string[];
  };
  inspection: {
    views: readonly ["model", "process", "scope", "element"];
    formats: readonly ["text", "json", "jsonl"];
    profiles: readonly ["zeebe"];
    customExtensions: true;
    metadata: {
      default: "minimal";
      optIn: "--metadata";
      outputFiles: "full";
    };
    paging: typeof inspectLimits;
  };
  tracing: {
    endpointTypes: readonly ["flowNode", "sequenceFlow", "messageFlow"];
    followMessageFlows: "opt-in";
    formats: readonly ["text", "json", "mermaid"];
    limits: typeof traceLimits;
    metadata: {
      default: "minimal";
      optIn: "--metadata";
      outputFiles: "full";
    };
    modes: readonly ["forward", "backward", "connecting"];
  };
  utilities: {
    diff: {
      formats: readonly ["text", "json"];
      includeLayout: "opt-in";
      limits: typeof diffLimits;
    };
    engines: typeof engines;
    layout: {
      formats: readonly ["text", "json"];
      writes: "in-place-or-output";
    };
    lint: {
      fallbackConfig: "bpmnlint:correctness";
      formats: readonly ["text", "json"];
      limits: typeof lintLimits;
    };
  };
}

const require = createRequire(import.meta.url);
const packageManifest = require("../package.json") as PackageManifest;

export const version = packageManifest.version;

const helpText = `bpmn-cli - BPMN moddle command-line tools

Usage:
  bpmn-cli <command> [options]

Commands:
  capabilities      Show implemented and planned capabilities
  diff              Compare BPMN semantics
  inspect           Inspect bounded BPMN business semantics
  layout            Replace BPMN DI with greenfield layout
  lint              Run configured bpmnlint rules
  trace             Trace bounded BPMN business behavior
  help [command]    Show global or command-specific help

Options:
  -h, --help       Display this help message
  -v, --version    Display the CLI version

Model mutation commands will be added only after their contracts are approved
in PLAN.md. Run "bpmn-cli <command> --help" for command options.
`;

const capabilitiesHelpText = `Usage:
  bpmn-cli capabilities [--json]

Show the CLI version, command availability, and BPMN feature status.

Options:
  --json           Emit a stable, machine-readable JSON document
  -h, --help       Display this help message
`;

export function getCapabilities(): Capabilities {
  return {
    schemaVersion: "1",
    cli: {
      name: "bpmn-cli",
      version,
      node: ">=20.12"
    },
    commands: [
      {
        name: "capabilities",
        status: "available",
        outputFormats: ["text", "json"]
      },
      {
        name: "inspect",
        status: "available",
        outputFormats: ["text", "json", "jsonl"]
      },
      {
        name: "trace",
        status: "available",
        outputFormats: ["text", "json", "mermaid"]
      },
      {
        name: "lint",
        status: "available",
        outputFormats: ["text", "json"]
      },
      {
        name: "diff",
        status: "available",
        outputFormats: ["text", "json"]
      },
      {
        name: "layout",
        status: "available",
        outputFormats: ["text", "json"]
      },
      { name: "edit", status: "planned" }
    ],
    bpmn: {
      parsing: true,
      mutation: false,
      moddleExtensions: ["zeebe"]
    },
    inspection: {
      views: ["model", "process", "scope", "element"],
      formats: ["text", "json", "jsonl"],
      profiles: ["zeebe"],
      customExtensions: true,
      metadata: {
        default: "minimal",
        optIn: "--metadata",
        outputFiles: "full"
      },
      paging: inspectLimits
    },
    tracing: {
      endpointTypes: ["flowNode", "sequenceFlow", "messageFlow"],
      followMessageFlows: "opt-in",
      formats: ["text", "json", "mermaid"],
      limits: traceLimits,
      metadata: {
        default: "minimal",
        optIn: "--metadata",
        outputFiles: "full"
      },
      modes: ["forward", "backward", "connecting"]
    },
    utilities: {
      diff: {
        formats: ["text", "json"],
        includeLayout: "opt-in",
        limits: diffLimits
      },
      engines,
      layout: {
        formats: ["text", "json"],
        writes: "in-place-or-output"
      },
      lint: {
        fallbackConfig: "bpmnlint:correctness",
        formats: ["text", "json"],
        limits: lintLimits
      }
    }
  };
}

function renderCapabilities(capabilities: Capabilities): string {
  const commands = capabilities.commands
    .map(({ name, status }) => `  ${name.padEnd(12)} ${status}`)
    .join("\n");

  return `bpmn-cli capabilities

CLI version: ${capabilities.cli.version}
Node.js: ${capabilities.cli.node}

Commands:
${commands}

BPMN parsing: available
BPMN mutation: not implemented
Inspect views: model, process, scope, element
Inspect formats: text, json, jsonl
Trace modes: forward, backward, connecting
Trace formats: text, json, mermaid
Lint fallback: bpmnlint:correctness
Diff layout changes: opt-in
Layout writes: in-place or output
`;
}

function executeCapabilities(args: readonly string[]): CliResult {
  if (args.length === 0) {
    return {
      exitCode: 0,
      output: renderCapabilities(getCapabilities()),
      stream: "stdout"
    };
  }

  if (args.length === 1 && args[0] === "--json") {
    return {
      exitCode: 0,
      output: `${JSON.stringify(getCapabilities(), null, 2)}\n`,
      stream: "stdout"
    };
  }

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return {
      exitCode: 0,
      output: capabilitiesHelpText,
      stream: "stdout"
    };
  }

  return invalidArguments(["capabilities", ...args]);
}

function invalidArguments(args: readonly string[]): CliResult {
  return {
    exitCode: 1,
    output: `Unknown command or option: ${args.join(" ")}\nRun "bpmn-cli --help" for usage.\n`,
    stream: "stderr"
  };
}

async function executeHelp(args: readonly string[]): Promise<CliResult> {
  if (args.length === 0) {
    return { exitCode: 0, output: helpText, stream: "stdout" };
  }

  if (args.length === 1 && args[0] === "capabilities") {
    return executeCapabilities(["--help"]);
  }

  if (args.length === 1 && args[0] === "inspect") {
    return executeInspect(["--help"]);
  }

  if (args.length === 1 && args[0] === "trace") {
    return executeTrace(["--help"]);
  }

  if (args.length === 1 && args[0] === "lint") {
    return executeLint(["--help"]);
  }

  if (args.length === 1 && args[0] === "diff") {
    return executeDiff(["--help"]);
  }

  if (args.length === 1 && args[0] === "layout") {
    return executeLayout(["--help"]);
  }

  return invalidArguments(["help", ...args]);
}

export async function execute(args: readonly string[]): Promise<CliResult> {
  if (args.length === 0) {
    return { exitCode: 0, output: helpText, stream: "stdout" };
  }

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { exitCode: 0, output: helpText, stream: "stdout" };
  }

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    return { exitCode: 0, output: `${version}\n`, stream: "stdout" };
  }

  if (args[0] === "capabilities") {
    return executeCapabilities(args.slice(1));
  }

  if (args[0] === "help") {
    return executeHelp(args.slice(1));
  }

  if (args[0] === "inspect") {
    return executeInspect(args.slice(1));
  }

  if (args[0] === "trace") {
    return executeTrace(args.slice(1));
  }

  if (args[0] === "lint") {
    return executeLint(args.slice(1));
  }

  if (args[0] === "diff") {
    return executeDiff(args.slice(1));
  }

  if (args[0] === "layout") {
    return executeLayout(args.slice(1));
  }

  return invalidArguments(args);
}

export async function run(
  args: readonly string[],
  stdout: Writer = process.stdout,
  stderr: Writer = process.stderr
): Promise<number> {
  const result = await execute(args);
  (result.stream === "stdout" ? stdout : stderr).write(result.output);
  return result.exitCode;
}

const invokedPath = process.argv[1];

if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  process.exitCode = await run(process.argv.slice(2));
}
