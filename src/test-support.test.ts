import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModdleElement } from "bpmn-moddle";

export const BPMN_NAMESPACE = "http://www.omg.org/spec/BPMN/20100524/MODEL";
export const ZEEBE_NAMESPACE = "http://camunda.org/schema/zeebe/1.0";

export async function withTemporaryDirectory(
  prefix: string,
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));

  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function writeBpmn(
  directory: string,
  name: string,
  body: string,
  namespaces = ""
): Promise<string> {
  const path = join(directory, name);
  await writeFile(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="${BPMN_NAMESPACE}"${namespaces}
  id="Definitions_1" targetNamespace="https://example.test">
${body}
</bpmn:definitions>`,
    "utf8"
  );
  return path;
}

export function expectModelError(
  expectedCode: string,
  operation: () => void
): void {
  assert.throws(
    operation,
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === expectedCode
  );
}

export function isModdleElement(value: unknown): value is ModdleElement {
  return typeof value === "object" && value !== null && "$type" in value;
}

export function moddleElements(value: unknown): ModdleElement[] {
  return Array.isArray(value) ? value.filter(isModdleElement) : [];
}
