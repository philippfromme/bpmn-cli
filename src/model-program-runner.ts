import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { BpmnModel } from "./model.js";

interface ProgramModule {
  default?: unknown;
}

function report(value: object): void {
  writeSync(3, `${JSON.stringify(value)}\n`);
}

const program = process.argv[2];

if (program === undefined) {
  report({
    error: {
      code: "PROGRAM_ARGUMENT_MISSING",
      message: "Model program path is required"
    },
    schemaVersion: "1",
    view: "model-program-runner"
  });
  process.exitCode = 1;
} else {
  try {
    const module = await import(pathToFileURL(program).href) as ProgramModule;

    if (typeof module.default !== "function") {
      throw new Error("Model program must have an async default export");
    }

    const result = await module.default(Object.freeze({ BpmnModel }));
    report({
      result: result ?? null,
      schemaVersion: "1",
      status: "completed",
      view: "model-program-runner"
    });
  } catch (error) {
    report({
      error: {
        code: "PROGRAM_FAILED",
        message: error instanceof Error ? error.message : String(error)
      },
      schemaVersion: "1",
      view: "model-program-runner"
    });
    process.exitCode = 1;
  }
}
