declare module "bpmn-auto-layout" {
  export class LayoutError extends Error {}

  export function layoutProcess(xml: string): Promise<string>;
}

declare module "bpmn-js-differ" {
  import type { ModdleElement } from "bpmn-moddle";

  export interface Change {
    element?: ModdleElement;
    index?: number;
    newValue: unknown;
    oldValue: unknown;
    path?: Array<number | string>;
  }

  export interface ChangedElement {
    attrs: Record<string, Change>;
    changes: Change[];
    model: ModdleElement;
  }

  export interface DiffResult {
    _added: Record<string, ModdleElement>;
    _changed: Record<string, ChangedElement>;
    _layoutChanged: Record<string, ModdleElement>;
    _removed: Record<string, ModdleElement>;
  }

  export function diff(
    before: ModdleElement,
    after: ModdleElement
  ): DiffResult;
}

declare module "bpmnlint" {
  import type { ModdleElement } from "bpmn-moddle";

  export interface LintReport {
    category: "error" | "warn";
    id?: string;
    message: string;
    path?: Array<number | string>;
  }

  export class Linter {
    constructor(options: {
      config: Record<string, unknown>;
      resolver: unknown;
    });

    lint(
      definitions: ModdleElement
    ): Promise<Record<string, LintReport[]>>;
  }
}

declare module "bpmnlint/lib/resolver/node-resolver.js" {
  export default class NodeResolver {
    constructor(options?: {
      require?: NodeRequire;
      requireLocal?: NodeRequire;
    });
  }
}
