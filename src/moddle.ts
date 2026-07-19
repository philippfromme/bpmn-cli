import type {
  ModdleElement,
  ModdlePropertyDescriptor
} from "bpmn-moddle";

/**
 * Returns properties that are backed by a loaded moddle descriptor.
 * Unregistered extension elements are generic at runtime and have no list.
 */
export function typedDescriptorProperties(
  element: ModdleElement
): readonly ModdlePropertyDescriptor[] {
  const properties = element.$descriptor.properties;
  return Array.isArray(properties) ? properties : [];
}
