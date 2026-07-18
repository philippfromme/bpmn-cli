import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BpmnModdle } from "bpmn-moddle";

import {
  ProfileError,
  resolveProfiles
} from "./profiles.js";
import {
  createSemanticModel,
  type SemanticModel
} from "./semantic.js";

export interface ModelLoadOptions {
  autoProfile: boolean;
  extensions: readonly string[];
  file: string;
  profile?: "zeebe";
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

export async function loadSemanticModel(
  options: ModelLoadOptions
): Promise<SemanticModel> {
  let source: Buffer;

  try {
    source = await readFile(resolve(options.file));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelLoadError(
      2,
      "SOURCE_READ_FAILED",
      `Unable to read BPMN file "${options.file}": ${message}`
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
      `Unable to decode BPMN file "${options.file}" as UTF-8: ${message}`
    );
  }

  let profiles;

  try {
    profiles = await resolveProfiles({
      autoProfile: options.autoProfile,
      extensions: options.extensions,
      profile: options.profile,
      xml
    });
  } catch (error) {
    if (error instanceof ProfileError) {
      throw new ModelLoadError(error.exitCode, "PROFILE_ERROR", error.message);
    }

    throw error;
  }

  try {
    const moddle = new BpmnModdle(profiles.packages);
    const parsedBpmn = await moddle.fromXML(xml);

    return createSemanticModel({
      definitions: parsedBpmn.rootElement,
      disabledZeebe: profiles.declaresDisabledZeebe,
      parseWarnings: parsedBpmn.warnings,
      profiles: profiles.active,
      sourceBytes: source,
      sourcePath: options.file
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelLoadError(
      3,
      "BPMN_PARSE_FAILED",
      `Unable to parse BPMN file "${options.file}": ${message}`
    );
  }
}
