#!/usr/bin/env node

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

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
  outputFormats?: readonly ["text", "json"];
}

export interface Capabilities {
  schemaVersion: "1";
  cli: {
    name: "bpmn-cli";
    version: string;
    node: ">=20";
  };
  commands: readonly CapabilityCommand[];
  bpmn: {
    parsing: false;
    mutation: false;
    moddleExtensions: readonly string[];
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

Options:
  -h, --help       Display this help message
  -v, --version    Display the CLI version

This is the Phase 0 foundation. BPMN inspection and editing commands will be
added only after their contracts are approved in PLAN.md.
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
      node: ">=20"
    },
    commands: [
      {
        name: "capabilities",
        status: "available",
        outputFormats: ["text", "json"]
      },
      { name: "inspect", status: "planned" },
      { name: "validate", status: "planned" },
      { name: "plan", status: "planned" },
      { name: "diff", status: "planned" },
      { name: "apply", status: "planned" },
      { name: "verify", status: "planned" }
    ],
    bpmn: {
      parsing: false,
      mutation: false,
      moddleExtensions: []
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

BPMN parsing: not implemented
BPMN mutation: not implemented
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

export function execute(args: readonly string[]): CliResult {
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

  return invalidArguments(args);
}

export function run(
  args: readonly string[],
  stdout: Writer = process.stdout,
  stderr: Writer = process.stderr
): number {
  const result = execute(args);
  (result.stream === "stdout" ? stdout : stderr).write(result.output);
  return result.exitCode;
}

const invokedPath = process.argv[1];

if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  process.exitCode = run(process.argv.slice(2));
}
