declare module "bpmn-auto-layout" {
  export class LayoutError extends Error {}

  export function layoutProcess(xml: string): Promise<string>;
}
