import type { CliResult } from "./index.js";

interface ApiTopic {
  methods: readonly string[];
  snippet: string;
  summary: string;
  topic: string;
}

const topics: readonly ApiTopic[] = [
  {
    methods: ["BpmnModel.create", "model.process", "model.create", "model.append", "model.publish"],
    snippet: `const model = await BpmnModel.create();
const process = model.process({ name: "Customer email" });
const task = model.create("bpmn:UserTask", { name: "Send email" });
model.append(process, task, "flowElements");
await model.publish({ output: "customer-email.bpmn", layout: "auto" });`,
    summary: "Create a process, add a typed BPMN element, and publish it safely.",
    topic: "create-process"
  },
  {
    methods: ["BpmnModel.open", "model.element", "element.extensions.ensure", "ioMapping.addInput", "model.publish"],
    snippet: `const model = await BpmnModel.open("customer-support.bpmn");
model.element("ServiceTask_1").extensions.ensure("zeebe:IoMapping").addInput({
  source: "=customer.id",
  target: "customerId"
});
await model.publish({ output: "customer-support.edited.bpmn", layout: "auto" });`,
    summary: "Add a nested Zeebe input mapping without replacing existing extensions.",
    topic: "io-mapping"
  },
  {
    methods: ["model.create", "model.append", "model.connect", "model.rewire", "model.remove"],
    snippet: `const flow = model.connect("Task_Collect", "Task_Send");
model.rewire(flow, { target: "Task_Review" });
model.remove(flow);`,
    summary: "Create, rewire, and remove SequenceFlows with reciprocal references maintained.",
    topic: "connections"
  },
  {
    methods: ["model.element", "element.configureForm", "model.publish"],
    snippet: `model.element("UserTask_Review").configureForm({
  formId: "review-customer"
});`,
    summary: "Configure a native Zeebe form on an existing BPMN user task.",
    topic: "user-task-form"
  },
  {
    methods: ["element.extensions.ensureCustom", "customExtension.set", "customExtension.append"],
    snippet: `const settings = task.extensions.ensureCustom("acme:Settings", {
  priority: "high"
});
settings.append("rules", "acme:Rule", { name: "customer" });`,
    summary: "Use loaded custom descriptors through named properties, never JSON Pointers.",
    topic: "custom-extensions"
  }
];

export const apiHelpText = `Usage:
  bpmn-cli api [topic] [--json]

Discover a bounded fluent model API topic with applicable methods and a focused
program snippet. Topics: ${topics.map(({ topic }) => topic).join(", ")}.

Options:
  --json                  Emit versioned JSON
  -h, --help              Display this help message
`;

function errorResult(message: string, json: boolean): CliResult {
  return json
    ? {
        exitCode: 1,
        output: `${JSON.stringify({
          schemaVersion: "1",
          error: { code: "API_TOPIC_NOT_FOUND", exitCode: 1, message }
        })}\n`,
        stream: "stderr"
      }
    : { exitCode: 1, output: `${message}\n`, stream: "stderr" };
}

export function executeApi(args: readonly string[]): CliResult {
  const json = args.includes("--json");
  const values = args.filter((argument) => argument !== "--json");

  if (values.length === 1 && (values[0] === "--help" || values[0] === "-h")) {
    return { exitCode: 0, output: apiHelpText, stream: "stdout" };
  }
  if (values.length > 1 || values.some((argument) => argument.startsWith("-"))) {
    return errorResult(`Run "bpmn-cli api --help" for usage.`, json);
  }

  const selected = values.length === 0
    ? topics
    : topics.filter(({ topic }) => topic === values[0]);
  if (selected.length === 0) {
    return errorResult(`Unknown fluent API topic "${values[0]}".`, json);
  }

  const envelope = {
    schemaVersion: "1",
    topics: selected,
    view: "api"
  };
  return {
    exitCode: 0,
    output: json
      ? `${JSON.stringify(envelope)}\n`
      : selected.map((topic) =>
        `${topic.topic}: ${topic.summary}\n${topic.snippet}\n`
      ).join("\n"),
    stream: "stdout"
  };
}
