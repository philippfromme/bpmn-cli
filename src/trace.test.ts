import assert from "node:assert/strict";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { execute } from "./index.js";

const aiFixture = fileURLToPath(
  new URL("../test/fixtures/AI Email Support Agent.bpmn", import.meta.url)
);
const carRentalFixture = fileURLToPath(
  new URL(
    "../test/fixtures/car rental booking process.bpmn",
    import.meta.url
  )
);

async function trace(args: readonly string[]) {
  return execute(["trace", ...args]);
}

function genericExtensionModel(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:vendor="https://example.test/vendor" targetNamespace="https://example.test">
  <bpmn:process id="Process_Generic">
    <bpmn:startEvent id="Start_Generic">
      <bpmn:outgoing>Flow_Start_Task</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:task id="Task_Generic">
      <bpmn:incoming>Flow_Start_Task</bpmn:incoming>
      <bpmn:outgoing>Flow_Task_End</bpmn:outgoing>
      <bpmn:extensionElements>
        <vendor:approvalPolicy mode="four-eyes" />
      </bpmn:extensionElements>
    </bpmn:task>
    <bpmn:endEvent id="End_Generic">
      <bpmn:incoming>Flow_Task_End</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_Start_Task" sourceRef="Start_Generic" targetRef="Task_Generic" />
    <bpmn:sequenceFlow id="Flow_Task_End" sourceRef="Task_Generic" targetRef="End_Generic" />
  </bpmn:process>
</bpmn:definitions>
`;
}

function terminatedSubprocessModel(
  kind: "cancel" | "error",
  caught: boolean
): string {
  const isCancel = kind === "cancel";
  const scopeElement = isCancel ? "bpmn:transaction" : "bpmn:subProcess";
  const eventDefinition = isCancel
    ? "<bpmn:cancelEventDefinition />"
    : '<bpmn:errorEventDefinition errorRef="Error_Termination" />';
  const errorDefinition = isCancel
    ? ""
    : '<bpmn:error id="Error_Termination" errorCode="termination" />';
  const handler = caught
    ? `
    <bpmn:boundaryEvent id="Boundary_Termination" attachedToRef="Scope_Termination">
      ${eventDefinition}
      <bpmn:outgoing>Flow_Handler_End</bpmn:outgoing>
    </bpmn:boundaryEvent>
    <bpmn:task id="Handler_Termination">
      <bpmn:incoming>Flow_Handler_End</bpmn:incoming>
    </bpmn:task>
    <bpmn:sequenceFlow id="Flow_Handler_End" sourceRef="Boundary_Termination" targetRef="Handler_Termination" />`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="https://example.test">
  <bpmn:process id="Process_Termination">
    <bpmn:startEvent id="Start_Parent">
      <bpmn:outgoing>Flow_Parent_Scope</bpmn:outgoing>
    </bpmn:startEvent>
    <${scopeElement} id="Scope_Termination">
      <bpmn:incoming>Flow_Parent_Scope</bpmn:incoming>
      <bpmn:outgoing>Flow_Scope_Continue</bpmn:outgoing>
      <bpmn:startEvent id="Start_Inner">
        <bpmn:outgoing>Flow_Inner_Task</bpmn:outgoing>
      </bpmn:startEvent>
      <bpmn:task id="Task_Inner">
        <bpmn:incoming>Flow_Inner_Task</bpmn:incoming>
        <bpmn:outgoing>Flow_Task_Termination</bpmn:outgoing>
      </bpmn:task>
      <bpmn:endEvent id="End_Termination">
        <bpmn:incoming>Flow_Task_Termination</bpmn:incoming>
        ${eventDefinition}
      </bpmn:endEvent>
      <bpmn:sequenceFlow id="Flow_Inner_Task" sourceRef="Start_Inner" targetRef="Task_Inner" />
      <bpmn:sequenceFlow id="Flow_Task_Termination" sourceRef="Task_Inner" targetRef="End_Termination" />
    </${scopeElement}>
    <bpmn:task id="Task_Continue">
      <bpmn:incoming>Flow_Scope_Continue</bpmn:incoming>
    </bpmn:task>
    <bpmn:sequenceFlow id="Flow_Parent_Scope" sourceRef="Start_Parent" targetRef="Scope_Termination" />
    <bpmn:sequenceFlow id="Flow_Scope_Continue" sourceRef="Scope_Termination" targetRef="Task_Continue" />
    ${handler}
  </bpmn:process>
  ${errorDefinition}
</bpmn:definitions>
`;
}

function flowElements(document: {
  trace: {
    scopes: Array<{ flowElements: Array<Record<string, unknown>> }>;
  };
}) {
  return document.trace.scopes.flatMap(({ flowElements: elements }) => elements);
}

test("traces a real boundary handler and scope-level event subprocess", async () => {
  const result = await trace([
    aiFixture,
    "--from",
    "query_knowledge_base",
    "--json"
  ]);
  const document = JSON.parse(result.output);
  const ids = new Set(
    flowElements(document).map(({ id }: { id?: string }) => id)
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(Object.keys(document).sort(), [
    "analysis",
    "schemaVersion",
    "trace",
    "view"
  ]);
  assert.equal(document.view, "trace");
  assert.equal(document.trace.mode, "forward");
  assert.ok(ids.has("query_knowledge_base"));
  assert.ok(ids.has("Event_1wezv96"));
  assert.ok(ids.has("Flow_137dks7"));
  assert.ok(ids.has("Event_0wh5ha7"));
  assert.ok(ids.has("Activity_0sw5ued"));
  assert.ok(
    document.analysis.eventTransitions.some(
      ({
        kind,
        sourceRef,
        targetRef
      }: Record<string, string>) =>
        kind === "boundary" &&
        sourceRef === "query_knowledge_base" &&
        targetRef === "Event_1wezv96"
    )
  );
  assert.ok(
    document.analysis.eventTransitions.some(
      ({ kind, targetRef }: Record<string, string>) =>
        kind === "eventSubprocess" && targetRef === "Event_1daac7o"
    )
  );
  assert.ok(
    document.trace.rootElements.some(
      ({ id }: { id: string }) => id === "Error_1xmh0a2"
    )
  );
  assert.ok(
    !document.trace.rootElements.some(
      ({ $type }: { $type: string }) => $type === "bpmn:Message"
    )
  );
  assert.ok(document.analysis.endEventRefs.includes("Event_0pcdb7p"));
  assert.doesNotMatch(result.output, /modelerTemplateIcon|data:image/);
});

test("traces generic extension elements without an internal error", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-generic-extension-"));
  const bpmn = join(directory, "generic-extension.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(bpmn, genericExtensionModel());

  const result = await trace([bpmn, "--from", "Start_Generic", "--json"]);
  const document = JSON.parse(result.output);
  const ids = new Set(
    flowElements(document).map(({ id }: { id?: string }) => id)
  );

  assert.equal(result.exitCode, 0);
  assert.ok(ids.has("Start_Generic"));
  assert.ok(ids.has("Task_Generic"));
  assert.ok(ids.has("End_Generic"));
  assert.ok(
    document.analysis.diagnostics.some(
      ({ code, message }: Record<string, string>) =>
        code === "UNSUPPORTED_EXTENSION_DATA" &&
        typeof message === "string" &&
        message.includes("vendor:approvalPolicy")
    )
  );
});

test("returns an exact connecting route and branch condition", async () => {
  const result = await trace([
    aiFixture,
    "--from",
    "Gateway_1whb5u5",
    "--to",
    "Activity_062h34x",
    "--json"
  ]);
  const document = JSON.parse(result.output);
  const elements = flowElements(document);
  const flow = elements.find(
    ({ id }) => id === "Flow_1mudddl"
  );

  assert.equal(result.exitCode, 0);
  assert.equal(document.analysis.connected, true);
  assert.equal(document.analysis.truncated, false);
  assert.ok(flow);
  assert.deepEqual(flow.conditionExpression, {
    $type: "bpmn:FormalExpression",
    body: '=knowledgeBaseDecision = "yes"'
  });
  assert.deepEqual(document.analysis.branches, [
    {
      gatewayRef: "Gateway_1whb5u5",
      sequenceFlowRef: "Flow_1mudddl",
      kind: "conditioned"
    }
  ]);
});

test("returns a successful empty graph for disconnected endpoints", async () => {
  const result = await trace([
    aiFixture,
    "--from",
    "Event_0wh5ha7",
    "--to",
    "Event_1wezv96",
    "--json"
  ]);
  const document = JSON.parse(result.output);

  assert.equal(result.exitCode, 0);
  assert.equal(document.analysis.connected, false);
  assert.deepEqual(document.trace.scopes, []);
  assert.deepEqual(document.trace.participants, []);
  assert.deepEqual(document.trace.messageFlows, []);
});

test("shows MessageFlows by default and follows them only when requested", async () => {
  const bounded = JSON.parse(
    (
      await trace([
        carRentalFixture,
        "--to",
        "Event_1k76lxn",
        "--limit",
        "5",
        "--json"
      ])
    ).output
  );
  const followed = JSON.parse(
    (
      await trace([
        carRentalFixture,
        "--to",
        "Event_1k76lxn",
        "--follow-message-flows",
        "--limit",
        "10",
        "--json"
      ])
    ).output
  );

  assert.equal(bounded.trace.messageFlows[0].id, "Flow_05wzjkc");
  assert.equal(bounded.trace.participants[0].id, "Participant_0eew51h");
  assert.deepEqual(bounded.analysis.startEventRefs, ["Event_1k76lxn"]);
  assert.equal(bounded.analysis.sourceElementRefs, undefined);

  assert.equal(followed.trace.messageFlows[0].id, "Flow_05wzjkc");
  assert.deepEqual(followed.analysis.sourceElementRefs, [
    "Participant_0eew51h"
  ]);
  assert.equal(followed.analysis.startEventRefs, undefined);
  assert.equal(followed.analysis.truncated, false);
});

test("applies deterministic breadth-first limits and frontiers", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-trace-limit-"));
  const bpmn = join(directory, "limit.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    bpmn,
    `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_1" targetNamespace="https://example.test">
  <bpmn:process id="Process_1">
    <bpmn:startEvent id="Start_1"><bpmn:outgoing>Flow_Start_Gateway</bpmn:outgoing></bpmn:startEvent>
    <bpmn:exclusiveGateway id="Gateway_1">
      <bpmn:incoming>Flow_Start_Gateway</bpmn:incoming>
      <bpmn:outgoing>Flow_A</bpmn:outgoing>
      <bpmn:outgoing>Flow_B</bpmn:outgoing>
      <bpmn:outgoing>Flow_C</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:task id="Task_A"><bpmn:incoming>Flow_A</bpmn:incoming></bpmn:task>
    <bpmn:task id="Task_B"><bpmn:incoming>Flow_B</bpmn:incoming></bpmn:task>
    <bpmn:task id="Task_C"><bpmn:incoming>Flow_C</bpmn:incoming></bpmn:task>
    <bpmn:sequenceFlow id="Flow_Start_Gateway" sourceRef="Start_1" targetRef="Gateway_1" />
    <bpmn:sequenceFlow id="Flow_A" sourceRef="Gateway_1" targetRef="Task_A" />
    <bpmn:sequenceFlow id="Flow_B" sourceRef="Gateway_1" targetRef="Task_B" />
    <bpmn:sequenceFlow id="Flow_C" sourceRef="Gateway_1" targetRef="Task_C" />
  </bpmn:process>
</bpmn:definitions>`
  );

  const result = await trace([
    bpmn,
    "--from",
    "Start_1",
    "--limit",
    "5",
    "--json"
  ]);
  const document = JSON.parse(result.output);
  const ids = flowElements(document).map(({ id }) => id);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(ids, [
    "Start_1",
    "Gateway_1",
    "Flow_Start_Gateway",
    "Flow_A"
  ]);
  assert.deepEqual(document.analysis.frontierRefs, [
    "Flow_B",
    "Flow_C",
    "Task_A"
  ]);
  assert.equal(document.analysis.truncated, true);
});

test("rejects invalid trace arguments and endpoint types", async () => {
  const cases = [
    [aiFixture, "--json"],
    [aiFixture, "--from", "Process_0j5qzil", "--json"],
    [aiFixture, "--from", "Gateway_1whb5u5", "--limit", "101", "--json"],
    [
      aiFixture,
      "--from",
      "Gateway_1whb5u5",
      "--all",
      "--limit",
      "10",
      "--json"
    ],
    [aiFixture, "--from", "Gateway_1whb5u5", "--output", "trace.json"]
  ];

  for (const args of cases) {
    const result = await trace(args);
    assert.equal(result.exitCode, 1);

    if (args.includes("--json")) {
      assert.ok(JSON.parse(result.output).error.code);
    } else {
      assert.match(result.output, /--output requires --json/);
    }
  }
});

test("renders trace help without requiring a file or selector", async () => {
  for (const args of [["--help"], ["-h"]]) {
    const result = await trace(args);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /--follow-message-flows/);
    assert.match(result.output, /--mermaid/);
    assert.match(result.output, /default: 50/);
  }
});

test("keeps provenance opt-in on stdout and complete in output files", async (context) => {
  const minimal = JSON.parse(
    (
      await trace([
        aiFixture,
        "--from",
        "Gateway_1whb5u5",
        "--limit",
        "5",
        "--json"
      ])
    ).output
  );
  const metadata = JSON.parse(
    (
      await trace([
        aiFixture,
        "--from",
        "Gateway_1whb5u5",
        "--limit",
        "5",
        "--json",
        "--metadata"
      ])
    ).output
  );
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-trace-output-"));
  const output = join(directory, "trace.json");
  context.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(minimal.source, undefined);
  assert.equal(minimal.semanticHash, undefined);
  assert.equal(minimal.profiles, undefined);
  assert.equal(metadata.source.path, aiFixture);
  assert.match(metadata.semanticHash, /^[a-f0-9]{64}$/);
  assert.equal(metadata.profiles[0].name, "zeebe");

  const written = await trace([
    aiFixture,
    "--from",
    "Gateway_1whb5u5",
    "--all",
    "--json",
    "--output",
    output
  ]);
  const artifact = JSON.parse(await readFile(output, "utf8"));
  assert.equal(written.exitCode, 0);
  assert.equal(written.output, "");
  assert.equal(artifact.source.path, aiFixture);
  assert.match(artifact.semanticHash, /^[a-f0-9]{64}$/);

  const collision = await trace([
    aiFixture,
    "--from",
    "Gateway_1whb5u5",
    "--all",
    "--json",
    "--output",
    output
  ]);
  assert.equal(collision.exitCode, 2);
  assert.equal(JSON.parse(collision.output).error.code, "OUTPUT_WRITE_FAILED");
});

test("refuses trace output paths that alias the BPMN source", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-trace-source-"));
  const source = join(directory, "source.bpmn");
  const alias = join(directory, "source-alias.bpmn");
  const sourceBytes = await readFile(aiFixture);
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(source, sourceBytes);
  await link(source, alias);

  for (const output of [source, alias]) {
    const result = await trace([
      source,
      "--from",
      "Gateway_1whb5u5",
      "--all",
      "--json",
      "--output",
      output,
      "--force"
    ]);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(await readFile(source), sourceBytes);
  }
});

test("renders concise text from the bounded trace graph", async () => {
  const result = await trace([
    aiFixture,
    "--from",
    "Gateway_1whb5u5",
    "--limit",
    "5"
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Mode: forward/);
  assert.match(result.output, /Truncated: true/);
  assert.doesNotMatch(result.output, /SHA-256|test[\\/]fixtures/);
});

test("renders a scoped Mermaid review diagram with exact conditions", async () => {
  const result = await trace([
    aiFixture,
    "--from",
    "Gateway_1whb5u5",
    "--to",
    "Activity_062h34x",
    "--mermaid"
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /^flowchart LR\n/);
  assert.match(result.output, /subgraph sg_n\d+/);
  assert.match(
    result.output,
    /Flow_1mudddl · yes · =knowledgeBaseDecision = &quot;yes&quot;/
  );
  assert.match(result.output, /ExclusiveGateway · Gateway_1whb5u5/);
  assert.match(result.output, /class n\d+ gateway;/);
  assert.match(result.output, /class n\d+ endpoint;/);
  assert.doesNotMatch(result.output, /"schemaVersion"|"trace":/);
});

test("renders MessageFlows, frontiers, and Mermaid output files", async (context) => {
  const collaboration = await trace([
    carRentalFixture,
    "--to",
    "Event_1k76lxn",
    "--follow-message-flows",
    "--limit",
    "10",
    "--mermaid"
  ]);
  const bounded = await trace([
    aiFixture,
    "--from",
    "Gateway_1whb5u5",
    "--limit",
    "5",
    "--mermaid"
  ]);
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-mermaid-"));
  const output = join(directory, "trace.mmd");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const written = await trace([
    aiFixture,
    "--from",
    "Gateway_1whb5u5",
    "--limit",
    "5",
    "--mermaid",
    "--output",
    output
  ]);

  assert.equal(collaboration.exitCode, 0);
  assert.match(collaboration.output, /Participants/);
  assert.match(collaboration.output, /Flow_05wzjkc/);
  assert.match(collaboration.output, /n\d+ -\. "Flow_05wzjkc" \.-> n\d+/);
  assert.match(bounded.output, /%% Trace truncated\. Continue from:/);
  assert.match(bounded.output, /subgraph sg_frontier\["Truncated frontier"\]/);
  assert.match(bounded.output, /class frontier\d+ frontier;/);
  assert.equal(written.exitCode, 0);
  assert.equal(written.output, "");
  assert.match(await readFile(output, "utf8"), /^flowchart LR\n/);
});

test("rejects incompatible Mermaid output options", async () => {
  const cases = [
    {
      args: [
        aiFixture,
        "--from",
        "Gateway_1whb5u5",
        "--json",
        "--mermaid"
      ],
      message: /--json and --mermaid are mutually exclusive/
    },
    {
      args: [
        aiFixture,
        "--from",
        "Gateway_1whb5u5",
        "--mermaid",
        "--pretty"
      ],
      message: /--pretty requires --json/
    },
    {
      args: [
        aiFixture,
        "--from",
        "Gateway_1whb5u5",
        "--mermaid",
        "--metadata"
      ],
      message: /--metadata requires --json/
    },
    {
      args: [
        aiFixture,
        "--from",
        "Gateway_1whb5u5",
        "--all",
        "--mermaid",
        "--output",
        "trace.mmd"
      ],
      message: /--all requires --json and --output/
    }
  ];

  for (const { args, message } of cases) {
    const result = await trace(args);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, message);
  }
});

test("escapes BPMN-controlled Mermaid labels and uses safe aliases", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-mermaid-safe-"));
  const bpmn = join(directory, "safe-labels.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    bpmn,
    `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  id="Definitions_Safe" targetNamespace="https://example.test">
  <bpmn:process id="Process-Safe">
    <bpmn:task id="Task-Unsafe" name="Review &quot;A|B&quot; &amp; &lt;done&gt;">
      <bpmn:outgoing>Flow-Unsafe</bpmn:outgoing>
    </bpmn:task>
    <bpmn:task id="Task-Target">
      <bpmn:incoming>Flow-Unsafe</bpmn:incoming>
    </bpmn:task>
    <bpmn:sequenceFlow id="Flow-Unsafe" name="yes | no"
      sourceRef="Task-Unsafe" targetRef="Task-Target">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">=value &lt; 2 and note = &quot;]&quot;</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  </bpmn:process>
</bpmn:definitions>`
  );

  const result = await trace([
    bpmn,
    "--from",
    "Task-Unsafe",
    "--mermaid"
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /n\d+\(\["Review &quot;A&#124;B&quot; &amp; &lt;done&gt;/);
  assert.match(result.output, /yes &#124; no/);
  assert.match(result.output, /note = &quot;&#93;&quot;/);
  assert.doesNotMatch(result.output, /^\s*Task-Unsafe[\s[(]/m);
});

test("preserves nested scope entry, completion, and nearest error handling", async () => {
  const result = await trace([
    carRentalFixture,
    "--from",
    "Activity_1wyl5bq",
    "--to",
    "Event_1vhsday",
    "--limit",
    "50",
    "--json"
  ]);
  const document = JSON.parse(result.output);

  assert.equal(result.exitCode, 0);
  assert.equal(document.analysis.connected, true);
  assert.ok(
    document.analysis.scopeTransitions.some(
      ({ kind, sourceRef, targetRef }: Record<string, string>) =>
        kind === "entry" &&
        sourceRef === "Activity_1wyl5bq" &&
        targetRef === "Event_1msn5tn"
    )
  );
  assert.ok(
    document.analysis.scopeTransitions.some(
      ({ kind, sourceRef, targetRef }: Record<string, string>) =>
        kind === "completion" &&
        sourceRef === "Event_0wptkfu" &&
        targetRef === "Activity_1wyl5bq"
    )
  );
  assert.ok(
    !document.analysis.scopeTransitions.some(
      ({ sourceRef }: Record<string, string>) => sourceRef === "Event_01rricx"
    )
  );
});

test("selects nearest Error and Escalation handlers and compensation targets", async () => {
  const error = JSON.parse(
    (
      await trace([
        carRentalFixture,
        "--from",
        "Event_01rricx",
        "--limit",
        "50",
        "--json"
      ])
    ).output
  );
  const escalation = JSON.parse(
    (
      await trace([
        carRentalFixture,
        "--from",
        "Event_16l1i89",
        "--limit",
        "50",
        "--json"
      ])
    ).output
  );
  const compensation = JSON.parse(
    (
      await trace([
        carRentalFixture,
        "--from",
        "Event_1hlbn3w",
        "--limit",
        "20",
        "--json"
      ])
    ).output
  );
  const scopeCompensation = JSON.parse(
    (
      await trace([
        carRentalFixture,
        "--from",
        "Event_0p8oxrp",
        "--limit",
        "20",
        "--json"
      ])
    ).output
  );

  assert.ok(
    error.analysis.eventTransitions.some(
      ({ kind, sourceRef, targetRef }: Record<string, string>) =>
        kind === "error" &&
        sourceRef === "Event_01rricx" &&
        targetRef === "Event_1tmshln"
    )
  );
  assert.ok(
    !error.analysis.eventTransitions.some(
      ({ sourceRef, targetRef }: Record<string, string>) =>
        sourceRef === "Event_01rricx" && targetRef === "Event_16knkou"
    )
  );
  assert.ok(
    escalation.analysis.eventTransitions.some(
      ({ kind, sourceRef, targetRef }: Record<string, string>) =>
        kind === "escalation" &&
        sourceRef === "Event_16l1i89" &&
        targetRef === "Event_157ki77"
    )
  );
  assert.ok(
    compensation.analysis.eventTransitions.some(
      ({ kind, sourceRef, targetRef }: Record<string, string>) =>
        kind === "compensation" &&
        sourceRef === "Event_1hlbn3w" &&
        targetRef === "Activity_0k4m2k8"
    )
  );
  assert.ok(
    scopeCompensation.analysis.eventTransitions.some(
      ({ kind, sourceRef, targetRef }: Record<string, string>) =>
        kind === "compensation" &&
        sourceRef === "Event_0p8oxrp" &&
        targetRef === "Activity_0oprw8j"
    )
  );
});

test("does not treat error or cancel termination as scope completion", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-termination-"));
  context.after(() => rm(directory, { recursive: true, force: true }));

  for (const [kind, caught] of [
    ["error", true],
    ["error", false],
    ["cancel", true],
    ["cancel", false]
  ] as const) {
    const bpmn = join(directory, `${kind}-${caught ? "caught" : "uncaught"}.bpmn`);
    await writeFile(bpmn, terminatedSubprocessModel(kind, caught));

    const result = await trace([bpmn, "--from", "Task_Inner", "--json"]);
    const document = JSON.parse(result.output);
    const ids = new Set(
      flowElements(document).map(({ id }: { id?: string }) => id)
    );
    const scopeTransitions = document.analysis.scopeTransitions ?? [];
    const eventTransitions = document.analysis.eventTransitions ?? [];

    assert.equal(result.exitCode, 0);
    assert.ok(!ids.has("Task_Continue"));
    assert.ok(
      !scopeTransitions.some(
        ({ kind: transitionKind, sourceRef, targetRef }: Record<string, string>) =>
          transitionKind === "completion" &&
          sourceRef === "End_Termination" &&
          targetRef === "Scope_Termination"
      )
    );

    if (caught) {
      assert.ok(ids.has("Handler_Termination"));
      assert.ok(
        eventTransitions.some(
          ({ kind: transitionKind, sourceRef, targetRef }: Record<string, string>) =>
            transitionKind === kind &&
            sourceRef === "End_Termination" &&
            targetRef === "Boundary_Termination"
        )
      );
    } else {
      assert.ok(
        !eventTransitions.some(
          ({ sourceRef }: Record<string, string>) =>
            sourceRef === "End_Termination"
        )
      );
    }
  }
});

test("reports SequenceFlow cycles separately from activity loops", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-trace-loops-"));
  const bpmn = join(directory, "loops.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    bpmn,
    `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Loops" targetNamespace="https://example.test">
  <bpmn:process id="Process_Loops">
    <bpmn:task id="Task_A">
      <bpmn:incoming>Flow_BA</bpmn:incoming>
      <bpmn:outgoing>Flow_AB</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics id="Loop_A" isSequential="true">
        <bpmn:loopCardinality>3</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:task>
    <bpmn:task id="Task_B">
      <bpmn:incoming>Flow_AB</bpmn:incoming>
      <bpmn:outgoing>Flow_BA</bpmn:outgoing>
    </bpmn:task>
    <bpmn:sequenceFlow id="Flow_AB" sourceRef="Task_A" targetRef="Task_B" />
    <bpmn:sequenceFlow id="Flow_BA" sourceRef="Task_B" targetRef="Task_A" />
  </bpmn:process>
</bpmn:definitions>`
  );

  const document = JSON.parse(
    (await trace([bpmn, "--from", "Task_A", "--json"])).output
  );

  assert.deepEqual(
    new Set(document.analysis.sequenceFlowCycles[0].flowElementRefs),
    new Set(["Task_A", "Task_B"])
  );
  assert.deepEqual(
    new Set(document.analysis.sequenceFlowCycles[0].sequenceFlowRefs),
    new Set(["Flow_AB", "Flow_BA"])
  );
  assert.equal(document.analysis.activityLoops[0].elementRef, "Task_A");
  assert.equal(
    document.analysis.activityLoops[0].loopCharacteristics.$type,
    "bpmn:MultiInstanceLoopCharacteristics"
  );
});

test("resolves Link transfers without inventing SequenceFlows", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-trace-link-"));
  const bpmn = join(directory, "link.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    bpmn,
    `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Link" targetNamespace="https://example.test">
  <bpmn:process id="Process_Link">
    <bpmn:startEvent id="Start"><bpmn:outgoing>Flow_ToThrow</bpmn:outgoing></bpmn:startEvent>
    <bpmn:intermediateThrowEvent id="Throw_Link">
      <bpmn:incoming>Flow_ToThrow</bpmn:incoming>
      <bpmn:linkEventDefinition id="Link_Throw" name="continue" target="Link_Catch" />
    </bpmn:intermediateThrowEvent>
    <bpmn:intermediateCatchEvent id="Catch_Link">
      <bpmn:outgoing>Flow_ToEnd</bpmn:outgoing>
      <bpmn:linkEventDefinition id="Link_Catch" name="continue" />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End"><bpmn:incoming>Flow_ToEnd</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_ToThrow" sourceRef="Start" targetRef="Throw_Link" />
    <bpmn:sequenceFlow id="Flow_ToEnd" sourceRef="Catch_Link" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`
  );

  const result = await trace([bpmn, "--from", "Start", "--json"]);
  const document = JSON.parse(result.output);

  assert.equal(result.exitCode, 0);
  assert.ok(
    document.analysis.eventTransitions.some(
      ({ kind, sourceRef, targetRef }: Record<string, string>) =>
        kind === "link" &&
        sourceRef === "Throw_Link" &&
        targetRef === "Catch_Link"
    )
  );
  assert.ok(
    flowElements(document).some(({ id }) => id === "End")
  );

  const unresolved = join(directory, "unresolved-link.bpmn");
  await writeFile(
    unresolved,
    (await readFile(bpmn, "utf8")).replace(' target="Link_Catch"', "")
  );
  const unresolvedDocument = JSON.parse(
    (await trace([unresolved, "--from", "Start", "--json"])).output
  );
  assert.equal(unresolvedDocument.analysis.eventTransitions, undefined);
  assert.ok(
    !flowElements(unresolvedDocument).some(({ id }) => id === "Catch_Link")
  );
});

test("resolves Signal throws to matching catches in the same process", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-trace-signal-"));
  const bpmn = join(directory, "signal.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    bpmn,
    `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Signal" targetNamespace="https://example.test">
  <bpmn:signal id="Signal_Ready" name="ready" />
  <bpmn:process id="Process_Signal">
    <bpmn:intermediateThrowEvent id="Throw_Signal">
      <bpmn:signalEventDefinition id="Signal_Throw" signalRef="Signal_Ready" />
    </bpmn:intermediateThrowEvent>
    <bpmn:intermediateCatchEvent id="Catch_Signal">
      <bpmn:signalEventDefinition id="Signal_Catch" signalRef="Signal_Ready" />
    </bpmn:intermediateCatchEvent>
  </bpmn:process>
</bpmn:definitions>`
  );

  const document = JSON.parse(
    (await trace([bpmn, "--from", "Throw_Signal", "--json"])).output
  );

  assert.ok(
    document.analysis.eventTransitions.some(
      ({ kind, sourceRef, targetRef }: Record<string, string>) =>
        kind === "signal" &&
        sourceRef === "Throw_Signal" &&
        targetRef === "Catch_Signal"
    )
  );
  assert.equal(document.trace.rootElements[0].id, "Signal_Ready");
});

test("includes lane, data-association, and artifact context without traversing it", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-trace-context-"));
  const bpmn = join(directory, "context.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    bpmn,
    `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Context" targetNamespace="https://example.test">
  <bpmn:process id="Process_Context">
    <bpmn:laneSet id="LaneSet_1">
      <bpmn:lane id="Lane_A" name="Agent"><bpmn:flowNodeRef>Task_A</bpmn:flowNodeRef></bpmn:lane>
    </bpmn:laneSet>
    <bpmn:dataObjectReference id="Data_Customer" name="Customer data" />
    <bpmn:task id="Task_A">
      <bpmn:ioSpecification>
        <bpmn:dataInput id="Input_Customer" />
        <bpmn:inputSet id="InputSet_1"><bpmn:dataInputRefs>Input_Customer</bpmn:dataInputRefs></bpmn:inputSet>
        <bpmn:outputSet id="OutputSet_1" />
      </bpmn:ioSpecification>
      <bpmn:dataInputAssociation id="DataAssociation_1">
        <bpmn:sourceRef>Data_Customer</bpmn:sourceRef>
        <bpmn:targetRef>Input_Customer</bpmn:targetRef>
      </bpmn:dataInputAssociation>
    </bpmn:task>
    <bpmn:textAnnotation id="Annotation_1"><bpmn:text>Business note</bpmn:text></bpmn:textAnnotation>
    <bpmn:association id="Association_1" sourceRef="Task_A" targetRef="Annotation_1" />
  </bpmn:process>
</bpmn:definitions>`
  );

  const result = await trace([bpmn, "--from", "Task_A", "--json"]);
  const document = JSON.parse(result.output);
  const scope = document.trace.scopes[0];
  const task = scope.flowElements.find(
    ({ id }: { id: string }) => id === "Task_A"
  );

  assert.equal(result.exitCode, 0);
  assert.equal(scope.laneSets[0].lanes[0].id, "Lane_A");
  assert.deepEqual(scope.laneSets[0].lanes[0].flowNodeRef, ["Task_A"]);
  assert.ok(
    scope.flowElements.some(
      ({ id }: { id: string }) => id === "Data_Customer"
    )
  );
  assert.equal(task.dataInputAssociations[0].sourceRef[0], "Data_Customer");
  assert.deepEqual(
    new Set(scope.artifacts.map(({ id }: { id: string }) => id)),
    new Set(["Annotation_1", "Association_1"])
  );
  assert.equal(document.analysis.deadEndRefs[0], "Task_A");
});

test("distinguishes required-context and complete-route limit failures", async () => {
  const contextFailure = await trace([
    carRentalFixture,
    "--from",
    "Event_01rricx",
    "--limit",
    "1",
    "--json"
  ]);
  const routeFailure = await trace([
    aiFixture,
    "--from",
    "Gateway_1whb5u5",
    "--to",
    "Activity_062h34x",
    "--limit",
    "1",
    "--json"
  ]);

  assert.equal(contextFailure.exitCode, 1);
  assert.equal(
    JSON.parse(contextFailure.output).error.code,
    "TRACE_CONTEXT_TOO_LARGE"
  );
  assert.equal(routeFailure.exitCode, 1);
  assert.equal(
    JSON.parse(routeFailure.output).error.code,
    "TRACE_ROUTE_TOO_LARGE"
  );
});

test("returns OUTPUT_TOO_LARGE for one oversized exact condition", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-trace-large-"));
  const bpmn = join(directory, "large.bpmn");
  const output = join(directory, "large.json");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    bpmn,
    `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Large" targetNamespace="https://example.test">
  <bpmn:process id="Process_Large">
    <bpmn:task id="Task_A" />
    <bpmn:task id="Task_B" />
    <bpmn:sequenceFlow id="Flow_Large" sourceRef="Task_A" targetRef="Task_B">
      <bpmn:conditionExpression>${"x".repeat(40000)}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  </bpmn:process>
</bpmn:definitions>`
  );

  const bounded = await trace([
    bpmn,
    "--from",
    "Flow_Large",
    "--json"
  ]);
  assert.equal(bounded.exitCode, 1);
  assert.equal(JSON.parse(bounded.output).error.code, "OUTPUT_TOO_LARGE");

  const artifact = await trace([
    bpmn,
    "--from",
    "Flow_Large",
    "--all",
    "--json",
    "--output",
    output
  ]);
  assert.equal(artifact.exitCode, 0);
  assert.match(await readFile(output, "utf8"), /x{100}/);
});
