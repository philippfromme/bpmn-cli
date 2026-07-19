import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

import { LayoutError, layoutProcess } from "bpmn-auto-layout";
import type { ModdleElement } from "bpmn-moddle";

import { semanticChanges } from "./diff.js";
import {
  applyEditRequest,
  canonicalJson,
  EditEngineError
} from "./edit-engine.js";
import {
  EditRequestError,
  getEditRequestSchema,
  validateEditRequest,
  type EditRequest
} from "./edit-schema.js";
import { editRecipeHelpText } from "./edit-recipe.js";
import { engines } from "./engines.js";
import {
  loadSemanticModelFromDocument,
  ModelLoadError,
  readSourceDocument,
  type SourceDocument
} from "./model-loader.js";
import {
  replaceSourceFile,
  writeOutputFile
} from "./output.js";
import type { ActiveProfile } from "./profiles.js";
import {
  semanticHash,
  type JsonObject,
  type JsonValue
} from "./project.js";
import type { SemanticModel } from "./semantic.js";

export const editLimits = {
  maxStdoutBytes: 32 * 1024
} as const;

export interface EditCommandResult {
  exitCode: number;
  output: string;
  stream: "stderr" | "stdout";
}

interface EditOptions {
  apply?: string;
  applyUnreviewed: boolean;
  autoProfile: boolean;
  extensions: string[];
  file: string;
  force: boolean;
  json: boolean;
  layout: "auto" | "none";
  output?: string;
  profile?: "zeebe";
  report?: string;
  request: string;
}

interface EditPlan {
  envelope: JsonObject;
  finalXml: string;
  planHash: string;
}

interface BpmnPublication {
  destination: string;
  outputSha256: string;
  status: "written";
}

interface EditPublicationState {
  bpmn: BpmnPublication;
  report: {
    status: "failed";
  };
}

interface ErrorResultOptions {
  details?: JsonValue;
  publication?: EditPublicationState;
}

interface PackageManifest {
  version: string;
}

const require = createRequire(import.meta.url);
const packageManifest = require("../package.json") as PackageManifest;

export const editHelpText = `Usage:
  bpmn-cli edit --schema --json
  bpmn-cli edit <file> --request <request.json> [options]

Preview descriptor-driven BPMN changes by default. Applying requires the exact
plan hash returned by preview.

Approval:
  --apply <plan-hash>     Apply exactly the recomputed preview
  --apply-unreviewed      Validate, verify, and write without external preview review
  --no-layout             Remove DI instead of applying greenfield layout

Profiles:
  --profile zeebe         Load the built-in Zeebe moddle profile
  --no-auto-profile       Disable namespace-based profile detection
  --extension <name>=<descriptor.json>
                          Load a data-only moddle descriptor; repeatable

Output:
  --output <path>         Write applied BPMN separately instead of replacing source
  --report <path>         Write the complete JSON result
  --force                 Allow replacing a separate output or report
  --json                  Emit versioned JSON
  -h, --help              Display this help message

Preview never writes BPMN. --apply-unreviewed writes atomically after the same
validation and verification. Auto-layout is the default.

${editRecipeHelpText}
`;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writesBpmn(options: EditOptions): boolean {
  return options.apply !== undefined || options.applyUnreviewed;
}

function errorResult(
  exitCode: number,
  code: string,
  message: string,
  json: boolean,
  options: ErrorResultOptions = {}
): EditCommandResult {
  return json
    ? {
        exitCode,
        output: `${JSON.stringify({
          schemaVersion: "1",
          error: {
            code,
            exitCode,
            message,
            ...(options.details === undefined ? {} : { details: options.details }),
            ...(options.publication === undefined
              ? {}
              : { publication: options.publication })
          }
        })}\n`,
        stream: "stderr"
      }
    : {
        exitCode,
        output: `${message}\n`,
        stream: "stderr"
      };
}

function parseEditOptions(
  args: readonly string[]
): EditOptions | EditCommandResult | "help" | "schema" {
  const json = args.includes("--json");

  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        apply: { type: "string" },
        "apply-unreviewed": { type: "boolean" },
        extension: { type: "string", multiple: true },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        "no-auto-profile": { type: "boolean" },
        "no-layout": { type: "boolean" },
        output: { type: "string" },
        profile: { type: "string" },
        report: { type: "string" },
        request: { type: "string" },
        schema: { type: "boolean" }
      }
    });

    if (parsed.values.help) {
      if (parsed.positionals.length > 0 || args.length > 1) {
        throw new Error("--help cannot be combined with other arguments");
      }
      return "help";
    }

    if (parsed.values.schema) {
      if (
        parsed.positionals.length !== 0 ||
        args.some((argument) => argument !== "--schema" && argument !== "--json") ||
        !parsed.values.json
      ) {
        throw new Error("--schema requires --json and cannot be combined with other arguments");
      }
      return "schema";
    }

    if (parsed.positionals.length !== 1) {
      throw new Error("edit requires exactly one BPMN file");
    }

    if (parsed.values.request === undefined) {
      throw new Error("edit requires --request");
    }

    if (
      parsed.values.profile !== undefined &&
      parsed.values.profile !== "zeebe"
    ) {
      throw new Error(`unknown profile: ${parsed.values.profile}`);
    }

    if (parsed.values.apply !== undefined && parsed.values["apply-unreviewed"]) {
      throw new Error("--apply and --apply-unreviewed cannot be combined");
    }

    if (
      parsed.values.output !== undefined &&
      parsed.values.apply === undefined &&
      !parsed.values["apply-unreviewed"]
    ) {
      throw new Error("--output requires --apply or --apply-unreviewed");
    }

    if (
      parsed.values.force &&
      parsed.values.output === undefined &&
      parsed.values.report === undefined
    ) {
      throw new Error("--force requires --output or --report");
    }

    return {
      apply: parsed.values.apply,
      applyUnreviewed: parsed.values["apply-unreviewed"] ?? false,
      autoProfile: !(parsed.values["no-auto-profile"] ?? false),
      extensions: parsed.values.extension ?? [],
      file: parsed.positionals[0] as string,
      force: parsed.values.force ?? false,
      json,
      layout: parsed.values["no-layout"] ? "none" : "auto",
      output: parsed.values.output,
      profile: parsed.values.profile,
      report: parsed.values.report,
      request: parsed.values.request
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      1,
      "INVALID_ARGUMENTS",
      `${message}. Run "bpmn-cli edit --help" for usage.`,
      json
    );
  }
}

async function readRequest(path: string): Promise<EditRequest> {
  let contents: string;

  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelLoadError(
      2,
      "REQUEST_READ_FAILED",
      `Unable to read edit request "${path}": ${message}`
    );
  }

  let value: unknown;

  try {
    value = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EditRequestError(
      "EDIT_REQUEST_JSON_INVALID",
      `Invalid edit request JSON: ${message}`
    );
  }

  return validateEditRequest(value);
}

function profileRecords(profiles: readonly ActiveProfile[]): JsonValue[] {
  return profiles.map((profile) => {
    const record: JsonObject = {
      name: profile.name,
      namespace: profile.namespace,
      source: profile.source
    };

    if (profile.package !== undefined) {
      record.package = profile.package;
    }
    if (profile.packageVersion !== undefined) {
      record.packageVersion = profile.packageVersion;
    }
    if (profile.descriptorSha256 !== undefined) {
      record.descriptorSha256 = profile.descriptorSha256;
    }

    return record;
  });
}

function setDiagrams(
  definitions: ModdleElement,
  diagrams: ModdleElement[]
): void {
  definitions.set("diagrams", diagrams);

  for (const diagram of diagrams) {
    diagram.$parent = definitions;
  }
}

function parseDiagnosticCounts(model: SemanticModel): Map<string, number> {
  const counts = new Map<string, number>();

  for (const diagnostic of model.diagnostics) {
    if (
      diagnostic.code !== "UNRESOLVED_REFERENCE" &&
      diagnostic.code !== "BPMN_PARSE_WARNING"
    ) {
      continue;
    }

    const signature = JSON.stringify([
      diagnostic.code,
      diagnostic.elementRef ?? null,
      diagnostic.property ?? null,
      diagnostic.message
    ]);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }

  return counts;
}

function assertNoIntroducedParseDiagnostics(
  before: SemanticModel,
  after: SemanticModel
): void {
  const baseline = parseDiagnosticCounts(before);
  const introduced = [...parseDiagnosticCounts(after)].filter(
    ([signature, count]) => count > (baseline.get(signature) ?? 0)
  );

  if (introduced.length > 0) {
    throw new EditEngineError(
      "EDIT_VERIFICATION_FAILED",
      "Serialization or layout introduced unresolved references or BPMN parse warnings",
      {
        diagnostics: introduced.map(([signature, count]) => ({
          diagnostic: JSON.parse(signature) as JsonValue,
          count
        }))
      }
    );
  }
}

async function serializeAndVerify(
  model: SemanticModel,
  options: EditOptions,
  loaderOptions: {
    autoProfile: boolean;
    extensions: string[];
    profile?: "zeebe";
    profileDetectionDocuments: readonly string[];
  }
): Promise<{ model: SemanticModel; xml: string }> {
  setDiagrams(model.definitions, []);
  let xml = (await model.moddle.toXML(model.definitions, { format: true })).xml;

  if (options.layout === "auto") {
    let laidOutXml: string;

    try {
      laidOutXml = await layoutProcess(xml);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof LayoutError
        ? "LAYOUT_UNSUPPORTED"
        : "LAYOUT_FAILED";
      throw new EditEngineError(code, `Unable to layout edited BPMN: ${message}`);
    }

    const laidOut = await loadSemanticModelFromDocument(
      {
        bytes: Buffer.from(laidOutXml),
        path: options.file,
        xml: laidOutXml
      },
      loaderOptions
    );
    const diagrams = laidOut.definitions.get("diagrams");
    setDiagrams(
      model.definitions,
      Array.isArray(diagrams) ? diagrams as ModdleElement[] : []
    );
    xml = (await model.moddle.toXML(model.definitions, { format: true })).xml;
  }

  const document: SourceDocument = {
    bytes: Buffer.from(xml),
    path: options.output ?? options.file,
    xml
  };
  const reloaded = await loadSemanticModelFromDocument(document, loaderOptions);

  if (reloaded.semanticHash !== model.semanticHash) {
    throw new EditEngineError(
      "EDIT_VERIFICATION_FAILED",
      "Serialization or layout changed the previewed BPMN semantics"
    );
  }

  assertNoIntroducedParseDiagnostics(model, reloaded);
  return { model: reloaded, xml };
}

async function createPlan(
  source: SourceDocument,
  request: EditRequest,
  options: EditOptions
): Promise<EditPlan> {
  const requestCanonical = canonicalJson(request);
  const requestSha256 = sha256(requestCanonical);
  const loaderOptions = {
    autoProfile: options.autoProfile,
    extensions: options.extensions,
    profile: options.profile,
    profileDetectionDocuments: [source.xml]
  };
  const [before, editable] = await Promise.all([
    loadSemanticModelFromDocument(source, loaderOptions),
    loadSemanticModelFromDocument(source, loaderOptions)
  ]);
  const edited = applyEditRequest(editable, request, requestSha256);
  editable.semanticHash = semanticHash(editable.definitions);
  const verified = await serializeAndVerify(editable, options, loaderOptions);
  const changes = semanticChanges(before, verified.model);
  if (before.semanticHash === verified.model.semanticHash) {
    throw new EditEngineError(
      "EDIT_TRANSACTION_NOOP",
      "The edit request does not change BPMN business semantics"
    );
  }

  const profiles = profileRecords(verified.model.profiles);
  const canonicalRecord: JsonObject = {
    contract: "bpmn-cli/edit-plan@1",
    sourceSha256: before.source.sha256,
    requestSha256,
    request: request as unknown as JsonObject,
    profiles,
    editEngine: {
      name: "bpmn-cli-edit",
      version: packageManifest.version
    },
    layout: {
      mode: options.layout,
      engine: options.layout === "auto"
        ? engines.autoLayout
        : null
    },
    operations: edited.operations,
    beforeSemanticHash: before.semanticHash,
    afterSemanticHash: verified.model.semanticHash,
    changes
  };
  const planHash = sha256(canonicalJson(canonicalRecord));
  const envelope: JsonObject = {
    schemaVersion: "1",
    view: writesBpmn(options) ? "edit-apply" : "edit-preview",
    status: writesBpmn(options) ? "verified" : "preview",
    planHash,
    sourceSha256: before.source.sha256,
    requestSha256,
    beforeSemanticHash: before.semanticHash,
    afterSemanticHash: verified.model.semanticHash,
    layout: options.layout,
    profiles,
    operations: edited.operations,
    changes
  };

  return { envelope, finalXml: verified.xml, planHash };
}

function renderText(envelope: JsonObject): string {
  const changes = envelope.changes as JsonObject;
  const count = (key: string): number =>
    (changes[key] as JsonValue[]).length;

  return `bpmn-cli edit

Status: ${String(envelope.status)}
Plan hash: ${String(envelope.planHash)}
Added: ${count("added")}
Removed: ${count("removed")}
Changed elements: ${count("changed")}
Layout: ${String(envelope.layout)}
`;
}

export async function executeEdit(
  args: readonly string[]
): Promise<EditCommandResult> {
  const parsed = parseEditOptions(args);

  if (parsed === "help") {
    return { exitCode: 0, output: editHelpText, stream: "stdout" };
  }

  if (parsed === "schema") {
    return {
      exitCode: 0,
      output: `${JSON.stringify(getEditRequestSchema(), null, 2)}\n`,
      stream: "stdout"
    };
  }

  if ("exitCode" in parsed) {
    return parsed;
  }

  const options = parsed;

  try {
    const [source, request] = await Promise.all([
      readSourceDocument(options.file),
      readRequest(options.request)
    ]);
    const plan = await createPlan(source, request, options);

    if (
      options.apply !== undefined &&
      options.apply !== plan.planHash
    ) {
      return errorResult(
        1,
        "STALE_PLAN",
        "The supplied plan hash does not match the current source, request, profiles, layout mode, or edit result",
        options.json
      );
    }

    if (writesBpmn(options)) {
      plan.envelope.destination = options.output ?? options.file;
      plan.envelope.status = "written";
      plan.envelope.outputSha256 = sha256(plan.finalXml);
    }

    const output = options.json
      ? `${JSON.stringify(plan.envelope)}\n`
      : renderText(plan.envelope);

    if (
      options.report === undefined &&
      Buffer.byteLength(output) > editLimits.maxStdoutBytes
    ) {
      return errorResult(
        1,
        "OUTPUT_TOO_LARGE",
        `Edit output exceeds ${editLimits.maxStdoutBytes} bytes; use --report`,
        options.json
      );
    }

    let bpmnPublication: BpmnPublication | undefined;

    if (writesBpmn(options)) {
      try {
        if (options.output === undefined) {
          await replaceSourceFile(options.file, plan.finalXml);
        } else {
          await writeOutputFile(
            options.output,
            plan.finalXml,
            options.force,
            options.file
          );
        }
        bpmnPublication = {
          destination: options.output ?? options.file,
          outputSha256: sha256(plan.finalXml),
          status: "written"
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(
          2,
          "OUTPUT_WRITE_FAILED",
          `Unable to publish edited BPMN: ${message}`,
          options.json
        );
      }
    }

    if (options.report !== undefined) {
      try {
        await writeOutputFile(
          options.report,
          `${JSON.stringify(plan.envelope, null, 2)}\n`,
          options.force,
          [options.file, options.request, ...(options.output === undefined
            ? []
            : [options.output])]
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const publication = bpmnPublication === undefined
          ? undefined
          : {
              bpmn: bpmnPublication,
              report: { status: "failed" as const }
            };
        return errorResult(
          2,
          "REPORT_WRITE_FAILED",
          bpmnPublication === undefined
            ? `Unable to write edit report: ${message}`
            : `Edited BPMN was written to "${bpmnPublication.destination}", but the edit report could not be written: ${message}`,
          options.json,
          { publication }
        );
      }
    }

    return {
      exitCode: 0,
      output: options.report === undefined ? output : "",
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

    if (error instanceof EditRequestError) {
      return errorResult(
        1,
        error.code,
        error.message,
        options.json,
        { details: error.details }
      );
    }

    if (error instanceof EditEngineError) {
      return errorResult(
        1,
        error.code,
        error.message,
        options.json,
        { details: error.details }
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      1,
      "EDIT_FAILED",
      `Unable to edit BPMN: ${message}`,
      options.json
    );
  }
}
