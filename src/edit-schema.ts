import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction
} from "ajv/dist/2020.js";

import type { JsonObject, JsonValue } from "./project.js";

export type EditOperation = AddOperation | MoveOperation | RemoveOperation | ReplaceOperation;

export interface EditRequest {
  operations: EditOperation[];
  schemaVersion: "1";
}

export interface Expectation {
  absent?: true;
  equals?: JsonValue;
  length?: number;
  path: string;
  target: string;
}

interface OperationBase {
  expect: Expectation[];
}

export interface AddOperation extends OperationBase {
  as?: string;
  op: "add";
  path: string;
  target: string;
  value: JsonValue;
}

export interface RemoveOperation extends OperationBase {
  op: "remove";
  path: string;
  target: string;
}

export interface ReplaceOperation extends OperationBase {
  as?: string;
  op: "replace";
  path: string;
  target: string;
  value: JsonValue;
}

export interface EditAddress {
  path: string;
  target: string;
}

export interface MoveOperation extends OperationBase {
  from: EditAddress;
  op: "move";
  to: EditAddress;
}

export class EditRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: JsonValue[] = []
  ) {
    super(message);
  }
}

const schemaPath = fileURLToPath(
  new URL("../schema/edit-request-v1.schema.json", import.meta.url)
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as JsonObject;
const ajv = new Ajv2020({
  allErrors: true,
  strict: true
});
const validate = ajv.compile(schema) as ValidateFunction<EditRequest>;

function errorDetails(errors: ErrorObject[] | null | undefined): JsonValue[] {
  return (errors ?? []).map(
    ({ instancePath, keyword, message, params }) =>
      ({
        instancePath,
        keyword,
        message: message ?? "schema validation failed",
        params: params as unknown as JsonObject
      }) as JsonObject
  );
}

export function getEditRequestSchema(): JsonObject {
  return structuredClone(schema);
}

export function validateEditRequest(value: unknown): EditRequest {
  if (!validate(value)) {
    throw new EditRequestError(
      "EDIT_REQUEST_SCHEMA_INVALID",
      "Edit request does not match schemaVersion 1",
      errorDetails(validate.errors)
    );
  }

  return value;
}
