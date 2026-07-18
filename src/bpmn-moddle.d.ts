declare module "bpmn-moddle" {
  export interface ModdleNamespace {
    localName?: string;
    name: string;
    prefix?: string;
  }

  export interface ModdlePropertyDescriptor {
    default?: unknown;
    inherited?: boolean;
    isAttr?: boolean;
    isId?: boolean;
    isMany?: boolean;
    isReference?: boolean;
    name: string;
    ns?: ModdleNamespace;
    type: string;
  }

  export interface ModdleDescriptor {
    isGeneric?: boolean;
    name: string;
    ns: ModdleNamespace;
    properties: ModdlePropertyDescriptor[];
  }

  export interface ModdleElement {
    $attrs?: Record<string, string>;
    $descriptor: ModdleDescriptor;
    $parent?: ModdleElement;
    $type: string;
    $instanceOf(type: string): boolean;
    get(name: string): unknown;
    id?: string;
    name?: string;
    incoming?: ModdleElement[];
    outgoing?: ModdleElement[];
    rootElements?: ModdleElement[];
    flowElements?: ModdleElement[];
    artifacts?: ModdleElement[];
    extensionElements?: ModdleElement;
    values?: ModdleElement[];
  }

  export interface Definitions extends ModdleElement {
    exporter?: string;
    exporterVersion?: string;
    rootElements: ModdleElement[];
    targetNamespace?: string;
  }

  export interface ParseResult {
    rootElement: Definitions;
    warnings: ModdleParseWarning[];
    elementsById: Record<string, ModdleElement>;
  }

  export interface ModdleParseWarning {
    element?: ModdleElement;
    error?: Error;
    message: string;
    property?: string;
    value?: unknown;
  }

  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>);
    fromXML(xml: string): Promise<ParseResult>;
  }
}
