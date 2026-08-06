import { BpmnModel, type IoInput, type ModelElement } from "./model.js";
import type {
  PublicationResult,
  PublishOptions
} from "./model-runtime.js";

export interface ProcessOptions {
  isExecutable?: boolean;
  name?: string;
}

export interface NodeOptions {
  name?: string;
}

export interface ServiceTaskOptions extends NodeOptions {
  headers?: Readonly<Record<string, string>>;
  inputs?: readonly IoInput[];
  outputs?: readonly IoInput[];
  properties?: Readonly<Record<string, string>>;
  retries?: string;
  taskType?: string;
}

export interface UserTaskOptions extends NodeOptions {
  formId?: string;
}

export interface TimerEventOptions extends NodeOptions {
  cycle?: string;
  date?: string;
  duration?: string;
}

export interface MessageReference {
  id: string;
  name?: string;
}

export interface ErrorReference {
  code?: string;
  id: string;
  name?: string;
}

export interface EscalationReference {
  code?: string;
  id: string;
  name?: string;
}

export interface SignalReference {
  id: string;
  name?: string;
}

export type EventDefinition =
  | { type: "timer" } & TimerEventOptions
  | { type: "message"; message: MessageReference }
  | { type: "error"; error: ErrorReference }
  | { type: "escalation"; escalation: EscalationReference }
  | { type: "signal"; signal: SignalReference }
  | { type: "link"; name?: string; target?: string };

export interface StandardLoopOptions {
  condition: string;
  maximum?: number;
  testBefore?: boolean;
}

export interface MultiInstanceLoopOptions {
  cardinality: string;
  completionCondition?: string;
  sequential?: boolean;
}

export interface AdHocSubProcessOptions extends NodeOptions {
  cancelRemainingInstances?: boolean;
  completionCondition?: string;
  ordering?: "Parallel" | "Sequential";
}

export interface LoopFlowOptions {
  condition?: string;
  name?: string;
}

type FlowNodeType =
  | "bpmn:AdHocSubProcess"
  | "bpmn:BusinessRuleTask"
  | "bpmn:CallActivity"
  | "bpmn:EndEvent"
  | "bpmn:EventBasedGateway"
  | "bpmn:ExclusiveGateway"
  | "bpmn:InclusiveGateway"
  | "bpmn:IntermediateCatchEvent"
  | "bpmn:IntermediateThrowEvent"
  | "bpmn:ParallelGateway"
  | "bpmn:ScriptTask"
  | "bpmn:SubProcess"
  | "bpmn:ServiceTask"
  | "bpmn:StartEvent"
  | "bpmn:UserTask";

type GatewayType =
  | "bpmn:EventBasedGateway"
  | "bpmn:ExclusiveGateway"
  | "bpmn:InclusiveGateway"
  | "bpmn:ParallelGateway";

const activityTypes = new Set<FlowNodeType>([
  "bpmn:AdHocSubProcess",
  "bpmn:BusinessRuleTask",
  "bpmn:CallActivity",
  "bpmn:ScriptTask",
  "bpmn:ServiceTask",
  "bpmn:SubProcess",
  "bpmn:UserTask"
]);

export class ProcessBuilderError extends Error {
  constructor(
    readonly code:
      | "BRANCH_JOIN_REQUIRED"
      | "BRANCH_START_REQUIRED"
      | "DUPLICATE_DEFAULT_BRANCH"
      | "EMPTY_CONDITION"
      | "INVALID_EVENT"
      | "INVALID_LOOP"
      | "INVALID_TASK_TYPE"
      | "PROCESS_COMPLETE"
      | "START_EVENT_REQUIRED"
      | "UNFINISHED_BRANCH"
      | "UNFINISHED_PROCESS",
    message: string
  ) {
    super(message);
  }
}

function createFlowNode(
  model: BpmnModel,
  process: ModelElement<"bpmn:Process">,
  source: ModelElement | undefined,
  type: FlowNodeType,
  id: string,
  options: NodeOptions,
  flowName?: string
): {
  flow: ModelElement<"bpmn:SequenceFlow"> | undefined;
  node: ModelElement<FlowNodeType>;
} {
  const node = model.create<FlowNodeType>(type, { id, name: options.name });
  model.append(process, node, "flowElements");
  const flow = source === undefined
    ? undefined
    : model.connect(source, node, { name: flowName });
  return { flow, node };
}

function configureServiceTask(
  task: ModelElement<"bpmn:ServiceTask">,
  options: ServiceTaskOptions
): void {
  if (options.taskType !== undefined && options.taskType.trim().length === 0) {
    throw new ProcessBuilderError(
      "INVALID_TASK_TYPE",
      "A Zeebe service task type must not be empty"
    );
  }
  if (options.taskType !== undefined || options.retries !== undefined) {
    task.extensions.ensure("zeebe:TaskDefinition").setProperties({
      retries: options.retries,
      type: options.taskType
    });
  }
  const mapping = task.extensions.ensure("zeebe:IoMapping");
  for (const input of options.inputs ?? []) mapping.addInput(input);
  for (const output of options.outputs ?? []) mapping.addOutput(output);
  if (options.headers !== undefined) {
    const headers = task.extensions.ensure("zeebe:TaskHeaders");
    for (const [key, value] of Object.entries(options.headers)) {
      headers.createChild("values", "zeebe:Header", { key, value });
    }
  }
  if (options.properties !== undefined) {
    const properties = task.extensions.ensure("zeebe:Properties");
    for (const [name, value] of Object.entries(options.properties)) {
      properties.createChild("properties", "zeebe:Property", { name, value });
    }
  }
}

function nonEmpty(value: string, description: string): void {
  if (value.trim().length === 0) {
    throw new ProcessBuilderError("INVALID_EVENT", `${description} must not be empty`);
  }
}

function timerValue(definition: Extract<EventDefinition, { type: "timer" }>): {
  property: "timeCycle" | "timeDate" | "timeDuration";
  value: string;
} {
  const values = [
    ["timeCycle", definition.cycle],
    ["timeDate", definition.date],
    ["timeDuration", definition.duration]
  ].filter((entry): entry is ["timeCycle" | "timeDate" | "timeDuration", string] =>
    entry[1] !== undefined
  );
  if (values.length !== 1) {
    throw new ProcessBuilderError(
      "INVALID_EVENT",
      "A timer event requires exactly one of cycle, date, or duration"
    );
  }
  const [timer] = values;
  if (timer === undefined) {
    throw new ProcessBuilderError("INVALID_EVENT", "A timer event requires a timer value");
  }
  nonEmpty(timer[1], "A timer value");
  return { property: timer[0], value: timer[1] };
}

function existingRoot<Type extends "bpmn:Error" | "bpmn:Escalation" | "bpmn:Message" | "bpmn:Signal">(
  model: BpmnModel,
  type: Type,
  id: string
): ModelElement<Type> | undefined {
  try {
    const element = model.element(id);
    if (element.type !== type) {
      throw new ProcessBuilderError(
        "INVALID_EVENT",
        `${id} already identifies ${element.type}, not ${type}`
      );
    }
    return element as ModelElement<Type>;
  } catch (error) {
    if (error instanceof ProcessBuilderError) throw error;
    return undefined;
  }
}

function message(model: BpmnModel, reference: MessageReference): ModelElement<"bpmn:Message"> {
  nonEmpty(reference.id, "A message ID");
  return existingRoot(model, "bpmn:Message", reference.id) ??
    model.rootElement("bpmn:Message", { id: reference.id, name: reference.name });
}

function error(model: BpmnModel, reference: ErrorReference): ModelElement<"bpmn:Error"> {
  nonEmpty(reference.id, "An error ID");
  return existingRoot(model, "bpmn:Error", reference.id) ??
    model.rootElement("bpmn:Error", {
      errorCode: reference.code,
      id: reference.id,
      name: reference.name
    });
}

function escalation(
  model: BpmnModel,
  reference: EscalationReference
): ModelElement<"bpmn:Escalation"> {
  nonEmpty(reference.id, "An escalation ID");
  return existingRoot(model, "bpmn:Escalation", reference.id) ??
    model.rootElement("bpmn:Escalation", {
      escalationCode: reference.code,
      id: reference.id,
      name: reference.name
    });
}

function signal(model: BpmnModel, reference: SignalReference): ModelElement<"bpmn:Signal"> {
  nonEmpty(reference.id, "A signal ID");
  return existingRoot(model, "bpmn:Signal", reference.id) ??
    model.rootElement("bpmn:Signal", { id: reference.id, name: reference.name });
}

function eventDefinition(
  model: BpmnModel,
  event: ModelElement,
  definition: EventDefinition
): void {
  switch (definition.type) {
    case "timer": {
      const timer = model.create("bpmn:TimerEventDefinition", {});
      const value = timerValue(definition);
      timer.createChild(value.property, "bpmn:FormalExpression", { body: value.value });
      model.append(event, timer, "eventDefinitions");
      return;
    }
    case "message": {
      const eventDefinition = model.create("bpmn:MessageEventDefinition", {});
      eventDefinition.setReferences({ messageRef: message(model, definition.message).id });
      model.append(event, eventDefinition, "eventDefinitions");
      return;
    }
    case "error": {
      const eventDefinition = model.create("bpmn:ErrorEventDefinition", {});
      eventDefinition.setReferences({ errorRef: error(model, definition.error).id });
      model.append(event, eventDefinition, "eventDefinitions");
      return;
    }
    case "escalation": {
      const eventDefinition = model.create("bpmn:EscalationEventDefinition", {});
      eventDefinition.setReferences({
        escalationRef: escalation(model, definition.escalation).id
      });
      model.append(event, eventDefinition, "eventDefinitions");
      return;
    }
    case "signal": {
      const eventDefinition = model.create("bpmn:SignalEventDefinition", {});
      eventDefinition.setReferences({ signalRef: signal(model, definition.signal).id });
      model.append(event, eventDefinition, "eventDefinitions");
      return;
    }
    case "link": {
      const eventDefinition = model.create("bpmn:LinkEventDefinition", {
        name: definition.name
      });
      if (definition.target !== undefined) {
        const target = model.element(definition.target)
          .children<"bpmn:LinkEventDefinition">("eventDefinitions")
          .find((candidate) => candidate.type === "bpmn:LinkEventDefinition");
        if (target === undefined) {
          throw new ProcessBuilderError(
            "INVALID_EVENT",
            `Link target ${definition.target} must have a link event definition`
          );
        }
        eventDefinition.setReferences({ target: target.id });
      }
      model.append(event, eventDefinition, "eventDefinitions");
    }
  }
}

function configureStandardLoop(
  model: BpmnModel,
  activity: ModelElement,
  options: StandardLoopOptions
): void {
  if (!activityTypes.has(activity.type as FlowNodeType)) {
    throw new ProcessBuilderError("INVALID_LOOP", "Loops require a BPMN activity");
  }
  nonEmpty(options.condition, "A loop condition");
  if (options.maximum !== undefined && (!Number.isInteger(options.maximum) || options.maximum < 1)) {
    throw new ProcessBuilderError("INVALID_LOOP", "A loop maximum must be a positive integer");
  }
  const loop = model.create("bpmn:StandardLoopCharacteristics", {
    loopMaximum: options.maximum,
    testBefore: options.testBefore
  });
  loop.createChild("loopCondition", "bpmn:FormalExpression", { body: options.condition });
  model.append(activity, loop, "loopCharacteristics");
}

function configureMultiInstanceLoop(
  model: BpmnModel,
  activity: ModelElement,
  options: MultiInstanceLoopOptions
): void {
  if (!activityTypes.has(activity.type as FlowNodeType)) {
    throw new ProcessBuilderError("INVALID_LOOP", "Loops require a BPMN activity");
  }
  nonEmpty(options.cardinality, "A multi-instance cardinality");
  if (options.completionCondition !== undefined) {
    nonEmpty(options.completionCondition, "A multi-instance completion condition");
  }
  const loop = model.create("bpmn:MultiInstanceLoopCharacteristics", {
    isSequential: options.sequential
  });
  loop.createChild("loopCardinality", "bpmn:FormalExpression", {
    body: options.cardinality
  });
  if (options.completionCondition !== undefined) {
    loop.createChild("completionCondition", "bpmn:FormalExpression", {
      body: options.completionCondition
    });
  }
  model.append(activity, loop, "loopCharacteristics");
}

class BoundaryHandlerBuilder {
  private complete = false;
  private current: ModelElement;

  constructor(
    private readonly model: BpmnModel,
    private readonly process: ModelElement<"bpmn:Process">,
    boundary: ModelElement<"bpmn:BoundaryEvent">
  ) {
    this.current = boundary;
  }

  userTask(id: string, options: UserTaskOptions = {}): this {
    this.add("bpmn:UserTask", id, options);
    if (options.formId !== undefined) {
      this.model.element<"bpmn:UserTask">(id).configureForm({ formId: options.formId });
    }
    return this;
  }

  serviceTask(id: string, options: ServiceTaskOptions = {}): this {
    this.add("bpmn:ServiceTask", id, options);
    configureServiceTask(this.model.element<"bpmn:ServiceTask">(id), options);
    return this;
  }

  catchEvent(id: string, definition: EventDefinition, options: NodeOptions = {}): this {
    const node = this.add("bpmn:IntermediateCatchEvent", id, options);
    eventDefinition(this.model, node, definition);
    return this;
  }

  throwEvent(id: string, definition: Exclude<EventDefinition, { type: "timer" }>, options: NodeOptions = {}): this {
    const node = this.add("bpmn:IntermediateThrowEvent", id, options);
    eventDefinition(this.model, node, definition);
    return this;
  }

  endEvent(id: string, options: NodeOptions = {}): this {
    this.add("bpmn:EndEvent", id, options);
    this.complete = true;
    return this;
  }

  isComplete(): boolean {
    return this.complete;
  }

  private add(type: Exclude<FlowNodeType, "bpmn:StartEvent">, id: string, options: NodeOptions): ModelElement<FlowNodeType> {
    if (this.complete) {
      throw new ProcessBuilderError(
        "PROCESS_COMPLETE",
        "A boundary handler cannot add nodes after its end event"
      );
    }
    const { node } = createFlowNode(this.model, this.process, this.current, type, id, options);
    this.current = node;
    return node;
  }
}

export class BranchBuilder {
  private complete = false;
  private current: ModelElement | undefined;
  private defaultBranch = false;
  private expression: string | undefined;
  private firstNode = true;
  private joining = false;

  constructor(
    private readonly model: BpmnModel,
    private readonly process: ModelElement<"bpmn:Process">,
    private readonly gateway: ModelElement<GatewayType>,
    private readonly name: string,
    private readonly requiresDecision: boolean,
    private readonly requiresCatchEvent: boolean,
    private readonly claimDefault: () => void
  ) {}

  condition(expression: string): this {
    if (!this.requiresDecision || this.expression !== undefined || this.defaultBranch) {
      throw new ProcessBuilderError(
        "BRANCH_START_REQUIRED",
        "Only exclusive and inclusive branches may declare one condition or default flow"
      );
    }
    if (expression.trim().length === 0) {
      throw new ProcessBuilderError("EMPTY_CONDITION", "A gateway branch condition must not be empty");
    }
    this.expression = expression;
    return this;
  }

  defaultFlow(): this {
    if (!this.requiresDecision || this.expression !== undefined || this.defaultBranch) {
      throw new ProcessBuilderError(
        "BRANCH_START_REQUIRED",
        "Only exclusive and inclusive branches may declare one condition or default flow"
      );
    }
    this.claimDefault();
    this.defaultBranch = true;
    return this;
  }

  userTask(id: string, options: UserTaskOptions = {}): this {
    this.addNode("bpmn:UserTask", id, options);
    if (options.formId !== undefined) {
      this.model.element<"bpmn:UserTask">(id).configureForm({ formId: options.formId });
    }
    return this;
  }

  serviceTask(id: string, options: ServiceTaskOptions = {}): this {
    this.addNode("bpmn:ServiceTask", id, options);
    configureServiceTask(this.model.element<"bpmn:ServiceTask">(id), options);
    return this;
  }

  catchEvent(id: string, definition: EventDefinition, options: NodeOptions = {}): this {
    const node = this.addNode("bpmn:IntermediateCatchEvent", id, options);
    eventDefinition(this.model, node, definition);
    return this;
  }

  throwEvent(id: string, definition: Exclude<EventDefinition, { type: "timer" }>, options: NodeOptions = {}): this {
    const node = this.addNode("bpmn:IntermediateThrowEvent", id, options);
    eventDefinition(this.model, node, definition);
    return this;
  }

  endEvent(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:EndEvent", id, options);
    this.complete = true;
    return this;
  }

  join(): this {
    if (this.complete || this.current === undefined) {
      throw new ProcessBuilderError(
        "BRANCH_JOIN_REQUIRED",
        "Only a non-terminal branch with a node can join a gateway"
      );
    }
    this.complete = true;
    this.joining = true;
    return this;
  }

  isComplete(): boolean {
    return this.complete;
  }

  joinsGateway(): boolean {
    return this.joining;
  }

  endpoint(): ModelElement {
    if (this.current === undefined) {
      throw new ProcessBuilderError("BRANCH_JOIN_REQUIRED", "A branch requires a node before joining");
    }
    return this.current;
  }

  private addNode(
    type: Exclude<FlowNodeType, "bpmn:StartEvent">,
    id: string,
    options: NodeOptions
  ): ModelElement<FlowNodeType> {
    if (this.complete) {
      throw new ProcessBuilderError(
        "PROCESS_COMPLETE",
        "A branch cannot add nodes after its end event or join declaration"
      );
    }
    if (this.firstNode && this.requiresDecision && this.expression === undefined && !this.defaultBranch) {
      throw new ProcessBuilderError(
        "BRANCH_START_REQUIRED",
        "Call condition() or defaultFlow() before adding a branch node"
      );
    }
    if (this.firstNode && this.requiresCatchEvent && type !== "bpmn:IntermediateCatchEvent") {
      throw new ProcessBuilderError(
        "BRANCH_START_REQUIRED",
        "An event-based gateway branch must start with a catch event"
      );
    }
    const { flow, node } = createFlowNode(
      this.model,
      this.process,
      this.current ?? this.gateway,
      type,
      id,
      options,
      this.firstNode ? this.name : undefined
    );
    if (this.firstNode && flow !== undefined) {
      if (this.expression !== undefined) {
        const condition = this.model.create("bpmn:FormalExpression", { body: this.expression });
        this.model.append(flow, condition, "conditionExpression");
      } else if (this.defaultBranch) {
        this.model.setDefaultFlow(
          this.gateway as ModelElement<"bpmn:ExclusiveGateway" | "bpmn:InclusiveGateway">,
          flow
        );
      }
    }
    this.current = node;
    this.firstNode = false;
    return node;
  }
}

export class ProcessBuilder {
  private activeBranches: BranchBuilder[] = [];
  private current: ModelElement | undefined;
  private defaultBranchClaimed = false;
  private started = false;
  private terminal = false;

  constructor(
    private readonly model: BpmnModel,
    private readonly process: ModelElement<"bpmn:Process">
  ) {}

  startEvent(id: string, options: NodeOptions = {}): this {
    if (this.started) {
      throw new ProcessBuilderError("START_EVENT_REQUIRED", "A process builder can only create one start event");
    }
    const { node } = createFlowNode(this.model, this.process, undefined, "bpmn:StartEvent", id, options);
    this.current = node;
    this.started = true;
    return this;
  }

  timerStartEvent(id: string, options: TimerEventOptions): this {
    return this.startWithEvent(id, { type: "timer", ...options }, options);
  }

  messageStartEvent(id: string, message: MessageReference, options: NodeOptions = {}): this {
    return this.startWithEvent(id, { type: "message", message }, options);
  }

  signalStartEvent(id: string, signal: SignalReference, options: NodeOptions = {}): this {
    return this.startWithEvent(id, { type: "signal", signal }, options);
  }

  userTask(id: string, options: UserTaskOptions = {}): this {
    this.addNode("bpmn:UserTask", id, options);
    if (options.formId !== undefined) {
      this.model.element<"bpmn:UserTask">(id).configureForm({ formId: options.formId });
    }
    return this;
  }

  serviceTask(id: string, options: ServiceTaskOptions = {}): this {
    this.addNode("bpmn:ServiceTask", id, options);
    configureServiceTask(this.model.element<"bpmn:ServiceTask">(id), options);
    return this;
  }

  exclusiveGateway(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:ExclusiveGateway", id, options);
    return this;
  }

  parallelGateway(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:ParallelGateway", id, options);
    return this;
  }

  inclusiveGateway(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:InclusiveGateway", id, options);
    return this;
  }

  eventBasedGateway(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:EventBasedGateway", id, options);
    return this;
  }

  callActivity(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:CallActivity", id, options);
    return this;
  }

  businessRuleTask(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:BusinessRuleTask", id, options);
    return this;
  }

  scriptTask(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:ScriptTask", id, options);
    return this;
  }

  subProcess(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:SubProcess", id, options);
    return this;
  }

  adHocSubProcess(id: string, options: AdHocSubProcessOptions = {}): this {
    this.addNode("bpmn:AdHocSubProcess", id, options);
    const node = this.model.element<"bpmn:AdHocSubProcess">(id);
    node.setProperties({
      cancelRemainingInstances: options.cancelRemainingInstances,
      ordering: options.ordering
    });
    if (options.completionCondition !== undefined) {
      nonEmpty(options.completionCondition, "An ad-hoc completion condition");
      node.createChild("completionCondition", "bpmn:FormalExpression", {
        body: options.completionCondition
      });
    }
    return this;
  }

  intermediateCatchEvent(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:IntermediateCatchEvent", id, options);
    return this;
  }

  intermediateThrowEvent(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:IntermediateThrowEvent", id, options);
    return this;
  }

  catchEvent(id: string, definition: EventDefinition, options: NodeOptions = {}): this {
    const node = this.addNode("bpmn:IntermediateCatchEvent", id, options);
    eventDefinition(this.model, node, definition);
    return this;
  }

  throwEvent(id: string, definition: Exclude<EventDefinition, { type: "timer" }>, options: NodeOptions = {}): this {
    const node = this.addNode("bpmn:IntermediateThrowEvent", id, options);
    eventDefinition(this.model, node, definition);
    return this;
  }

  timerCatchEvent(id: string, options: TimerEventOptions): this {
    return this.catchEvent(id, { type: "timer", ...options }, options);
  }

  messageCatchEvent(id: string, message: MessageReference, options: NodeOptions = {}): this {
    return this.catchEvent(id, { type: "message", message }, options);
  }

  messageThrowEvent(id: string, message: MessageReference, options: NodeOptions = {}): this {
    return this.throwEvent(id, { type: "message", message }, options);
  }

  errorThrowEvent(id: string, errorReference: ErrorReference, options: NodeOptions = {}): this {
    return this.throwEvent(id, { type: "error", error: errorReference }, options);
  }

  escalationThrowEvent(id: string, escalationReference: EscalationReference, options: NodeOptions = {}): this {
    return this.throwEvent(id, { type: "escalation", escalation: escalationReference }, options);
  }

  signalCatchEvent(id: string, signalReference: SignalReference, options: NodeOptions = {}): this {
    return this.catchEvent(id, { type: "signal", signal: signalReference }, options);
  }

  signalThrowEvent(id: string, signalReference: SignalReference, options: NodeOptions = {}): this {
    return this.throwEvent(id, { type: "signal", signal: signalReference }, options);
  }

  linkCatchEvent(id: string, name: string, options: NodeOptions = {}): this {
    return this.catchEvent(id, { type: "link", name }, options);
  }

  linkThrowEvent(id: string, target: string, options: NodeOptions = {}): this {
    return this.throwEvent(id, { type: "link", target }, options);
  }

  standardLoop(options: StandardLoopOptions): this {
    this.assertCurrentActivity();
    configureStandardLoop(this.model, this.current as ModelElement, options);
    return this;
  }

  multiInstanceLoop(options: MultiInstanceLoopOptions): this {
    this.assertCurrentActivity();
    configureMultiInstanceLoop(this.model, this.current as ModelElement, options);
    return this;
  }

  loop(target: string, options: LoopFlowOptions = {}): this {
    if (this.current === undefined) {
      throw new ProcessBuilderError("START_EVENT_REQUIRED", "A loop requires a current flow node");
    }
    const flow = this.model.connect(this.current, target, { name: options.name });
    if (options.condition !== undefined) {
      if (options.condition.trim().length === 0) {
        throw new ProcessBuilderError("EMPTY_CONDITION", "A loop condition must not be empty");
      }
      const condition = this.model.create("bpmn:FormalExpression", {
        body: options.condition
      });
      this.model.append(flow, condition, "conditionExpression");
    }
    return this;
  }

  boundary(
    id: string,
    definition: EventDefinition,
    handler: (handler: BoundaryHandlerBuilder) => BoundaryHandlerBuilder,
    options: NodeOptions & { cancelActivity?: boolean } = {}
  ): this {
    this.assertCurrentActivity();
    const boundary = this.model.create("bpmn:BoundaryEvent", {
      cancelActivity: options.cancelActivity,
      id,
      name: options.name
    });
    this.model.append(this.process, boundary, "flowElements");
    this.model.attachBoundaryEvent(boundary, this.current as ModelElement);
    eventDefinition(this.model, boundary, definition);
    const built = handler(new BoundaryHandlerBuilder(this.model, this.process, boundary));
    if (!built.isComplete()) {
      throw new ProcessBuilderError(
        "UNFINISHED_BRANCH",
        `Boundary handler "${id}" must end with an end event`
      );
    }
    return this;
  }

  timerBoundaryEvent(
    id: string,
    timer: TimerEventOptions,
    handler: (handler: BoundaryHandlerBuilder) => BoundaryHandlerBuilder,
    options: NodeOptions & { cancelActivity?: boolean } = {}
  ): this {
    return this.boundary(id, { type: "timer", ...timer }, handler, options);
  }

  messageBoundaryEvent(
    id: string,
    message: MessageReference,
    handler: (handler: BoundaryHandlerBuilder) => BoundaryHandlerBuilder,
    options: NodeOptions & { cancelActivity?: boolean } = {}
  ): this {
    return this.boundary(id, { type: "message", message }, handler, options);
  }

  errorBoundaryEvent(
    id: string,
    errorReference: ErrorReference,
    handler: (handler: BoundaryHandlerBuilder) => BoundaryHandlerBuilder,
    options: NodeOptions & { cancelActivity?: boolean } = {}
  ): this {
    return this.boundary(id, { type: "error", error: errorReference }, handler, options);
  }

  escalationBoundaryEvent(
    id: string,
    escalationReference: EscalationReference,
    handler: (handler: BoundaryHandlerBuilder) => BoundaryHandlerBuilder,
    options: NodeOptions & { cancelActivity?: boolean } = {}
  ): this {
    return this.boundary(id, { type: "escalation", escalation: escalationReference }, handler, options);
  }

  signalBoundaryEvent(
    id: string,
    signalReference: SignalReference,
    handler: (handler: BoundaryHandlerBuilder) => BoundaryHandlerBuilder,
    options: NodeOptions & { cancelActivity?: boolean } = {}
  ): this {
    return this.boundary(id, { type: "signal", signal: signalReference }, handler, options);
  }

  endEvent(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:EndEvent", id, options);
    this.terminal = true;
    return this;
  }

  errorEndEvent(id: string, errorReference: ErrorReference, options: NodeOptions = {}): this {
    const node = this.addNode("bpmn:EndEvent", id, options);
    eventDefinition(this.model, node, { type: "error", error: errorReference });
    this.terminal = true;
    return this;
  }

  escalationEndEvent(id: string, escalationReference: EscalationReference, options: NodeOptions = {}): this {
    const node = this.addNode("bpmn:EndEvent", id, options);
    eventDefinition(this.model, node, { type: "escalation", escalation: escalationReference });
    this.terminal = true;
    return this;
  }

  signalEndEvent(id: string, signalReference: SignalReference, options: NodeOptions = {}): this {
    const node = this.addNode("bpmn:EndEvent", id, options);
    eventDefinition(this.model, node, { type: "signal", signal: signalReference });
    this.terminal = true;
    return this;
  }

  branch(name: string, build: (branch: BranchBuilder) => BranchBuilder): this {
    if (this.current === undefined || !this.isGateway(this.current.type)) {
      throw new ProcessBuilderError(
        "BRANCH_START_REQUIRED",
        "Branches must start from the current gateway"
      );
    }
    const gateway = this.current as ModelElement<GatewayType>;
    const requiresDecision = gateway.type === "bpmn:ExclusiveGateway" || gateway.type === "bpmn:InclusiveGateway";
    const branch = build(new BranchBuilder(
      this.model,
      this.process,
      gateway,
      name,
      requiresDecision,
      gateway.type === "bpmn:EventBasedGateway",
      () => {
        if (this.defaultBranchClaimed) {
          throw new ProcessBuilderError(
            "DUPLICATE_DEFAULT_BRANCH",
            "A gateway can have only one default branch"
          );
        }
        this.defaultBranchClaimed = true;
      }
    ));
    if (!branch.isComplete()) {
      throw new ProcessBuilderError(
        "UNFINISHED_BRANCH",
        `Branch "${name}" must end with an end event or join()`
      );
    }
    this.activeBranches.push(branch);
    return this;
  }

  join(id: string, type: GatewayType, options: NodeOptions = {}): this {
    if (this.activeBranches.length === 0 || !this.activeBranches.every((branch) => branch.joinsGateway())) {
      throw new ProcessBuilderError(
        "BRANCH_JOIN_REQUIRED",
        "Every active branch must call join() before an explicit gateway join"
      );
    }
    const join = this.model.create<GatewayType>(type, { id, name: options.name });
    this.model.append(this.process, join, "flowElements");
    for (const branch of this.activeBranches) {
      this.model.connect(branch.endpoint(), join);
    }
    this.activeBranches = [];
    this.current = join;
    this.defaultBranchClaimed = false;
    return this;
  }

  parallelJoin(id: string, options: NodeOptions = {}): this {
    return this.join(id, "bpmn:ParallelGateway", options);
  }

  inclusiveJoin(id: string, options: NodeOptions = {}): this {
    return this.join(id, "bpmn:InclusiveGateway", options);
  }

  exclusiveJoin(id: string, options: NodeOptions = {}): this {
    return this.join(id, "bpmn:ExclusiveGateway", options);
  }

  build(): BpmnModel {
    if (!this.started) {
      throw new ProcessBuilderError("START_EVENT_REQUIRED", "A process builder requires a start event");
    }
    if (this.activeBranches.length > 0 && !this.activeBranches.every((branch) => branch.isComplete())) {
      throw new ProcessBuilderError("UNFINISHED_BRANCH", "Every branch must end or declare a join");
    }
    if (!this.terminal && this.activeBranches.length === 0) {
      throw new ProcessBuilderError("UNFINISHED_PROCESS", "A process builder requires an end event");
    }
    return this.model;
  }

  publish(options: PublishOptions): Promise<PublicationResult> {
    return this.build().publish(options);
  }

  private startWithEvent(id: string, definition: EventDefinition, options: NodeOptions): this {
    this.startEvent(id, options);
    eventDefinition(this.model, this.current as ModelElement, definition);
    return this;
  }

  private addNode(
    type: Exclude<FlowNodeType, "bpmn:StartEvent">,
    id: string,
    options: NodeOptions
  ): ModelElement<FlowNodeType> {
    if (!this.started) {
      throw new ProcessBuilderError("START_EVENT_REQUIRED", "A process builder must start with startEvent()");
    }
    if (this.terminal || this.activeBranches.length > 0) {
      throw new ProcessBuilderError(
        "PROCESS_COMPLETE",
        "A process cannot add nodes after its end event or before an explicit branch join"
      );
    }
    const { node } = createFlowNode(this.model, this.process, this.current, type, id, options);
    this.current = node;
    return node;
  }

  private assertCurrentActivity(): void {
    if (this.current === undefined || !activityTypes.has(this.current.type as FlowNodeType)) {
      throw new ProcessBuilderError("INVALID_LOOP", "The current node must be a BPMN activity");
    }
  }

  private isGateway(type: string): type is GatewayType {
    return type === "bpmn:EventBasedGateway" ||
      type === "bpmn:ExclusiveGateway" ||
      type === "bpmn:InclusiveGateway" ||
      type === "bpmn:ParallelGateway";
  }
}

export const Bpmn = {
  async createProcess(
    id: string,
    options: ProcessOptions = {}
  ): Promise<ProcessBuilder> {
    const model = await BpmnModel.create();
    return new ProcessBuilder(model, model.process({
      id,
      isExecutable: options.isExecutable ?? true,
      name: options.name
    }));
  }
};
