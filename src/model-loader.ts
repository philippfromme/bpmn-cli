import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BpmnModdle } from "bpmn-moddle";

import {
  ProfileError,
  resolveProfiles,
  type ActiveProfile,
  type ModdlePackageDescriptor
} from "./profiles.js";
import {
  createSemanticModel,
  type SemanticModel
} from "./semantic.js";

export interface ModelLoadOptions {
  additionalPackages?: Readonly<
    Record<string, ModdlePackageDescriptor>
  >;
  additionalProfiles?: readonly ActiveProfile[];
  autoProfile: boolean;
  extensions: readonly string[];
  file: string;
  profileDetectionDocuments?: readonly string[];
  profile?: "zeebe";
}

export interface SourceDocument {
  bytes: Buffer;
  path: string;
  xml: string;
}

export class ModelLoadError extends Error {
  constructor(
    readonly exitCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export async function readSourceDocument(
  file: string
): Promise<SourceDocument> {
  let source: Buffer;

  try {
    source = await readFile(resolve(file));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelLoadError(
      2,
      "SOURCE_READ_FAILED",
      `Unable to read BPMN file "${file}": ${message}`
    );
  }

  let xml: string;

  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelLoadError(
      2,
      "SOURCE_DECODE_FAILED",
      `Unable to decode BPMN file "${file}" as UTF-8: ${message}`
    );
  }

  return { bytes: source, path: file, xml };
}

export async function loadSemanticModelFromDocument(
  document: SourceDocument,
  options: Omit<ModelLoadOptions, "file">
): Promise<SemanticModel> {
  let profiles;

  try {
    profiles = await resolveProfiles({
      autoProfile: options.autoProfile,
      documents: options.profileDetectionDocuments ?? [document.xml],
      extensions: options.extensions,
      profile: options.profile
    });
  } catch (error) {
    if (error instanceof ProfileError) {
      throw new ModelLoadError(error.exitCode, "PROFILE_ERROR", error.message);
    }

    throw error;
  }

  try {
    const configuredPackages = Object.entries(
      options.additionalPackages ?? {}
    );
    const conflictingPackage = configuredPackages.find(
      ([name, descriptor]) =>
        name in profiles.packages ||
        Object.values(profiles.packages).some(
          (active) =>
            active.prefix === descriptor.prefix ||
            active.uri === descriptor.uri
        )
    );

    if (conflictingPackage !== undefined) {
      throw new ModelLoadError(
        1,
        "PROFILE_ERROR",
        `Moddle package "${conflictingPackage[0]}" collides with an active profile or extension`
      );
    }

    const packages = {
      ...profiles.packages,
      ...(options.additionalPackages ?? {})
    };
    const moddle = new BpmnModdle(packages);
    const parsedBpmn = await moddle.fromXML(document.xml);

    return createSemanticModel({
      definitions: parsedBpmn.rootElement,
      disabledZeebe: profiles.declaresDisabledZeebe,
      moddle,
      parseWarnings: parsedBpmn.warnings,
      profiles: [
        ...profiles.active,
        ...(options.additionalProfiles ?? [])
      ],
      sourceBytes: document.bytes,
      sourcePath: document.path
    });
  } catch (error) {
    if (error instanceof ModelLoadError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ModelLoadError(
      3,
      "BPMN_PARSE_FAILED",
      `Unable to parse BPMN file "${document.path}": ${message}`
    );
  }
}

export async function loadSemanticModel(
  options: ModelLoadOptions
): Promise<SemanticModel> {
  const document = await readSourceDocument(options.file);
  return loadSemanticModelFromDocument(document, options);
}
