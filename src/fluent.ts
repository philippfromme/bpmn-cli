import {
  BpmnModel,
  type ModelElement
} from "./model.js";
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
  taskType?: string;
}

type FlowNodeType =
  | "bpmn:EndEvent"
  | "bpmn:ExclusiveGateway"
  | "bpmn:ServiceTask"
  | "bpmn:StartEvent"
  | "bpmn:UserTask";

export class ProcessBuilderError extends Error {
  constructor(
    readonly code:
      | "BRANCH_START_REQUIRED"
      | "DUPLICATE_DEFAULT_BRANCH"
      | "EMPTY_CONDITION"
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
  const node = model.create<FlowNodeType>(type, {
    id,
    name: options.name
  });
  model.append(process, node, "flowElements");
  const flow = source === undefined
    ? undefined
    : model.connect(source, node, { name: flowName });
  return { flow, node };
}

function configureTaskType(
  task: ModelElement<"bpmn:ServiceTask">,
  taskType: string
): void {
  if (taskType.trim().length === 0) {
    throw new ProcessBuilderError(
      "INVALID_TASK_TYPE",
      "A Zeebe service task type must not be empty"
    );
  }
  task.extensions.ensure("zeebe:TaskDefinition").raw.set("type", taskType);
}

export class BranchBuilder {
  private defaultBranch = false;
  private expression: string | undefined;
  private firstNode = true;
  private complete = false;
  private current: ModelElement | undefined;

  constructor(
    private readonly model: BpmnModel,
    private readonly process: ModelElement<"bpmn:Process">,
    private readonly gateway: ModelElement<"bpmn:ExclusiveGateway">,
    private readonly name: string,
    private readonly claimDefault: () => void
  ) {}

  condition(expression: string): this {
    if (expression.trim().length === 0) {
      throw new ProcessBuilderError(
        "EMPTY_CONDITION",
        "A gateway branch condition must not be empty"
      );
    }
    if (this.expression !== undefined || this.defaultBranch) {
      throw new ProcessBuilderError(
        "BRANCH_START_REQUIRED",
        "Configure exactly one condition or default flow before adding branch nodes"
      );
    }
    this.expression = expression;
    return this;
  }

  defaultFlow(): this {
    if (this.expression !== undefined || this.defaultBranch) {
      throw new ProcessBuilderError(
        "BRANCH_START_REQUIRED",
        "Configure exactly one condition or default flow before adding branch nodes"
      );
    }
    this.claimDefault();
    this.defaultBranch = true;
    return this;
  }

  userTask(id: string, options: NodeOptions = {}): this {
    return this.addNode("bpmn:UserTask", id, options);
  }

  serviceTask(id: string, options: ServiceTaskOptions = {}): this {
    this.addNode("bpmn:ServiceTask", id, options);
    if (options.taskType !== undefined) {
      configureTaskType(this.model.element<"bpmn:ServiceTask">(id), options.taskType);
    }
    return this;
  }

  endEvent(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:EndEvent", id, options);
    this.complete = true;
    return this;
  }

  isComplete(): boolean {
    return this.complete;
  }

  private addNode(
    type: Exclude<FlowNodeType, "bpmn:ExclusiveGateway" | "bpmn:StartEvent">,
    id: string,
    options: NodeOptions
  ): this {
    if (this.complete) {
      throw new ProcessBuilderError(
        "PROCESS_COMPLETE",
        "A branch cannot add nodes after its end event"
      );
    }
    if (this.firstNode && this.expression === undefined && !this.defaultBranch) {
      throw new ProcessBuilderError(
        "BRANCH_START_REQUIRED",
        "Call condition() or defaultFlow() before adding a branch node"
      );
    }

    const source = this.current ?? this.gateway;
    const { flow, node } = createFlowNode(
      this.model,
      this.process,
      source,
      type,
      id,
      options,
      this.firstNode ? this.name : undefined
    );

    if (this.firstNode && flow !== undefined) {
      if (this.expression !== undefined) {
        const condition = this.model.create("bpmn:FormalExpression", {
          body: this.expression
        });
        this.model.append(flow, condition, "conditionExpression");
      } else {
        this.gateway.raw.set("default", flow.raw);
      }
    }

    this.current = node;
    this.firstNode = false;
    return this;
  }
}

export class ProcessBuilder {
  private current: ModelElement | undefined;
  private defaultBranchClaimed = false;
  private hasBranches = false;
  private started = false;
  private terminal = false;

  constructor(
    private readonly model: BpmnModel,
    private readonly process: ModelElement<"bpmn:Process">
  ) {}

  startEvent(id: string, options: NodeOptions = {}): this {
    if (this.started) {
      throw new ProcessBuilderError(
        "START_EVENT_REQUIRED",
        "A process builder can only create one start event"
      );
    }
    const { node } = createFlowNode(
      this.model,
      this.process,
      undefined,
      "bpmn:StartEvent",
      id,
      options
    );
    this.current = node;
    this.started = true;
    return this;
  }

  userTask(id: string, options: NodeOptions = {}): this {
    return this.addNode("bpmn:UserTask", id, options);
  }

  serviceTask(id: string, options: ServiceTaskOptions = {}): this {
    this.addNode("bpmn:ServiceTask", id, options);
    if (options.taskType !== undefined) {
      configureTaskType(this.model.element<"bpmn:ServiceTask">(id), options.taskType);
    }
    return this;
  }

  exclusiveGateway(id: string, options: NodeOptions = {}): this {
    return this.addNode("bpmn:ExclusiveGateway", id, options);
  }

  endEvent(id: string, options: NodeOptions = {}): this {
    this.addNode("bpmn:EndEvent", id, options);
    this.terminal = true;
    return this;
  }

  branch(name: string, build: (branch: BranchBuilder) => BranchBuilder): this {
    if (this.current?.type !== "bpmn:ExclusiveGateway") {
      throw new ProcessBuilderError(
        "BRANCH_START_REQUIRED",
        "Branches must start from the current exclusive gateway"
      );
    }
    const branch = build(new BranchBuilder(
      this.model,
      this.process,
      this.current as ModelElement<"bpmn:ExclusiveGateway">,
      name,
      () => {
        if (this.defaultBranchClaimed) {
          throw new ProcessBuilderError(
            "DUPLICATE_DEFAULT_BRANCH",
            "An exclusive gateway can have only one default branch"
          );
        }
        this.defaultBranchClaimed = true;
      }
    ));
    if (!branch.isComplete()) {
      throw new ProcessBuilderError(
        "UNFINISHED_BRANCH",
        `Branch "${name}" must end with an end event`
      );
    }
    this.hasBranches = true;
    return this;
  }

  build(): BpmnModel {
    if (!this.started) {
      throw new ProcessBuilderError(
        "START_EVENT_REQUIRED",
        "A process builder requires a start event"
      );
    }
    if (!this.terminal && !this.hasBranches) {
      throw new ProcessBuilderError(
        "UNFINISHED_PROCESS",
        "A process builder requires an end event"
      );
    }
    return this.model;
  }

  publish(options: PublishOptions): Promise<PublicationResult> {
    return this.build().publish(options);
  }

  private addNode(
    type: Exclude<FlowNodeType, "bpmn:StartEvent">,
    id: string,
    options: NodeOptions
  ): this {
    if (!this.started) {
      throw new ProcessBuilderError(
        "START_EVENT_REQUIRED",
        "A process builder must start with startEvent()"
      );
    }
    if (this.terminal || this.hasBranches) {
      throw new ProcessBuilderError(
        "PROCESS_COMPLETE",
        "A process cannot add nodes after its end event or gateway branches"
      );
    }
    const { node } = createFlowNode(
      this.model,
      this.process,
      this.current,
      type,
      id,
      options
    );
    this.current = node;
    return this;
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
