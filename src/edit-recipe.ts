import { parseArgs } from "node:util";

import type { ModdleElement } from "bpmn-moddle";

import {
  loadSemanticModel,
  ModelLoadError
} from "./model-loader.js";
import type { JsonObject } from "./project.js";

export interface EditRecipeResult {
  exitCode: number;
  output: string;
  stream: "stderr" | "stdout";
}

export const editRecipeHelpText = `Common edit recipes:
  bpmn-cli edit <file> --recipe insert-activity --flow <sequence-flow-id> \\
    --type <activity-type> --name <name> --json [--form-id <form-id>]

Recipes generate a schema-valid Edit v1 request on stdout; they never modify
BPMN. Save the result as a request file, then preview it with \`bpmn-cli edit\`.

Available recipes:
  insert-activity     Split a SequenceFlow by inserting one activity.
                      Use --type zeebe:userTask for a native Camunda user task.
                      --form-id adds zeebe:FormDefinition to that user task.
`;

interface RecipeOptions {
  autoProfile: boolean;
  extensions: string[];
  file: string;
  flow: string;
  formId?: string;
  name: string;
  profile?: "zeebe";
  type: string;
}

const ACTIVITY_TYPES = new Set([
  "bpmn:Task",
  "bpmn:UserTask",
  "bpmn:ServiceTask",
  "bpmn:ScriptTask",
  "bpmn:ManualTask",
  "bpmn:BusinessRuleTask",
  "bpmn:SendTask",
  "bpmn:ReceiveTask",
  "bpmn:CallActivity",
  "bpmn:SubProcess"
]);

function errorResult(
  code: string,
  message: string,
  json: boolean
): EditRecipeResult {
  return {
    exitCode: 1,
    output: json
      ? `${JSON.stringify({ schemaVersion: "1", error: { code, message } })}\n`
      : `${message}\n`,
    stream: "stderr"
  };
}

function parseRecipeOptions(
  args: readonly string[]
): RecipeOptions | EditRecipeResult | "help" {
  const json = args.includes("--json");

  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        extension: { type: "string", multiple: true },
        flow: { type: "string" },
        "form-id": { type: "string" },
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        "no-auto-profile": { type: "boolean" },
        profile: { type: "string" },
        recipe: { type: "string" },
        type: { type: "string" },
        name: { type: "string" }
      }
    });

    if (parsed.values.help) {
      if (args.length !== 3 || parsed.values.recipe !== "insert-activity") {
        throw new Error("--help must be used as: bpmn-cli edit --recipe <name> --help");
      }
      return "help";
    }

    if (parsed.values.recipe !== "insert-activity") {
      throw new Error(`unknown edit recipe: ${parsed.values.recipe ?? "(missing)"}`);
    }
    if (!parsed.values.json) {
      throw new Error("--recipe requires --json");
    }
    if (parsed.positionals.length !== 1) {
      throw new Error("edit recipe requires exactly one BPMN file");
    }
    if (parsed.values.flow === undefined) {
      throw new Error("insert-activity requires --flow");
    }
    if (parsed.values.type === undefined) {
      throw new Error("insert-activity requires --type");
    }
    if (parsed.values.name === undefined || parsed.values.name.trim() === "") {
      throw new Error("insert-activity requires a non-empty --name");
    }
    if (parsed.values.profile !== undefined && parsed.values.profile !== "zeebe") {
      throw new Error(`unknown profile: ${parsed.values.profile}`);
    }

    return {
      autoProfile: !(parsed.values["no-auto-profile"] ?? false),
      extensions: parsed.values.extension ?? [],
      file: parsed.positionals[0] as string,
      flow: parsed.values.flow,
      formId: parsed.values["form-id"],
      name: parsed.values.name,
      profile: parsed.values.profile,
      type: parsed.values.type
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      "INVALID_ARGUMENTS",
      `${message}. Run "bpmn-cli edit --help" for usage.`,
      json
    );
  }
}

function isModdleElement(value: unknown): value is ModdleElement {
  return typeof value === "object" && value !== null && "$type" in value;
}

function isRecipeResult(value: JsonObject | EditRecipeResult): value is EditRecipeResult {
  return "exitCode" in value;
}

function activityValue(options: RecipeOptions): JsonObject | EditRecipeResult {
  const nativeZeebeUserTask = options.type === "zeebe:userTask";
  const type = nativeZeebeUserTask ? "bpmn:UserTask" : options.type;

  if (!ACTIVITY_TYPES.has(type)) {
    return errorResult(
      "EDIT_RECIPE_TYPE_INVALID",
      `insert-activity requires a supported BPMN activity type; received "${options.type}"`,
      true
    );
  }
  if (options.formId !== undefined && !nativeZeebeUserTask) {
    return errorResult(
      "EDIT_RECIPE_FORM_UNSUPPORTED",
      "--form-id requires --type zeebe:userTask",
      true
    );
  }

  const value: JsonObject = { $type: type, name: options.name };

  if (nativeZeebeUserTask) {
    value.extensionElements = {
      $type: "bpmn:ExtensionElements",
      values: [
        { $type: "zeebe:UserTask" },
        ...(options.formId === undefined
          ? []
          : [{ $type: "zeebe:FormDefinition", formId: options.formId }])
      ]
    };
  }

  return value;
}

export async function executeEditRecipe(
  args: readonly string[]
): Promise<EditRecipeResult> {
  const options = parseRecipeOptions(args);
  if (options === "help") {
    return { exitCode: 0, output: editRecipeHelpText, stream: "stdout" };
  }
  if ("exitCode" in options) {
    return options;
  }

  const value = activityValue(options);
  if (isRecipeResult(value)) {
    return value;
  }

  try {
    const model = await loadSemanticModel({
      autoProfile: options.autoProfile,
      extensions: options.extensions,
      file: options.file,
      profile: options.profile
    });
    const flow = model.byId.get(options.flow);

    if (flow === undefined) {
      return errorResult(
        "EDIT_TARGET_NOT_FOUND",
        `SequenceFlow "${options.flow}" was not found`,
        true
      );
    }
    if (flow.$type !== "bpmn:SequenceFlow") {
      return errorResult(
        "EDIT_RECIPE_FLOW_INVALID",
        `"${options.flow}" is ${flow.$type}, not bpmn:SequenceFlow`,
        true
      );
    }

    const target = flow.get("targetRef");
    const container = flow.$parent;
    if (!isModdleElement(target) || target.id === undefined || !isModdleElement(container)) {
      return errorResult(
        "EDIT_BPMN_STRUCTURE_INVALID",
        `SequenceFlow "${options.flow}" must have a contained targetRef`,
        true
      );
    }

    const flowElements = container.get("flowElements");
    if (!Array.isArray(flowElements)) {
      return errorResult(
        "EDIT_BPMN_STRUCTURE_INVALID",
        `SequenceFlow "${options.flow}" is not contained by a flow-element scope`,
        true
      );
    }

    const request = {
      schemaVersion: "1",
      operations: [
        {
          op: "add",
          target: container.id,
          path: "/flowElements/-",
          value,
          as: "$insertedActivity",
          expect: [
            { target: container.id, path: "/flowElements", length: flowElements.length }
          ]
        },
        {
          op: "replace",
          target: flow.id,
          path: "/targetRef",
          value: "$insertedActivity",
          expect: [
            { target: flow.id, path: "/targetRef", equals: target.id }
          ]
        },
        {
          op: "add",
          target: container.id,
          path: "/flowElements/-",
          value: {
            $type: "bpmn:SequenceFlow",
            sourceRef: "$insertedActivity",
            targetRef: target.id
          },
          as: "$downstreamFlow",
          expect: [
            { target: container.id, path: "/flowElements", length: flowElements.length + 1 }
          ]
        }
      ]
    };

    return {
      exitCode: 0,
      output: `${JSON.stringify(request, null, 2)}\n`,
      stream: "stdout"
    };
  } catch (error) {
    if (error instanceof ModelLoadError) {
      return errorResult(error.code, error.message, true);
    }
    throw error;
  }
}