import { BpmnModdle, type ModdleElement } from "bpmn-moddle";
import type { ModdleElement as DescriptorModdleElement } from "moddle";

import {
  loadSemanticModelFromDocument,
  readSourceDocument,
  type SourceDocument
} from "./model-loader.js";
import {
  publishModel,
  type ModelRuntimeOptions,
  type PublicationResult,
  type PublishOptions
} from "./model-runtime.js";
import {
  createElement,
  type ElementProperties,
  type ElementPropertiesInput,
  type SupportedElementType,
  type TypedModdleElement
} from "./model-types.js";
import { typedDescriptorProperties } from "./moddle.js";
import { resolveProfiles } from "./profiles.js";
import { collectSemanticElements, type SemanticModel } from "./semantic.js";

export type OpenModelOptions = ModelRuntimeOptions;

export interface CreateModelOptions extends ModelRuntimeOptions {
  id?: string;
  path?: string;
  targetNamespace?: string;
}

export interface FormConfiguration {
  externalReference?: string;
  formId?: string;
  formKey?: string;
}

export interface IoInput {
  source: string;
  target: string;
}

export type CustomPropertyValue = boolean | number | string;

type ScalarPropertyValue = boolean | number | string;

export type ScalarProperties<Type extends SupportedElementType> = Partial<Pick<
  ElementProperties<Type>,
  {
    [Property in keyof ElementProperties<Type>]:
      Property extends "id"
        ? never
        : NonNullable<ElementProperties<Type>[Property]> extends ScalarPropertyValue
          ? Property
          : never;
  }[keyof ElementProperties<Type>]
>>;

type ReferencePropertyKeys<Properties> = {
  [Property in keyof Properties]:
    Property extends
      | "attachedToRef"
      | "boundaryEventRefs"
      | "incoming"
      | "outgoing"
      | "sourceRef"
      | "targetRef"
      ? never
      : NonNullable<Properties[Property]> extends
          | DescriptorModdleElement<object>
          | readonly DescriptorModdleElement<object>[]
        ? Property
        : never;
}[keyof Properties];

export type ReferenceProperties<Type extends SupportedElementType> = Partial<{
  [Property in ReferencePropertyKeys<ElementProperties<Type>>]:
    NonNullable<ElementProperties<Type>[Property]> extends
      readonly DescriptorModdleElement<object>[]
      ? readonly string[]
      : string;
}>;

export class ModelApiError extends Error {
  constructor(
    readonly code:
      | "ELEMENT_NOT_FOUND"
      | "ELEMENT_ID_CONFLICT"
      | "INVALID_CONTAINMENT"
      | "INVALID_CONNECTION"
      | "INVALID_EXTENSION"
      | "INVALID_FORM"
      | "INVALID_PROPERTY"
      | "ELEMENT_REFERENCED"
      | "FOREIGN_ELEMENT"
      | "OUTPUT_REQUIRED",
    message: string
  ) {
    super(message);
  }
}

function asElements(value: unknown): ModdleElement[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ModdleElement =>
      typeof entry === "object" && entry !== null && "$type" in entry
    )
    : [];
}

function isFlowElementContainer(element: ModdleElement): boolean {
  return element.$instanceOf("bpmn:FlowElementsContainer");
}

function isSequenceFlowEndpoint(element: ModdleElement): boolean {
  return element.$instanceOf("bpmn:FlowNode");
}

function isScalarProperty(property: {
  isMany?: boolean;
  isReference?: boolean;
  type: string;
}): boolean {
  return (
    property.isMany !== true &&
    property.isReference !== true &&
    ["Boolean", "Integer", "Real", "String"].includes(property.type)
  );
}

function isManagedReciprocalReference(property: string): boolean {
  return (
    property === "attachedToRef" ||
    property === "boundaryEventRefs" ||
    property === "incoming" ||
    property === "outgoing" ||
    property === "sourceRef" ||
    property === "targetRef"
  );
}

function hasReference(element: ModdleElement, target: ModdleElement): boolean {
  return typedDescriptorProperties(element)
    .filter((property) => property.isReference)
    .some((property) => {
      const value = element.get(property.name);
      return Array.isArray(value) ? value.includes(target) : value === target;
    });
}

export class IoMappingBuilder {
  constructor(
    private readonly model: BpmnModel,
    readonly raw: TypedModdleElement<"zeebe:IoMapping">
  ) {}

  addInput(input: IoInput): ModelElement<"zeebe:Input"> {
    if (input.source.length === 0 || input.target.length === 0) {
      throw new ModelApiError(
        "INVALID_EXTENSION",
        "Zeebe I/O inputs require non-empty source and target values"
      );
    }

    const parameter = this.model.create("zeebe:Input", input);
    this.model.append(this.raw, parameter, "inputParameters");
    return parameter;
  }
}

export class ExtensionElementsBuilder {
  constructor(
    private readonly model: BpmnModel,
    private readonly owner: ModelElement
  ) {}

  ensure(type: "zeebe:IoMapping"): IoMappingBuilder;
  ensure<Type extends SupportedElementType>(type: Type): ModelElement<Type>;
  ensure<Type extends SupportedElementType>(
    type: Type
  ): IoMappingBuilder | ModelElement<Type> {
    if (type === "zeebe:IoMapping" && !this.supportsIoMapping()) {
      throw new ModelApiError(
        "INVALID_EXTENSION",
        `${this.owner.type} cannot contain zeebe:IoMapping`
      );
    }

    let extensionElements = this.owner.raw.extensionElements;

    if (extensionElements === undefined) {
      extensionElements = this.model.create("bpmn:ExtensionElements", {}).raw;
      this.model.append(this.owner.raw, extensionElements, "extensionElements");
    }

    const existing = asElements(extensionElements.get("values")).find(
      (value) => value.$type === type
    );
    const extension = existing === undefined
      ? this.model.create(type, {} as ElementPropertiesInput<Type>)
      : this.model.wrap(existing as TypedModdleElement<Type>);

    if (existing === undefined) {
      this.model.append(extensionElements, extension, "values");
    }

    return type === "zeebe:IoMapping"
      ? new IoMappingBuilder(
        this.model,
        extension.raw as TypedModdleElement<"zeebe:IoMapping">
      )
      : extension;
  }

  ensureCustom(
    type: string,
    properties: Readonly<Record<string, CustomPropertyValue>> = {}
  ): CustomExtensionElement {
    let extensionElements = this.owner.raw.extensionElements;

    if (extensionElements === undefined) {
      extensionElements = this.model.create("bpmn:ExtensionElements", {}).raw;
      this.model.append(this.owner.raw, extensionElements, "extensionElements");
    }

    const existing = asElements(extensionElements.get("values")).find(
      (value) => value.$type === type
    );
    const extension = existing === undefined
      ? this.model.createCustom(type, properties)
      : new CustomExtensionElement(this.model, existing);

    if (existing === undefined) {
      this.model.append(extensionElements, extension.raw, "values");
    }

    return extension;
  }

  private supportsIoMapping(): boolean {
    const element = this.owner.raw;
    return (
      element.$instanceOf("bpmn:CallActivity") ||
      element.$instanceOf("bpmn:Event") ||
      element.$instanceOf("bpmn:ReceiveTask") ||
      element.$instanceOf("bpmn:SubProcess") ||
      element.$instanceOf("bpmn:UserTask") ||
      element.$instanceOf("zeebe:ZeebeServiceTask")
    );
  }
}

export class CustomExtensionElement {
  constructor(
    private readonly model: BpmnModel,
    readonly raw: ModdleElement
  ) {}

  set(property: string, value: CustomPropertyValue): this {
    this.assertProperty(property);
    this.raw.set(property, value);
    return this;
  }

  append(
    property: string,
    type: string,
    properties: Readonly<Record<string, CustomPropertyValue>> = {}
  ): CustomExtensionElement {
    const child = this.model.createCustom(type, properties);
    this.model.append(this.raw, child.raw, property);
    return child;
  }

  private assertProperty(property: string): void {
    if (!typedDescriptorProperties(this.raw).some(({ name }) => name === property)) {
      throw new ModelApiError(
        "INVALID_EXTENSION",
        `${this.raw.$type}.${property} is not a loaded descriptor property`
      );
    }
  }
}

export class ModelElement<Type extends SupportedElementType = SupportedElementType> {
  readonly extensions: ExtensionElementsBuilder;

  constructor(
    private readonly model: BpmnModel,
    readonly raw: TypedModdleElement<Type>
  ) {
    this.extensions = new ExtensionElementsBuilder(model, this);
  }

  get id(): string {
    if (this.raw.id === undefined) {
      throw new ModelApiError(
        "INVALID_CONTAINMENT",
        `${this.raw.$type} has no BPMN identifier`
      );
    }

    return this.raw.id;
  }

  get type(): Type {
    return this.raw.$type;
  }

  isOwnedBy(model: BpmnModel): boolean {
    return this.model === model;
  }

  get name(): string | undefined {
    return this.raw.name;
  }

  setName(name: string): this {
    this.raw.name = name;
    return this;
  }

  renameId(id: string): this {
    this.model.renameId(this, id);
    return this;
  }

  setProperties(properties: ScalarProperties<Type>): this {
    for (const [property, value] of Object.entries(properties)) {
      const descriptor = typedDescriptorProperties(this.raw).find(
        (candidate) => candidate.name === property
      );
      if (
        property === "id" ||
        descriptor === undefined ||
        !isScalarProperty(descriptor)
      ) {
        throw new ModelApiError(
          "INVALID_PROPERTY",
          `${this.type}.${property} is not an editable scalar property`
        );
      }
      this.raw.set(property, value);
    }
    return this;
  }

  setReferences(references: ReferenceProperties<Type>): this {
    for (const [property, value] of Object.entries(references)) {
      const descriptor = typedDescriptorProperties(this.raw).find(
        (candidate) => candidate.name === property
      );
      if (
        descriptor === undefined ||
        descriptor.isReference !== true ||
        isManagedReciprocalReference(property) ||
        (descriptor.isMany === true) !== Array.isArray(value)
      ) {
        throw new ModelApiError(
          "INVALID_PROPERTY",
          `${this.type}.${property} is not an editable reference property`
        );
      }

      const ids = Array.isArray(value) ? value : [value];
      const targets = ids.map((id) => this.model.element(id).raw);
      const expectedType = descriptor.type.includes(":")
        ? descriptor.type
        : `${this.raw.$descriptor.ns.prefix ?? "bpmn"}:${descriptor.type}`;

      if (!targets.every((target) => target.$instanceOf(expectedType))) {
        throw new ModelApiError(
          "INVALID_PROPERTY",
          `${this.type}.${property} must reference ${expectedType} elements`
        );
      }

      this.raw.set(property, descriptor.isMany === true ? targets : targets[0]);
    }
    return this;
  }

  child<ChildType extends SupportedElementType = SupportedElementType>(
    property: string
  ): ModelElement<ChildType> {
    const descriptor = typedDescriptorProperties(this.raw).find(
      (candidate) => candidate.name === property
    );
    const child = asElements([this.raw.get(property)])[0];
    if (
      descriptor === undefined ||
      descriptor.isReference === true ||
      descriptor.isMany === true ||
      child === undefined
    ) {
      throw new ModelApiError(
        "INVALID_PROPERTY",
        `${this.type}.${property} is not an accessible contained child`
      );
    }
    return this.model.wrap(child as TypedModdleElement<ChildType>);
  }

  children<ChildType extends SupportedElementType = SupportedElementType>(
    property: string
  ): ModelElement<ChildType>[] {
    const descriptor = typedDescriptorProperties(this.raw).find(
      (candidate) => candidate.name === property
    );
    if (
      descriptor === undefined ||
      descriptor.isReference === true ||
      descriptor.isMany !== true
    ) {
      throw new ModelApiError(
        "INVALID_PROPERTY",
        `${this.type}.${property} is not an accessible contained child list`
      );
    }
    return asElements(this.raw.get(property)).map((child) =>
      this.model.wrap(child as TypedModdleElement<ChildType>)
    );
  }

  createChild<ChildType extends SupportedElementType>(
    property: string,
    type: ChildType,
    properties: ElementPropertiesInput<ChildType> & { id?: string }
  ): ModelElement<ChildType> {
    const child = this.model.create(type, properties);
    this.model.append(this, child, property);
    return child;
  }

  removeChild(property: string, child: ModelElement): void {
    const descriptor = typedDescriptorProperties(this.raw).find(
      (candidate) => candidate.name === property
    );
    const value = this.raw.get(property);
    const contains = Array.isArray(value)
      ? value.includes(child.raw)
      : value === child.raw;
    if (
      descriptor === undefined ||
      descriptor.isReference === true ||
      !contains
    ) {
      throw new ModelApiError(
        "INVALID_PROPERTY",
        `${this.type}.${property} does not contain the selected child`
      );
    }
    this.model.remove(child);
  }

  configureForm(configuration: FormConfiguration): this {
    if (!this.raw.$instanceOf("bpmn:UserTask")) {
      throw new ModelApiError(
        "INVALID_FORM",
        "Native Zeebe form configuration is only supported on bpmn:UserTask"
      );
    }

    const form = this.extensions.ensure("zeebe:FormDefinition");
    for (const [property, value] of Object.entries(configuration)) {
      if (value !== undefined) {
        form.raw.set(property, value);
      }
    }
    return this;
  }
}

export class BpmnModel {
  private readonly ids = new Set<string>();
  private readonly elementsById = new Map<string, ModdleElement>();
  private readonly ownedElements = new Set<ModdleElement>();

  private constructor(
    private readonly baseline: SemanticModel,
    private readonly editable: SemanticModel,
    private readonly source: SourceDocument,
    private readonly runtimeOptions: ModelRuntimeOptions,
    private readonly isMemoryModel: boolean
  ) {
    this.refreshIndexes();
  }

  static async open(
    file: string,
    options: OpenModelOptions = {}
  ): Promise<BpmnModel> {
    const source = await readSourceDocument(file);
    const loaderOptions = {
      autoProfile: options.autoProfile ?? true,
      extensions: [...(options.extensions ?? [])],
      profile: options.profile
    };
    const [baseline, editable] = await Promise.all([
      loadSemanticModelFromDocument(source, loaderOptions),
      loadSemanticModelFromDocument(source, loaderOptions)
    ]);
    return new BpmnModel(baseline, editable, source, options, false);
  }

  static async create(
    options: CreateModelOptions = {}
  ): Promise<BpmnModel> {
    const profile = options.profile ?? "zeebe";
    const runtimeOptions: ModelRuntimeOptions = {
      autoProfile: options.autoProfile ?? false,
      extensions: options.extensions,
      profile
    };
    const profiles = await resolveProfiles({
      autoProfile: runtimeOptions.autoProfile ?? false,
      documents: [],
      extensions: [...(runtimeOptions.extensions ?? [])],
      profile
    });
    const moddle = new BpmnModdle(profiles.packages);
    const definitions = moddle.create("bpmn:Definitions", {
      id: options.id ?? "Definitions_1",
      rootElements: [],
      targetNamespace: options.targetNamespace ?? "http://bpmn.io/schema/bpmn"
    });
    const xml = (await moddle.toXML(definitions, { format: true })).xml;
    const source: SourceDocument = {
      bytes: Buffer.from(xml),
      path: options.path ?? "<memory>",
      xml
    };
    const loaderOptions = {
      autoProfile: runtimeOptions.autoProfile ?? false,
      extensions: [...(runtimeOptions.extensions ?? [])],
      profile
    };
    const [baseline, editable] = await Promise.all([
      loadSemanticModelFromDocument(source, loaderOptions),
      loadSemanticModelFromDocument(source, loaderOptions)
    ]);
    return new BpmnModel(
      baseline,
      editable,
      source,
      runtimeOptions,
      options.path === undefined
    );
  }

  element<Type extends SupportedElementType = SupportedElementType>(
    id: string
  ): ModelElement<Type> {
    const element = this.elementsById.get(id);

    if (element === undefined) {
      throw new ModelApiError("ELEMENT_NOT_FOUND", `No BPMN element has ID "${id}"`);
    }

    return this.wrap(element as TypedModdleElement<Type>);
  }

  create<Type extends SupportedElementType>(
    type: Type,
    properties: ElementPropertiesInput<Type> & { id?: string }
  ): ModelElement<Type> {
    const requestedId = properties.id;
    if (requestedId !== undefined && this.ids.has(requestedId)) {
      throw new ModelApiError(
        "ELEMENT_ID_CONFLICT",
        `BPMN element ID "${requestedId}" already exists`
      );
    }

    const raw = createElement(
      this.editable.moddle,
      type,
      properties
    );
    if (raw.$instanceOf("bpmn:BaseElement")) {
      raw.id = requestedId ?? this.allocateId(type);
      this.ids.add(raw.id);
    }
    this.ownedElements.add(raw);

    return this.wrap(raw);
  }

  createCustom(
    type: string,
    properties: Readonly<Record<string, CustomPropertyValue>> = {}
  ): CustomExtensionElement {
    let raw: ModdleElement;

    try {
      raw = this.editable.moddle.create(type, { ...properties });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("unknown type <")) {
        throw new ModelApiError(
          "INVALID_EXTENSION",
          `${type} is not provided by a loaded moddle descriptor`
        );
      }
      throw error;
    }

    if (raw.$descriptor.isGeneric) {
      throw new ModelApiError(
        "INVALID_EXTENSION",
        `${type} is not provided by a loaded moddle descriptor`
      );
    }

    for (const property of Object.keys(properties)) {
      if (!typedDescriptorProperties(raw).some(({ name }) => name === property)) {
        throw new ModelApiError(
          "INVALID_EXTENSION",
          `${type}.${property} is not a loaded descriptor property`
        );
      }
    }

    this.ownedElements.add(raw);
    return new CustomExtensionElement(this, raw);
  }

  process(
    properties: { id?: string; isExecutable?: boolean; name?: string } = {}
  ): ModelElement<"bpmn:Process"> {
    const process = this.create("bpmn:Process", properties);
    this.append(this.editable.definitions, process, "rootElements");
    return process;
  }

  append(
    parent: ModdleElement | ModelElement,
    child: ModdleElement | ModelElement,
    property: string
  ): void {
    const parentRaw = this.ownedRaw(parent);
    const childRaw = this.ownedRaw(child);
    const descriptor = typedDescriptorProperties(parentRaw).find(
      (candidate) => candidate.name === property
    );

    if (descriptor === undefined || descriptor.isReference) {
      throw new ModelApiError(
        "INVALID_CONTAINMENT",
        `${parentRaw.$type}.${property} is not a contained moddle property`
      );
    }

    if (
      childRaw.$parent !== undefined &&
      childRaw.$parent !== parentRaw
    ) {
      throw new ModelApiError(
        "INVALID_CONTAINMENT",
        `${childRaw.$type} already belongs to ${childRaw.$parent.$type}`
      );
    }

    if (descriptor.isMany) {
      const children = asElements(parentRaw.get(property));
      if (children.includes(childRaw)) {
        throw new ModelApiError(
          "INVALID_CONTAINMENT",
          `${parentRaw.$type}.${property} already contains ${childRaw.$type}`
        );
      }
      parentRaw.set(property, [...children, childRaw]);
    } else if (parentRaw.get(property) !== undefined) {
      throw new ModelApiError(
        "INVALID_CONTAINMENT",
        `${parentRaw.$type}.${property} already contains an element`
      );
    } else {
      parentRaw.set(property, childRaw);
    }

    childRaw.$parent = parentRaw;
    this.refreshIndexes();
  }

  connect(
    source: string | ModelElement,
    target: string | ModelElement,
    properties: { id?: string; name?: string } = {}
  ): ModelElement<"bpmn:SequenceFlow"> {
    const sourceElement = typeof source === "string" ? this.element(source) : source;
    const targetElement = typeof target === "string" ? this.element(target) : target;
    this.assertOwnedWrapper(sourceElement);
    this.assertOwnedWrapper(targetElement);
    const parent = sourceElement.raw.$parent;

    if (
      parent === undefined ||
      parent !== targetElement.raw.$parent ||
      !isFlowElementContainer(parent) ||
      !isSequenceFlowEndpoint(sourceElement.raw) ||
      !isSequenceFlowEndpoint(targetElement.raw)
    ) {
      throw new ModelApiError(
        "INVALID_CONNECTION",
        "SequenceFlow endpoints must share a BPMN flow-elements container"
      );
    }

    const flow = this.create("bpmn:SequenceFlow", properties);
    flow.raw.set("sourceRef", sourceElement.raw);
    flow.raw.set("targetRef", targetElement.raw);
    this.append(parent, flow, "flowElements");
    this.addReciprocal(sourceElement.raw, "outgoing", flow.raw);
    this.addReciprocal(targetElement.raw, "incoming", flow.raw);
    return flow;
  }

  rewire(
    flow: string | ModelElement<"bpmn:SequenceFlow">,
    endpoints: {
      source?: string | ModelElement;
      target?: string | ModelElement;
    }
  ): ModelElement<"bpmn:SequenceFlow"> {
    const sequenceFlow = typeof flow === "string" ? this.element<"bpmn:SequenceFlow">(flow) : flow;
    this.assertOwnedWrapper(sequenceFlow);
    if (endpoints.source instanceof ModelElement) {
      this.assertOwnedWrapper(endpoints.source);
    }
    if (endpoints.target instanceof ModelElement) {
      this.assertOwnedWrapper(endpoints.target);
    }
    const source = endpoints.source === undefined
      ? sequenceFlow.raw.get("sourceRef")
      : typeof endpoints.source === "string"
        ? this.element(endpoints.source).raw
        : endpoints.source.raw;
    const target = endpoints.target === undefined
      ? sequenceFlow.raw.get("targetRef")
      : typeof endpoints.target === "string"
        ? this.element(endpoints.target).raw
        : endpoints.target.raw;

    if (!(source instanceof Object) || !("$type" in source) || !(target instanceof Object) || !("$type" in target)) {
      throw new ModelApiError(
        "INVALID_CONNECTION",
        "SequenceFlow must retain valid source and target elements"
      );
    }

    const sourceElement = source as ModdleElement;
    const targetElement = target as ModdleElement;
    const parent = sourceElement.$parent;
    if (
      parent === undefined ||
      sequenceFlow.raw.$parent !== parent ||
      parent !== targetElement.$parent ||
      !isFlowElementContainer(parent) ||
      !isSequenceFlowEndpoint(sourceElement) ||
      !isSequenceFlowEndpoint(targetElement)
    ) {
      throw new ModelApiError(
        "INVALID_CONNECTION",
        "SequenceFlow endpoints must share its BPMN flow-elements container"
      );
    }

    const previousSource = sequenceFlow.raw.get("sourceRef");
    const previousTarget = sequenceFlow.raw.get("targetRef");
    if (previousSource instanceof Object && "$type" in previousSource) {
      this.removeReciprocal(previousSource as ModdleElement, "outgoing", sequenceFlow.raw);
    }
    if (previousTarget instanceof Object && "$type" in previousTarget) {
      this.removeReciprocal(previousTarget as ModdleElement, "incoming", sequenceFlow.raw);
    }
    sequenceFlow.raw.set("sourceRef", sourceElement);
    sequenceFlow.raw.set("targetRef", targetElement);
    this.addReciprocal(sourceElement, "outgoing", sequenceFlow.raw);
    this.addReciprocal(targetElement, "incoming", sequenceFlow.raw);
    return sequenceFlow;
  }

  attachBoundaryEvent(
    boundaryEvent: string | ModelElement<"bpmn:BoundaryEvent">,
    activity: string | ModelElement
  ): ModelElement<"bpmn:BoundaryEvent"> {
    const boundary = typeof boundaryEvent === "string"
      ? this.element<"bpmn:BoundaryEvent">(boundaryEvent)
      : boundaryEvent;
    const attachedActivity = typeof activity === "string"
      ? this.element(activity)
      : activity;
    this.assertOwnedWrapper(boundary);
    this.assertOwnedWrapper(attachedActivity);

    if (
      !attachedActivity.raw.$instanceOf("bpmn:Activity") ||
      boundary.raw.$parent === undefined ||
      boundary.raw.$parent !== attachedActivity.raw.$parent
    ) {
      throw new ModelApiError(
        "INVALID_CONNECTION",
        "BoundaryEvent and attached activity must share a flow-elements container"
      );
    }

    const previousActivity = boundary.raw.get("attachedToRef");
    if (
      previousActivity instanceof Object &&
      "$type" in previousActivity &&
      previousActivity !== attachedActivity.raw
    ) {
      this.removeReciprocal(
        previousActivity as ModdleElement,
        "boundaryEventRefs",
        boundary.raw
      );
    }
    boundary.raw.set("attachedToRef", attachedActivity.raw);
    this.addReciprocal(
      attachedActivity.raw,
      "boundaryEventRefs",
      boundary.raw
    );
    return boundary;
  }

  remove(element: string | ModelElement): void {
    const selected = typeof element === "string" ? this.element(element) : element;
    this.assertOwnedWrapper(selected);

    if (selected.raw.$instanceOf("bpmn:SequenceFlow")) {
      const source = selected.raw.get("sourceRef");
      const target = selected.raw.get("targetRef");
      if (source instanceof Object && "$type" in source) {
        this.removeReciprocal(source as ModdleElement, "outgoing", selected.raw);
      }
      if (target instanceof Object && "$type" in target) {
        this.removeReciprocal(target as ModdleElement, "incoming", selected.raw);
      }
    } else {
      const referrer = collectSemanticElements(this.editable.definitions).find(
        (candidate) => candidate !== selected.raw && hasReference(candidate, selected.raw)
      );
      if (referrer !== undefined) {
        throw new ModelApiError(
          "ELEMENT_REFERENCED",
          `${selected.id} is referenced by ${referrer.id ?? referrer.$type}`
        );
      }
    }

    const parent = selected.raw.$parent;
    if (parent === undefined) {
      throw new ModelApiError(
        "INVALID_CONTAINMENT",
        `${selected.id} has no containing moddle element`
      );
    }

    const containment = typedDescriptorProperties(parent).find((property) => {
      if (property.isReference) {
        return false;
      }
      const value = parent.get(property.name);
      return Array.isArray(value) ? value.includes(selected.raw) : value === selected.raw;
    });
    if (containment === undefined) {
      throw new ModelApiError(
        "INVALID_CONTAINMENT",
        `${selected.id} is not contained by ${parent.$type}`
      );
    }

    if (containment.isMany) {
      parent.set(
        containment.name,
        asElements(parent.get(containment.name)).filter((child) => child !== selected.raw)
      );
    } else {
      parent.set(containment.name, undefined);
    }
    selected.raw.$parent = undefined;
    this.refreshIndexes();
  }

  async publish(options: PublishOptions = {}): Promise<PublicationResult> {
    if (this.isMemoryModel && options.output === undefined) {
      throw new ModelApiError(
        "OUTPUT_REQUIRED",
        "BpmnModel.create() requires publish({ output })"
      );
    }

    return publishModel(
      this.baseline,
      this.editable,
      this.source,
      this.runtimeOptions,
      options
    );
  }

  wrap<Type extends SupportedElementType>(
    raw: TypedModdleElement<Type>
  ): ModelElement<Type> {
    return new ModelElement(this, raw);
  }

  renameId(element: ModelElement, id: string): void {
    this.assertOwnedWrapper(element);
    const currentId = element.id;
    if (id === currentId) {
      return;
    }
    if (this.ids.has(id)) {
      throw new ModelApiError(
        "ELEMENT_ID_CONFLICT",
        `BPMN element ID "${id}" already exists`
      );
    }

    element.raw.id = id;
    this.ids.add(id);
    this.refreshIndexes();
  }

  private allocateId(type: string): string {
    const localName = type.slice(type.indexOf(":") + 1);
    let index = 1;
    let candidate = `${localName}_${index}`;

    while (this.ids.has(candidate)) {
      index += 1;
      candidate = `${localName}_${index}`;
    }

    return candidate;
  }

  private addReciprocal(
    element: ModdleElement,
    property: "boundaryEventRefs" | "incoming" | "outgoing",
    flow: ModdleElement
  ): void {
    const values = asElements(element.get(property));
    if (!values.includes(flow)) {
      element.set(property, [...values, flow]);
    }
  }

  private removeReciprocal(
    element: ModdleElement,
    property: "boundaryEventRefs" | "incoming" | "outgoing",
    flow: ModdleElement
  ): void {
    element.set(
      property,
      asElements(element.get(property)).filter((candidate) => candidate !== flow)
    );
  }

  private refreshIndexes(): void {
    this.elementsById.clear();

    for (const element of collectSemanticElements(this.editable.definitions)) {
      this.ownedElements.add(element);
      if (element.id !== undefined) {
        this.elementsById.set(element.id, element);
        this.ids.add(element.id);
      }
    }
  }

  private assertOwnedWrapper(element: ModelElement): void {
    if (!element.isOwnedBy(this)) {
      throw new ModelApiError(
        "FOREIGN_ELEMENT",
        "BPMN elements must belong to the model receiving the operation"
      );
    }
  }

  private ownedRaw(element: ModdleElement | ModelElement): ModdleElement {
    if (element instanceof ModelElement) {
      this.assertOwnedWrapper(element);
      return element.raw;
    }

    if (!this.ownedElements.has(element)) {
      throw new ModelApiError(
        "FOREIGN_ELEMENT",
        "BPMN elements must belong to the model receiving the operation"
      );
    }

    return element;
  }
}
