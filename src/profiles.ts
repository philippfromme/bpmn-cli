import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const zeebeDescriptor = require(
  "zeebe-bpmn-moddle/resources/zeebe.json"
) as ModdlePackageDescriptor;
const zeebePackage = require("zeebe-bpmn-moddle/package.json") as {
  version: string;
};

export const ZEEBE_NAMESPACE = "http://camunda.org/schema/zeebe/1.0";

export interface ModdlePackageDescriptor {
  name: string;
  prefix: string;
  uri: string;
  types: unknown[];
  [key: string]: unknown;
}

const RESERVED_NAMESPACES = [
  {
    name: "BPMN20",
    prefix: "bpmn",
    uri: "http://www.omg.org/spec/BPMN/20100524/MODEL"
  },
  {
    name: "BPMNDI",
    prefix: "bpmndi",
    uri: "http://www.omg.org/spec/BPMN/20100524/DI"
  },
  {
    name: "DC",
    prefix: "dc",
    uri: "http://www.omg.org/spec/DD/20100524/DC"
  },
  {
    name: "DI",
    prefix: "di",
    uri: "http://www.omg.org/spec/DD/20100524/DI"
  }
] as const;

export interface ActiveProfile {
  name: string;
  namespace: string;
  package?: string;
  packageVersion?: string;
  path?: string;
  source: "detected" | "explicit" | "file";
}

export interface ResolveProfilesOptions {
  autoProfile: boolean;
  extensions: readonly string[];
  profile?: "zeebe";
  xml: string;
}

export interface ResolvedProfiles {
  active: ActiveProfile[];
  declaresDisabledZeebe: boolean;
  packages: Record<string, ModdlePackageDescriptor>;
}

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3
  ) {
    super(message);
  }
}

export function declaresNamespace(xml: string, namespace: string): boolean {
  const withoutComments = xml.replaceAll(/<!--[\s\S]*?-->/g, "");
  const definitions = withoutComments.match(
    /<(?:[A-Za-z_][\w.-]*:)?definitions\b[^>]*>/i
  )?.[0];

  if (definitions === undefined) {
    return false;
  }

  const namespaceDeclaration =
    /\sxmlns(?::[A-Za-z_][\w.-]*)?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  for (const match of definitions.matchAll(namespaceDeclaration)) {
    if ((match[1] ?? match[2]) === namespace) {
      return true;
    }
  }

  return false;
}

function validateDescriptor(
  descriptor: unknown,
  source: string
): asserts descriptor is ModdlePackageDescriptor {
  if (
    typeof descriptor !== "object" ||
    descriptor === null ||
    typeof (descriptor as Record<string, unknown>).name !== "string" ||
    typeof (descriptor as Record<string, unknown>).prefix !== "string" ||
    typeof (descriptor as Record<string, unknown>).uri !== "string" ||
    !Array.isArray((descriptor as Record<string, unknown>).types)
  ) {
    throw new ProfileError(
      `Invalid moddle descriptor "${source}": expected name, prefix, uri, and types`,
      3
    );
  }

  const types = (descriptor as Record<string, unknown>).types as unknown[];
  const typeNames = new Set<string>();

  for (const type of types) {
    if (
      typeof type !== "object" ||
      type === null ||
      typeof (type as Record<string, unknown>).name !== "string" ||
      ("properties" in type &&
        !Array.isArray((type as Record<string, unknown>).properties))
    ) {
      throw new ProfileError(
        `Invalid moddle descriptor "${source}": every type requires a name and an optional properties array`,
        3
      );
    }

    const typeName = (type as Record<string, unknown>).name as string;

    if (typeNames.has(typeName)) {
      throw new ProfileError(
        `Invalid moddle descriptor "${source}": duplicate type "${typeName}"`,
        3
      );
    }

    typeNames.add(typeName);
    const properties = (type as Record<string, unknown>).properties;

    if (Array.isArray(properties)) {
      const propertyNames = new Set<string>();

      for (const property of properties) {
        if (
          typeof property !== "object" ||
          property === null ||
          typeof (property as Record<string, unknown>).name !== "string" ||
          typeof (property as Record<string, unknown>).type !== "string"
        ) {
          throw new ProfileError(
            `Invalid moddle descriptor "${source}": every property requires name and type`,
            3
          );
        }

        const propertyName = (property as Record<string, unknown>).name as string;

        if (propertyNames.has(propertyName)) {
          throw new ProfileError(
            `Invalid moddle descriptor "${source}": duplicate property "${typeName}.${propertyName}"`,
            3
          );
        }

        propertyNames.add(propertyName);
      }
    }
  }
}

function assertNoNamespaceCollision(
  descriptor: ModdlePackageDescriptor,
  existing: readonly ModdlePackageDescriptor[],
  source: string
): void {
  const collision = [...RESERVED_NAMESPACES, ...existing].find(
    (candidate) =>
      candidate.name === descriptor.name ||
      candidate.prefix === descriptor.prefix ||
      candidate.uri === descriptor.uri
  );

  if (collision !== undefined) {
    throw new ProfileError(
      `Moddle descriptor "${source}" collides with namespace "${collision.prefix}"`,
      3
    );
  }
}

async function loadExtension(
  specification: string
): Promise<{
  descriptor: ModdlePackageDescriptor;
  name: string;
  path: string;
}> {
  const separator = specification.indexOf("=");

  if (separator <= 0 || separator === specification.length - 1) {
    throw new ProfileError(
      `Invalid extension "${specification}": expected <name>=<descriptor.json>`,
      1
    );
  }

  const name = specification.slice(0, separator);
  const path = resolve(specification.slice(separator + 1));
  let contents: string;

  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProfileError(
      `Unable to read moddle descriptor "${path}": ${message}`,
      2
    );
  }

  let descriptor: unknown;

  try {
    descriptor = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProfileError(
      `Invalid JSON in moddle descriptor "${path}": ${message}`,
      3
    );
  }

  validateDescriptor(descriptor, path);

  return { descriptor, name, path };
}

export async function resolveProfiles(
  options: ResolveProfilesOptions
): Promise<ResolvedProfiles> {
  const packages: Record<string, ModdlePackageDescriptor> = {};
  const active: ActiveProfile[] = [];
  const declaresZeebe = declaresNamespace(options.xml, ZEEBE_NAMESPACE);
  const zeebeSource =
    options.profile === "zeebe"
      ? "explicit"
      : options.autoProfile && declaresZeebe
        ? "detected"
        : undefined;

  if (zeebeSource !== undefined) {
    packages.zeebe = zeebeDescriptor;
    active.push({
      name: "zeebe",
      namespace: ZEEBE_NAMESPACE,
      package: "zeebe-bpmn-moddle",
      packageVersion: zeebePackage.version,
      source: zeebeSource
    });
  }

  for (const specification of options.extensions) {
    const extension = await loadExtension(specification);

    if (packages[extension.name] !== undefined) {
      throw new ProfileError(
        `Duplicate moddle extension name: ${extension.name}`,
        3
      );
    }

    assertNoNamespaceCollision(
      extension.descriptor,
      Object.values(packages),
      extension.path
    );

    packages[extension.name] = extension.descriptor;
    active.push({
      name: extension.name,
      namespace: extension.descriptor.uri,
      path: extension.path,
      source: "file"
    });
  }

  return {
    active,
    declaresDisabledZeebe: declaresZeebe && zeebeSource === undefined,
    packages
  };
}
