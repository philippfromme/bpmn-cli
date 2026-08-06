// AUTO-GENERATED from zeebe.json by @bpmn-io/moddle-types-generator — do not edit.

import type { ModdleElement } from 'moddle';

export interface ZeebeZeebeServiceTask {
  retryCounter?: string;
}

export interface ZeebeIoMapping {
  ioMapping?: ModdleElement<ZeebeIoMapping>;
  inputParameters?: ModdleElement<ZeebeInput>[];
  outputParameters?: ModdleElement<ZeebeOutput>[];
}

export interface ZeebeInputOutputParameter {
  source?: string;
  target?: string;
}

export interface ZeebeSubscription {
  correlationKey?: string;
}

export interface ZeebeInput extends ZeebeInputOutputParameter {
}

export interface ZeebeOutput extends ZeebeInputOutputParameter {
}

export interface ZeebeTaskHeaders {
  values?: ModdleElement<ZeebeHeader>[];
}

export interface ZeebeHeader {
  id?: string;
  key?: string;
  value?: string;
}

export interface ZeebeTaskDefinition {
  type?: string;
  retries?: string;
}

export interface ZeebeLoopCharacteristics {
  inputCollection?: string;
  inputElement?: string;
  outputCollection?: string;
  outputElement?: string;
}

export interface ZeebeCalledElement {
  processId?: string;
  processIdExpression?: string;
  propagateAllChildVariables?: boolean;
  propagateAllParentVariables?: boolean;
}

export interface ZeebeUserTaskForm {
  id?: string;
  body?: string;
}

export interface ZeebeFormDefinition {
  formKey?: string;
  formId?: string;
  externalReference?: string;
}

export interface ZeebeLinkedResource {
  resourceId?: string;
  resourceType?: string;
  linkName?: string;
}

export interface ZeebeLinkedResources {
  values?: ModdleElement<ZeebeLinkedResource>[];
}

export interface ZeebeUserTask {
}

export interface ZeebeCalledDecision {
  decisionId?: string;
  resultVariable?: string;
}

export interface ZeebeAssignmentDefinition {
  assignee?: string;
  candidateGroups?: string;
  candidateUsers?: string;
}

export interface ZeebePriorityDefinition {
  priority?: string;
}

export interface ZeebeJobPriorityDefinition {
  priority?: string;
}

export interface ZeebeTaskSchedule {
  dueDate?: string;
  followUpDate?: string;
}

export interface ZeebeProperties {
  properties?: ModdleElement<ZeebeProperty>[];
}

export interface ZeebeProperty {
  name?: string;
  value?: string;
}

export interface ZeebeTemplateSupported {
  modelerTemplate?: string;
  modelerTemplateVersion?: number;
  modelerTemplateIcon?: string;
}

export interface ZeebeConfigurationSupported {
  modelerConfigurationTemplate?: string;
  modelerConfigurationName?: string;
}

export interface ZeebeTemplatedRootElement {
  modelerTemplate?: string;
}

export interface ZeebeScript {
  expression?: string;
  resultVariable?: string;
}

export interface ZeebeExecutionListeners {
  listeners?: ModdleElement<ZeebeExecutionListener>[];
}

export interface ZeebeExecutionListener {
  eventType?: string;
  retries?: string;
  type?: string;
  headers?: ModdleElement<ZeebeTaskHeaders>;
}

export interface ZeebeTaskListeners {
  listeners?: ModdleElement<ZeebeTaskListener>[];
}

export interface ZeebeTaskListener {
  eventType?: string;
  retries?: string;
  type?: string;
}

export interface ZeebeVersionTag {
  value?: string;
}

export interface ZeebeBindingTypeSupported {
  bindingType?: string;
  versionTag?: string;
}

export interface ZeebeAdHoc {
  activeElementsCollection?: string;
  outputCollection?: string;
  outputElement?: string;
}

export interface ZeebeConditionalFilter {
  variableNames?: string;
  variableEvents?: string;
}

export interface ZeebeModdleTypeMap {
  'zeebe:ZeebeServiceTask': ModdleElement<ZeebeZeebeServiceTask> & { $type: 'zeebe:ZeebeServiceTask' };
  'zeebe:IoMapping': ModdleElement<ZeebeIoMapping> & { $type: 'zeebe:IoMapping' };
  'zeebe:InputOutputParameter': ModdleElement<ZeebeInputOutputParameter> & { $type: 'zeebe:InputOutputParameter' };
  'zeebe:Subscription': ModdleElement<ZeebeSubscription> & { $type: 'zeebe:Subscription' };
  'zeebe:Input': ModdleElement<ZeebeInput> & { $type: 'zeebe:Input' };
  'zeebe:Output': ModdleElement<ZeebeOutput> & { $type: 'zeebe:Output' };
  'zeebe:TaskHeaders': ModdleElement<ZeebeTaskHeaders> & { $type: 'zeebe:TaskHeaders' };
  'zeebe:Header': ModdleElement<ZeebeHeader> & { $type: 'zeebe:Header' };
  'zeebe:TaskDefinition': ModdleElement<ZeebeTaskDefinition> & { $type: 'zeebe:TaskDefinition' };
  'zeebe:LoopCharacteristics': ModdleElement<ZeebeLoopCharacteristics> & { $type: 'zeebe:LoopCharacteristics' };
  'zeebe:CalledElement': ModdleElement<ZeebeCalledElement> & { $type: 'zeebe:CalledElement' };
  'zeebe:UserTaskForm': ModdleElement<ZeebeUserTaskForm> & { $type: 'zeebe:UserTaskForm' };
  'zeebe:FormDefinition': ModdleElement<ZeebeFormDefinition> & { $type: 'zeebe:FormDefinition' };
  'zeebe:LinkedResource': ModdleElement<ZeebeLinkedResource> & { $type: 'zeebe:LinkedResource' };
  'zeebe:LinkedResources': ModdleElement<ZeebeLinkedResources> & { $type: 'zeebe:LinkedResources' };
  'zeebe:UserTask': ModdleElement<ZeebeUserTask> & { $type: 'zeebe:UserTask' };
  'zeebe:CalledDecision': ModdleElement<ZeebeCalledDecision> & { $type: 'zeebe:CalledDecision' };
  'zeebe:AssignmentDefinition': ModdleElement<ZeebeAssignmentDefinition> & { $type: 'zeebe:AssignmentDefinition' };
  'zeebe:PriorityDefinition': ModdleElement<ZeebePriorityDefinition> & { $type: 'zeebe:PriorityDefinition' };
  'zeebe:JobPriorityDefinition': ModdleElement<ZeebeJobPriorityDefinition> & { $type: 'zeebe:JobPriorityDefinition' };
  'zeebe:TaskSchedule': ModdleElement<ZeebeTaskSchedule> & { $type: 'zeebe:TaskSchedule' };
  'zeebe:Properties': ModdleElement<ZeebeProperties> & { $type: 'zeebe:Properties' };
  'zeebe:Property': ModdleElement<ZeebeProperty> & { $type: 'zeebe:Property' };
  'zeebe:TemplateSupported': ModdleElement<ZeebeTemplateSupported> & { $type: 'zeebe:TemplateSupported' };
  'zeebe:ConfigurationSupported': ModdleElement<ZeebeConfigurationSupported> & { $type: 'zeebe:ConfigurationSupported' };
  'zeebe:TemplatedRootElement': ModdleElement<ZeebeTemplatedRootElement> & { $type: 'zeebe:TemplatedRootElement' };
  'zeebe:Script': ModdleElement<ZeebeScript> & { $type: 'zeebe:Script' };
  'zeebe:ExecutionListeners': ModdleElement<ZeebeExecutionListeners> & { $type: 'zeebe:ExecutionListeners' };
  'zeebe:ExecutionListener': ModdleElement<ZeebeExecutionListener> & { $type: 'zeebe:ExecutionListener' };
  'zeebe:TaskListeners': ModdleElement<ZeebeTaskListeners> & { $type: 'zeebe:TaskListeners' };
  'zeebe:TaskListener': ModdleElement<ZeebeTaskListener> & { $type: 'zeebe:TaskListener' };
  'zeebe:VersionTag': ModdleElement<ZeebeVersionTag> & { $type: 'zeebe:VersionTag' };
  'zeebe:BindingTypeSupported': ModdleElement<ZeebeBindingTypeSupported> & { $type: 'zeebe:BindingTypeSupported' };
  'zeebe:AdHoc': ModdleElement<ZeebeAdHoc> & { $type: 'zeebe:AdHoc' };
  'zeebe:ConditionalFilter': ModdleElement<ZeebeConditionalFilter> & { $type: 'zeebe:ConditionalFilter' };
}
