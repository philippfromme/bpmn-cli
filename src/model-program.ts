import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import type { CliResult } from "./index.js";

interface RunnerEnvelope {
  error?: {
    code: string;
    message: string;
  };
  result?: unknown;
  schemaVersion: "1";
  status?: "completed";
  view: "model-program-runner";
}

export const modelProgramHelpText = `Usage:
  bpmn-cli model <program.mjs> [--json]

Run a trusted local ESM model program in an isolated Node.js process.

The program must default-export an async function that receives { BpmnModel }.
It owns model construction and calls model.publish(), which performs layout,
reload verification, semantic reporting, and atomic publication.

This command executes no snippets and does not sandbox the trusted program.

Options:
  --json                  Emit versioned JSON
  -h, --help              Display this help message
`;

function errorResult(code: string, message: string, json: boolean): CliResult {
  return json
    ? {
        exitCode: 1,
        output: `${JSON.stringify({
          schemaVersion: "1",
          error: { code, exitCode: 1, message }
        })}\n`,
        stream: "stderr"
      }
    : {
        exitCode: 1,
        output: `${message}\n`,
        stream: "stderr"
      };
}

function parseProgramOptions(
  args: readonly string[]
): { json: boolean; program: string } | CliResult | "help" {
  const json = args.includes("--json");

  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" }
      }
    });

    if (parsed.values.help) {
      if (parsed.positionals.length > 0 || args.length > 1) {
        throw new Error("--help cannot be combined with other arguments");
      }
      return "help";
    }

    if (parsed.positionals.length !== 1) {
      throw new Error("model requires exactly one ESM program path");
    }

    const program = parsed.positionals[0] as string;
    if (!program.endsWith(".mjs") && !program.endsWith(".js")) {
      throw new Error("model program must use a .mjs or .js extension");
    }

    return { json, program };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      "INVALID_ARGUMENTS",
      `${message}. Run "bpmn-cli model --help" for usage.`,
      json
    );
  }
}

async function runProgram(program: string): Promise<{
  envelope: RunnerEnvelope;
  stderr: string;
  status: number | null;
}> {
  const runner = fileURLToPath(new URL("./model-program-runner.js", import.meta.url));
  const child = spawn(process.execPath, [runner, program], {
    stdio: ["ignore", "ignore", "pipe", "pipe"]
  });
  const stderr: Buffer[] = [];
  const report: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdio[3]?.on("data", (chunk: Buffer) => report.push(chunk));
  const status = await new Promise<number | null>((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("close", resolveStatus);
  });
  const text = Buffer.concat(report).toString("utf8").trim();

  let envelope: RunnerEnvelope;
  try {
    envelope = JSON.parse(text) as RunnerEnvelope;
  } catch {
    throw new Error("Model program runner did not return a valid status document");
  }

  return { envelope, stderr: Buffer.concat(stderr).toString("utf8"), status };
}

export async function executeModelProgram(
  args: readonly string[]
): Promise<CliResult> {
  const parsed = parseProgramOptions(args);

  if (parsed === "help") {
    return { exitCode: 0, output: modelProgramHelpText, stream: "stdout" };
  }
  if ("exitCode" in parsed) {
    return parsed;
  }

  const program = resolve(parsed.program);
  try {
    await access(program, constants.R_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      "PROGRAM_READ_FAILED",
      `Unable to read model program "${parsed.program}": ${message}`,
      parsed.json
    );
  }

  try {
    const result = await runProgram(program);
    if (
      result.status !== 0 ||
      result.envelope.error !== undefined ||
      result.envelope.status !== "completed"
    ) {
      return errorResult(
        result.envelope.error?.code ?? "PROGRAM_FAILED",
        result.envelope.error?.message ??
          (result.stderr.length > 0
            ? result.stderr.trim()
            : "Model program exited without completion"),
        parsed.json
      );
    }

    const envelope = {
      program: parsed.program,
      result: result.envelope.result ?? null,
      schemaVersion: "1",
      status: "completed",
      view: "model-program"
    };
    return {
      exitCode: 0,
      output: parsed.json
        ? `${JSON.stringify(envelope)}\n`
        : `Model program completed: ${parsed.program}\n`,
      stream: "stdout"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult("PROGRAM_FAILED", message, parsed.json);
  }
}
