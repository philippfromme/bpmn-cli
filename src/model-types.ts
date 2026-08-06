import type { BpmnModdle, ModdleElement } from "bpmn-moddle";

import {
  descriptorPropertyClassifications,
  getDescriptorPropertyClassification,
  supportedElementTypes,
  type DescriptorPropertyClassification,
  type ElementProperties,
  type SupportedElementType
} from "./model-types.generated.js";

export {
  descriptorPropertyClassifications,
  getDescriptorPropertyClassification,
  supportedElementTypes,
  type DescriptorPropertyClassification,
  type ElementProperties,
  type SupportedElementType
};

export type ElementPropertiesInput<Type extends SupportedElementType> = {
  -readonly [Property in keyof ElementProperties<Type>]: ElementProperties<Type>[Property];
};

export type TypedModdleElement<Type extends SupportedElementType> = ModdleElement & {
  $type: Type;
};

export function createElement<Type extends SupportedElementType>(
  moddle: BpmnModdle,
  type: Type,
  properties: ElementPropertiesInput<Type>
): TypedModdleElement<Type> {
  return moddle.create(
    type,
    properties as Record<string, unknown>
  ) as TypedModdleElement<Type>;
}

export function isElementType<Type extends SupportedElementType>(
  element: ModdleElement,
  type: Type
): element is TypedModdleElement<Type> {
  return element.$type === type;
}

export function isSupportedElementType(type: string): type is SupportedElementType {
  return (supportedElementTypes as readonly string[]).includes(type);
}
