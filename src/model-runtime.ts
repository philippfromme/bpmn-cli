import { createHash } from "node:crypto";

import type { ModdleElement } from "bpmn-moddle";

import {
  loadSemanticModelFromDocument,
  type ModelLoadOptions,
  type SourceDocument
} from "./model-loader.js";
import { replaceSourceFile, writeOutputFile } from "./output.js";
import { projectElement, semanticHash, type JsonObject } from "./project.js";
import type { SemanticModel } from "./semantic.js";

export interface ModelRuntimeOptions {
  autoProfile?: boolean;
  extensions?: readonly string[];
  profile?: "zeebe";
}

export interface PublishOptions {
  force?: boolean;
  layout?: "auto" | "none";
  output?: string;
  validate?: boolean;
}

export interface PublicationResult {
  changes: JsonObject;
  destination?: string;
  layout: "auto" | "none";
  outputSha256: string;
  semanticHash: string;
  status: "verified" | "written";
}

export class ModelPublicationError extends Error {
  constructor(
    readonly code:
      | "LAYOUT_FAILED"
      | "LAYOUT_UNSUPPORTED"
      | "MODEL_VERIFICATION_FAILED"
      | "OUTPUT_WRITE_FAILED"
      | "UNSUPPORTED_EXTENSION_DATA",
    message: string
  ) {
    super(message);
  }
}

function setDiagrams(
  definitions: ModdleElement,
  diagrams: readonly ModdleElement[]
): void {
  definitions.set("diagrams", [...diagrams]);

  for (const diagram of diagrams) {
    diagram.$parent = definitions;
  }
}

function loaderOptions(
  options: ModelRuntimeOptions,
  sourceXml: string
): Omit<ModelLoadOptions, "file"> {
  return {
    autoProfile: options.autoProfile ?? true,
    extensions: [...(options.extensions ?? [])],
    profile: options.profile,
    profileDetectionDocuments: [sourceXml]
  };
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
    throw new ModelPublicationError(
      "MODEL_VERIFICATION_FAILED",
      "Serialization or layout introduced unresolved references or BPMN parse warnings"
    );
  }
}

function assertSupportedExtensionData(model: SemanticModel): void {
  const unsupported = model.diagnostics.find(
    (diagnostic) => diagnostic.code === "UNSUPPORTED_EXTENSION_DATA"
  );

  if (unsupported !== undefined) {
    throw new ModelPublicationError(
      "UNSUPPORTED_EXTENSION_DATA",
      `${unsupported.message}; load its moddle descriptor before publishing`
    );
  }
}

function publicationChanges(
  before: SemanticModel,
  after: SemanticModel
): JsonObject {
  const beforeById = new Map(
    before.allElements.flatMap((element) =>
      element.id === undefined ? [] : [[element.id, element] as const]
    )
  );
  const afterById = new Map(
    after.allElements.flatMap((element) =>
      element.id === undefined ? [] : [[element.id, element] as const]
    )
  );
  const added = [...afterById]
    .filter(([id]) => !beforeById.has(id))
    .map(([, element]) => ({ element: projectElement(element).value }));
  const removed = [...beforeById]
    .filter(([id]) => !afterById.has(id))
    .map(([, element]) => ({ element: projectElement(element).value }));
  const changed = [...afterById]
    .flatMap(([id, element]) => {
      const previous = beforeById.get(id);
      if (
        previous === undefined ||
        JSON.stringify(projectElement(previous).value) ===
          JSON.stringify(projectElement(element).value)
      ) {
        return [];
      }

      return [{
        $type: element.$type,
        after: projectElement(element).value,
        before: projectElement(previous).value,
        elementRef: id
      }];
    });

  return { added, changed, removed };
}

export async function serializeAndVerifyModel(
  before: SemanticModel,
  editable: SemanticModel,
  source: SourceDocument,
  runtimeOptions: ModelRuntimeOptions,
  options: PublishOptions = {}
): Promise<{ model: SemanticModel; xml: string }> {
  const layout = options.layout ?? "auto";
  assertSupportedExtensionData(before);
  assertSupportedExtensionData(editable);
  const expectedSemanticHash = semanticHash(editable.definitions);
  setDiagrams(editable.definitions, []);
  let xml = (await editable.moddle.toXML(editable.definitions, { format: true })).xml;

  if (layout === "auto") {
    let laidOutXml: string;

    try {
      const { layoutProcess } = await import("bpmn-auto-layout");
      laidOutXml = await layoutProcess(xml);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelPublicationError(
        error instanceof Error && error.name === "LayoutError"
          ? "LAYOUT_UNSUPPORTED"
          : "LAYOUT_FAILED",
        `Unable to layout BPMN: ${message}`
      );
    }

    const laidOut = await loadSemanticModelFromDocument(
      {
        bytes: Buffer.from(laidOutXml),
        path: source.path,
        xml: laidOutXml
      },
      loaderOptions(runtimeOptions, source.xml)
    );
    const diagrams = laidOut.definitions.get("diagrams");
    setDiagrams(
      editable.definitions,
      Array.isArray(diagrams) ? diagrams as ModdleElement[] : []
    );
    xml = (await editable.moddle.toXML(editable.definitions, { format: true })).xml;
  }

  const reloaded = await loadSemanticModelFromDocument(
    {
      bytes: Buffer.from(xml),
      path: options.output ?? source.path,
      xml
    },
    loaderOptions(runtimeOptions, source.xml)
  );

  if (reloaded.semanticHash !== expectedSemanticHash) {
    throw new ModelPublicationError(
      "MODEL_VERIFICATION_FAILED",
      "Serialization or layout changed the intended BPMN business semantics"
    );
  }

  if (options.validate ?? true) {
    assertNoIntroducedParseDiagnostics(before, reloaded);
  }

  return { model: reloaded, xml };
}

export async function publishModel(
  before: SemanticModel,
  editable: SemanticModel,
  source: SourceDocument,
  runtimeOptions: ModelRuntimeOptions,
  options: PublishOptions = {}
): Promise<PublicationResult> {
  const verified = await serializeAndVerifyModel(
    before,
    editable,
    source,
    runtimeOptions,
    options
  );
  const outputSha256 = createHash("sha256").update(verified.xml).digest("hex");
  const layout = options.layout ?? "auto";

  if (options.output === undefined) {
    await replaceSourceFile(source.path, verified.xml);
    return {
      changes: publicationChanges(before, verified.model),
      destination: source.path,
      layout,
      outputSha256,
      semanticHash: verified.model.semanticHash,
      status: "written"
    };
  }

  try {
    await writeOutputFile(
      options.output,
      verified.xml,
      options.force ?? false,
      source.path
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelPublicationError(
      "OUTPUT_WRITE_FAILED",
      `Unable to publish BPMN: ${message}`
    );
  }

  return {
    changes: publicationChanges(before, verified.model),
    destination: options.output,
    layout,
    outputSha256,
    semanticHash: verified.model.semanticHash,
    status: "written"
  };
}
