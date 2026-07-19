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

const fixture = fileURLToPath(
  new URL("../test/fixtures/AI Email Support Agent.bpmn", import.meta.url)
);
const collaborationFixture = fileURLToPath(
  new URL(
    "../test/fixtures/car rental booking process.bpmn",
    import.meta.url
  )
);

async function inspect(args: readonly string[]) {
  return execute(["inspect", ...args]);
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

test("returns a bounded catalog for the complex Camunda 8 fixture", async () => {
  const result = await inspect([fixture, "--json"]);
  const document = JSON.parse(result.output);
  const process = document.analysis.processes[0];

  assert.equal(result.exitCode, 0);
  assert.equal(result.stream, "stdout");
  assert.equal(document.schemaVersion, "1");
  assert.equal(document.view, "model");
  assert.equal(document.source, undefined);
  assert.equal(document.semanticHash, undefined);
  assert.equal(document.model.definitions.$type, "bpmn:Definitions");
  assert.equal(document.model.definitions.id, "Definitions_1");
  assert.equal(document.analysis.totals.semanticElements, 76);
  assert.equal(
    document.analysis.totals.countsByType["bpmn:SequenceFlow"],
    26
  );
  assert.equal(process.element.id, "Process_0j5qzil");
  assert.equal(process.directFlowElementCount, 30);
  assert.deepEqual(process.nestedContainerRefs, [
    "Activity_04glkkx",
    "Activity_0sw5ued"
  ]);
  assert.deepEqual(document.profiles, [
    {
      name: "zeebe",
      namespace: "http://camunda.org/schema/zeebe/1.0",
      package: "zeebe-bpmn-moddle",
      packageVersion: "1.16.0",
      source: "detected"
    }
  ]);
  assert.deepEqual(document.analysis.sourceMetadata, {
    executionPlatform: "Camunda Cloud",
    executionPlatformVersion: "8.8.0"
  });
  assert.equal(result.output.trim().split("\n").length, 1);
  assert.ok(Buffer.byteLength(result.output) < 32768);
  assert.doesNotMatch(result.output, /modelerTemplateIcon|data:image/);
});

test("returns a process outline derived from the real process tree", async () => {
  const result = await inspect([
    fixture,
    "--process",
    "Process_0j5qzil",
    "--json"
  ]);
  const document = JSON.parse(result.output);
  const containers = Object.fromEntries(
    document.analysis.containers.map(
      (container: { element: { id: string } }) => [
        container.element.id,
        container
      ]
    )
  );

  assert.equal(result.exitCode, 0);
  assert.equal(document.view, "process");
  assert.equal(document.process.$type, "bpmn:Process");
  assert.equal(document.analysis.conditionCount, 6);
  assert.equal(containers.Process_0j5qzil.directFlowElementCount, 30);
  assert.equal(containers.Activity_04glkkx.directFlowElementCount, 23);
  assert.equal(containers.Activity_0sw5ued.directFlowElementCount, 5);
  assert.equal(
    containers.Activity_0sw5ued.element.triggeredByEvent,
    true
  );
  assert.equal(
    document.analysis.countsByType["bpmn:ExclusiveGateway"],
    5
  );
  assert.ok(
    document.analysis.referencedRootElements.some(
      (element: { id: string }) => element.id === "Error_1xmh0a2"
    )
  );
  assert.equal(document.analysis.diagnostics, undefined);
});

test("pages direct flowElements without gaps or duplicates", async () => {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const args = [
      fixture,
      "--scope",
      "Activity_04glkkx",
      "--limit",
      "7",
      "--json"
    ];

    if (cursor !== null) {
      args.push("--cursor", cursor);
    }

    const result = await inspect(args);
    const document = JSON.parse(result.output);

    assert.equal(result.exitCode, 0);
    assert.equal(document.scope.$type, "bpmn:AdHocSubProcess");
    ids.push(
      ...document.flowElements.map((element: { id: string }) => element.id)
    );
    cursor = document.page.nextCursor;
    pages += 1;
  } while (cursor !== null);

  assert.equal(pages, 4);
  assert.equal(ids.length, 23);
  assert.equal(new Set(ids).size, 23);
  assert.ok(ids.includes("Gateway_1whb5u5"));
  assert.ok(ids.includes("Flow_1mudddl"));
});

test("emits bounded JSONL records for a scope page", async () => {
  const result = await inspect([
    fixture,
    "--scope",
    "Activity_04glkkx",
    "--limit",
    "2",
    "--jsonl"
  ]);
  const records = result.output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(result.exitCode, 0);
  assert.equal(records[0].record, "scope");
  assert.equal(records[0].source, undefined);
  assert.equal(records[0].semanticHash, undefined);
  assert.equal(records[0].profiles, undefined);
  assert.deepEqual(
    records.filter(({ record }) => record === "flowElement").map(({ value }) => value.id),
    ["Reply_with_email_to_customer", "Event_WaitForResponse"]
  );
  assert.equal(records.at(-1).record, "page");
  assert.ok(records.at(-1).page.nextCursor);
});

test("returns exact boundary and sequence-flow semantics", async () => {
  const boundaryResult = await inspect([
    fixture,
    "--element",
    "Event_1wezv96",
    "--json"
  ]);
  const boundary = JSON.parse(boundaryResult.output);

  assert.deepEqual(boundary.element, {
    $type: "bpmn:BoundaryEvent",
    id: "Event_1wezv96",
    name: "knowledge base empty",
    outgoing: ["Flow_137dks7"],
    parallelMultiple: false,
    eventDefinitions: [
      {
        $type: "bpmn:ErrorEventDefinition",
        id: "ErrorEventDefinition_07papr1",
        errorRef: "Error_1xmh0a2"
      }
    ],
    cancelActivity: true,
    attachedToRef: "query_knowledge_base"
  });
  assert.equal(boundary.context.processRef, "Process_0j5qzil");
  assert.equal(boundary.context.containerRef, "Activity_04glkkx");
  assert.ok(
    boundary.context.referencedElements.some(
      ({ id }: { id?: string }) => id === "Error_1xmh0a2"
    )
  );
  assert.equal(
    boundary.context.outgoingSequenceFlows[0].targetRef,
    "Event_0wh5ha7"
  );

  const flowResult = await inspect([
    fixture,
    "--element",
    "Flow_1mudddl",
    "--json"
  ]);
  const flow = JSON.parse(flowResult.output);

  assert.deepEqual(flow.element.conditionExpression, {
    $type: "bpmn:FormalExpression",
    body: '=knowledgeBaseDecision = "yes"'
  });
  assert.equal(flow.element.sourceRef, "Gateway_1whb5u5");
  assert.equal(flow.element.targetRef, "Activity_062h34x");
  assert.equal(flow.context.sourceElement.$type, "bpmn:ExclusiveGateway");
  assert.equal(flow.context.targetElement.$type, "bpmn:ServiceTask");
});

test("omits repeated provenance by default and exposes it explicitly", async () => {
  const minimal = JSON.parse(
    (
      await inspect([
        fixture,
        "--element",
        "Event_1wezv96",
        "--json"
      ])
    ).output
  );
  const withMetadata = JSON.parse(
    (
      await inspect([
        fixture,
        "--element",
        "Event_1wezv96",
        "--json",
        "--metadata"
      ])
    ).output
  );

  assert.deepEqual(Object.keys(minimal).sort(), [
    "context",
    "element",
    "schemaVersion",
    "view"
  ]);
  assert.equal(minimal.analysis, undefined);
  assert.equal(minimal.source, undefined);
  assert.equal(minimal.semanticHash, undefined);
  assert.equal(minimal.profiles, undefined);

  assert.equal(withMetadata.source.path, fixture);
  assert.match(withMetadata.source.sha256, /^[a-f0-9]{64}$/);
  assert.match(withMetadata.semanticHash, /^[a-f0-9]{64}$/);
  assert.equal(withMetadata.profiles[0].name, "zeebe");
  assert.deepEqual(withMetadata.analysis.diagnostics, []);
  assert.deepEqual(withMetadata.element, minimal.element);
  assert.deepEqual(withMetadata.context, minimal.context);
});

test("projects Zeebe extensions but completely excludes template icons", async () => {
  const result = await inspect([
    fixture,
    "--element",
    "Activity_04glkkx",
    "--json"
  ]);
  const document = JSON.parse(result.output);
  const values = document.element.extensionElements.values;

  assert.equal(result.exitCode, 0);
  assert.equal(document.element.$type, "bpmn:AdHocSubProcess");
  assert.ok(
    values.some(
      (value: { $type: string }) => value.$type === "zeebe:TaskDefinition"
    )
  );
  assert.ok(
    values.some((value: { $type: string }) => value.$type === "zeebe:IoMapping")
  );
  assert.doesNotMatch(result.output, /modelerTemplateIcon|data:image/);
});

test("reports disabled profile data explicitly", async () => {
  const result = await inspect([
    fixture,
    "--no-auto-profile",
    "--json"
  ]);
  const document = JSON.parse(result.output);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(document.profiles, []);
  assert.ok(
    document.analysis.diagnostics.some(
      ({ code }: { code: string }) =>
        code === "PROFILE_DISABLED_DATA_IGNORED"
    )
  );
});

test("loads a custom data-only moddle descriptor", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-extension-"));
  const descriptorPath = join(directory, "custom.json");
  const bpmnPath = join(directory, "custom.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(
    descriptorPath,
    JSON.stringify({
      name: "Custom",
      prefix: "custom",
      uri: "https://example.test/custom",
      xml: { tagAlias: "lowerCase" },
      types: [
        {
          name: "Property",
          superClass: ["Element"],
          properties: [
            { name: "value", type: "String", isAttr: true }
          ]
        }
      ]
    })
  );
  await writeFile(
    bpmnPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:custom="https://example.test/custom" id="Definitions_Custom"
  targetNamespace="https://example.test">
  <bpmn:process id="Process_Custom">
    <bpmn:task id="Task_Custom">
      <bpmn:extensionElements>
        <custom:property value="business-value" />
      </bpmn:extensionElements>
    </bpmn:task>
  </bpmn:process>
</bpmn:definitions>`
  );

  const result = await inspect([
    bpmnPath,
    "--extension",
    `custom=${descriptorPath}`,
    "--element",
    "Task_Custom",
    "--json",
    "--metadata"
  ]);
  const document = JSON.parse(result.output);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(document.element.extensionElements.values, [
    {
      $type: "custom:Property",
      value: "business-value"
    }
  ]);
  assert.equal(document.profiles[0].source, "file");
});

test("rejects invalid arguments with structured JSON errors", async () => {
  const cases = [
    [fixture, "--process", "Process_0j5qzil", "--element", "Event_1wezv96"],
    [fixture, "--limit", "2"],
    [fixture, "--scope", "Activity_04glkkx", "--limit", "101"],
    [fixture, "--json", "--jsonl"],
    [fixture, "--all", "--process", "Process_0j5qzil"],
    [fixture, "--process", "missing", "--json"]
  ];

  for (const args of cases) {
    const result = await inspect([...args, "--json"]);
    const error = JSON.parse(result.output);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stream, "stderr");
    assert.equal(error.schemaVersion, "1");
    assert.ok(error.error.code);
  }

  const textMetadata = await inspect([fixture, "--metadata"]);
  assert.equal(textMetadata.exitCode, 1);
  assert.match(textMetadata.output, /--metadata requires --json or --jsonl/);
});

test("reports source, descriptor, and BPMN failures", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-errors-"));
  const malformed = join(directory, "malformed.bpmn");
  const invalidUtf8 = join(directory, "invalid-utf8.bpmn");
  const descriptor = join(directory, "invalid.json");
  const malformedDescriptor = join(directory, "malformed-descriptor.json");
  const collidingDescriptor = join(directory, "colliding-descriptor.json");
  const duplicateDescriptor = join(directory, "duplicate-descriptor.json");
  context.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(malformed, "<bpmn:definitions>");
  await writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]));
  await writeFile(descriptor, "{}");
  await writeFile(
    malformedDescriptor,
    JSON.stringify({
      name: "Malformed",
      prefix: "malformed",
      uri: "https://example.test/malformed",
      types: [{}]
    })
  );
  await writeFile(
    collidingDescriptor,
    JSON.stringify({
      name: "Collision",
      prefix: "bpmn",
      uri: "https://example.test/collision",
      types: []
    })
  );
  await writeFile(
    duplicateDescriptor,
    JSON.stringify({
      name: "Duplicate",
      prefix: "duplicate",
      uri: "https://example.test/duplicate",
      types: [
        { name: "Value", properties: [] },
        { name: "Value", properties: [] }
      ]
    })
  );

  const missing = await inspect([join(directory, "missing.bpmn"), "--json"]);
  const decoding = await inspect([invalidUtf8, "--json"]);
  const parsing = await inspect([malformed, "--json"]);
  const invalidDescriptor = await inspect([
    malformed,
    "--extension",
    `custom=${descriptor}`,
    "--json"
  ]);
  const malformedDescriptorResult = await inspect([
    malformed,
    "--extension",
    `custom=${malformedDescriptor}`,
    "--json"
  ]);
  const collidingDescriptorResult = await inspect([
    malformed,
    "--extension",
    `custom=${collidingDescriptor}`,
    "--json"
  ]);
  const duplicateDescriptorResult = await inspect([
    malformed,
    "--extension",
    `custom=${duplicateDescriptor}`,
    "--json"
  ]);

  assert.equal(JSON.parse(missing.output).error.code, "SOURCE_READ_FAILED");
  assert.equal(JSON.parse(decoding.output).error.code, "SOURCE_DECODE_FAILED");
  assert.equal(JSON.parse(parsing.output).error.code, "BPMN_PARSE_FAILED");
  assert.equal(
    JSON.parse(invalidDescriptor.output).error.code,
    "PROFILE_ERROR"
  );
  assert.equal(
    JSON.parse(malformedDescriptorResult.output).error.code,
    "PROFILE_ERROR"
  );
  assert.equal(
    JSON.parse(collidingDescriptorResult.output).error.code,
    "PROFILE_ERROR"
  );
  assert.equal(
    JSON.parse(duplicateDescriptorResult.output).error.code,
    "PROFILE_ERROR"
  );
});

test("writes complete output safely without modifying the BPMN source", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-output-"));
  const output = join(directory, "process.json");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sourceBefore = await readFile(fixture);

  const first = await inspect([
    fixture,
    "--process",
    "Process_0j5qzil",
    "--all",
    "--json",
    "--output",
    output
  ]);

  assert.equal(first.exitCode, 0);
  assert.equal(first.output, "");

  const artifact = JSON.parse(await readFile(output, "utf8"));
  assert.equal(artifact.process.flowElements.length, 30);
  assert.equal(artifact.source.path, fixture);
  assert.match(artifact.source.sha256, /^[a-f0-9]{64}$/);
  assert.match(artifact.semanticHash, /^[a-f0-9]{64}$/);
  assert.equal(artifact.profiles[0].name, "zeebe");
  assert.deepEqual(artifact.analysis.diagnostics, []);
  assert.doesNotMatch(JSON.stringify(artifact), /modelerTemplateIcon|data:image/);

  const collision = await inspect([
    fixture,
    "--process",
    "Process_0j5qzil",
    "--all",
    "--json",
    "--output",
    output
  ]);
  assert.equal(collision.exitCode, 2);

  const forced = await inspect([
    fixture,
    "--process",
    "Process_0j5qzil",
    "--all",
    "--json",
    "--output",
    output,
    "--force"
  ]);
  assert.equal(forced.exitCode, 0);
  assert.deepEqual(await readFile(fixture), sourceBefore);
});

test("refuses to overwrite or alias the BPMN source", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-source-output-"));
  const source = join(directory, "source.bpmn");
  const alias = join(directory, "source-alias.bpmn");
  const sourceBytes = await readFile(fixture);
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(source, sourceBytes);
  await link(source, alias);

  for (const output of [source, alias]) {
    const result = await inspect([
      source,
      "--process",
      "Process_0j5qzil",
      "--all",
      "--json",
      "--output",
      output,
      "--force"
    ]);

    assert.equal(result.exitCode, 2);
    assert.equal(JSON.parse(result.output).error.code, "OUTPUT_WRITE_FAILED");
    assert.deepEqual(await readFile(source), sourceBytes);
  }
});

test("writes complete JSONL as independently addressable element records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-jsonl-"));
  const output = join(directory, "process.jsonl");
  const jsonOutput = join(directory, "process.json");
  context.after(() => rm(directory, { recursive: true, force: true }));

  const result = await inspect([
    fixture,
    "--process",
    "Process_0j5qzil",
    "--all",
    "--jsonl",
    "--output",
    output
  ]);
  const contents = await readFile(output, "utf8");
  await inspect([
    fixture,
    "--process",
    "Process_0j5qzil",
    "--all",
    "--json",
    "--output",
    jsonOutput
  ]);
  const json = JSON.parse(await readFile(jsonOutput, "utf8"));
  const records = contents
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(result.exitCode, 0);
  assert.equal(records[0].record, "inspection");
  assert.ok(records.filter(({ record }) => record === "element").length > 75);
  assert.ok(
    records.some(
      ({ path, value }) =>
        typeof path === "string" &&
        path.includes("/flowElements/") &&
        value?.id === "Gateway_1whb5u5"
    )
  );
  assert.deepEqual(
    records.find(({ path }) => path === "/process").value,
    json.process
  );
  assert.doesNotMatch(contents, /"\$path":/);
  assert.doesNotMatch(contents, /modelerTemplateIcon|data:image/);
});

test("preserves unresolved references and rejects duplicate IDs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-integrity-"));
  const unresolved = join(directory, "unresolved.bpmn");
  const duplicate = join(directory, "duplicate.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    unresolved,
    `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Refs" targetNamespace="https://example.test">
  <bpmn:process id="Process_Refs">
    <bpmn:startEvent id="Start" />
    <bpmn:sequenceFlow id="Flow" sourceRef="Start" targetRef="Missing" />
    <bpmn:task id="Task">
      <bpmn:incoming>MissingIncomingA</bpmn:incoming>
      <bpmn:incoming>MissingIncomingB</bpmn:incoming>
    </bpmn:task>
  </bpmn:process>
</bpmn:definitions>`
  );
  await writeFile(
    duplicate,
    `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Duplicate" targetNamespace="https://example.test">
  <bpmn:process id="Process_Duplicate">
    <bpmn:startEvent id="Duplicate" />
    <bpmn:endEvent id="Duplicate" />
  </bpmn:process>
</bpmn:definitions>`
  );

  const unresolvedResult = await inspect([
    unresolved,
    "--element",
    "Flow",
    "--json"
  ]);
  const unresolvedDocument = JSON.parse(unresolvedResult.output);
  const duplicateResult = await inspect([duplicate, "--json"]);
  const repeatedResult = await inspect([
    unresolved,
    "--element",
    "Task",
    "--json"
  ]);
  const repeatedDocument = JSON.parse(repeatedResult.output);

  assert.equal(unresolvedResult.exitCode, 0);
  assert.equal(unresolvedDocument.element.targetRef, "Missing");
  assert.ok(
    unresolvedDocument.analysis.diagnostics.some(
      ({ code, elementRef, property }: Record<string, string>) =>
        code === "UNRESOLVED_REFERENCE" &&
        elementRef === "Flow" &&
        property === "targetRef"
    )
  );
  assert.equal(repeatedResult.exitCode, 0);
  assert.deepEqual(repeatedDocument.element.incoming, [
    "MissingIncomingA",
    "MissingIncomingB"
  ]);
  assert.deepEqual(repeatedDocument.context.incomingSequenceFlows, []);
  assert.equal(duplicateResult.exitCode, 3);
  assert.equal(JSON.parse(duplicateResult.output).error.code, "BPMN_PARSE_FAILED");
});

test("preserves unsupported semantic attributes but excludes presentation attributes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-attrs-"));
  const bpmn = join(directory, "attributes.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    bpmn,
    `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:foo="https://example.test/foo" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  id="Definitions_Attrs" targetNamespace="https://example.test">
  <bpmn:process id="Process_Attrs">
    <bpmn:task id="Task_Attrs" foo:businessKey="customer-42"
      zeebe:modelerTemplateIcon="data:image/svg+xml;base64,SECRET" />
  </bpmn:process>
</bpmn:definitions>`
  );

  const result = await inspect([
    bpmn,
    "--element",
    "Task_Attrs",
    "--no-auto-profile",
    "--json"
  ]);
  const document = JSON.parse(result.output);

  assert.equal(result.exitCode, 0);
  assert.equal(document.element["foo:businessKey"], "customer-42");
  assert.equal(document.element["zeebe:modelerTemplateIcon"], undefined);
  assert.doesNotMatch(result.output, /data:image|SECRET/);
  assert.ok(
    document.analysis.diagnostics.some(
      ({ code, property }: Record<string, string>) =>
        code === "UNSUPPORTED_EXTENSION_DATA" &&
        property === "foo:businessKey"
    )
  );
});

test("inspects generic extension elements without treating them as cursor errors", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-generic-extension-"));
  const bpmn = join(directory, "generic-extension.bpmn");
  const output = join(directory, "process.json");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(bpmn, genericExtensionModel());

  const elementResult = await inspect([
    bpmn,
    "--element",
    "Task_Generic",
    "--json"
  ]);
  const processResult = await inspect([
    bpmn,
    "--process",
    "Process_Generic",
    "--json"
  ]);
  const completeResult = await inspect([
    bpmn,
    "--process",
    "Process_Generic",
    "--all",
    "--output",
    output,
    "--json"
  ]);
  const documents = [
    JSON.parse(elementResult.output),
    JSON.parse(processResult.output),
    JSON.parse(await readFile(output, "utf8"))
  ];

  assert.equal(elementResult.exitCode, 0);
  assert.equal(processResult.exitCode, 0);
  assert.equal(completeResult.exitCode, 0);

  for (const document of documents) {
    assert.ok(
      document.analysis.diagnostics.some(
        ({ code, message }: Record<string, string>) =>
          code === "UNSUPPORTED_EXTENSION_DATA" &&
          typeof message === "string" &&
          message.includes("vendor:approvalPolicy")
      )
    );
  }
});

test("keeps semantic hashes invariant for DI and excluded presentation data", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-invariance-"));
  const source = await readFile(fixture, "utf8");
  const presentationVariant = join(directory, "presentation.bpmn");
  const semanticVariant = join(directory, "semantic.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(
    presentationVariant,
    source
      .replaceAll(
        /zeebe:modelerTemplateIcon="[^"]*"/g,
        'zeebe:modelerTemplateIcon="data:image/svg+xml;base64,DIFFERENT"'
      )
      .replace(
        /(<dc:Bounds\b[^>]*\bx=")[^"]*"/,
        (_match, prefix: string) => `${prefix}99999"`
      )
  );
  await writeFile(
    semanticVariant,
    source.replace(
      '=knowledgeBaseDecision = "yes"',
      '=knowledgeBaseDecision = "maybe"'
    )
  );

  const original = JSON.parse(
    (await inspect([fixture, "--json", "--metadata"])).output
  );
  const presentation = JSON.parse(
    (await inspect([presentationVariant, "--json", "--metadata"])).output
  );
  const semantic = JSON.parse(
    (await inspect([semanticVariant, "--json", "--metadata"])).output
  );

  assert.notEqual(original.source.sha256, presentation.source.sha256);
  assert.equal(original.semanticHash, presentation.semanticHash);
  assert.notEqual(original.semanticHash, semantic.semanticHash);
});

test("binds cursors to the exact source bytes", async (context) => {
  const first = JSON.parse(
    (
      await inspect([
        fixture,
        "--scope",
        "Activity_04glkkx",
        "--limit",
        "1",
        "--json"
      ])
    ).output
  );
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-cursor-"));
  const changed = join(directory, "changed.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(changed, `${await readFile(fixture, "utf8")}\n`);

  const result = await inspect([
    changed,
    "--scope",
    "Activity_04glkkx",
    "--cursor",
    first.page.nextCursor,
    "--json"
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.output).error.code, "STALE_CURSOR");
});

test("rejects forged cursor offsets", async () => {
  const first = JSON.parse(
    (
      await inspect([
        fixture,
        "--scope",
        "Activity_04glkkx",
        "--limit",
        "1",
        "--json"
      ])
    ).output
  );
  const payload = JSON.parse(
    Buffer.from(first.page.nextCursor, "base64url").toString("utf8")
  );

  for (const offset of [-1, 2, 100000]) {
    const cursor = Buffer.from(
      JSON.stringify({ ...payload, offset }),
      "utf8"
    ).toString("base64url");
    const result = await inspect([
      fixture,
      "--scope",
      "Activity_04glkkx",
      "--cursor",
      cursor,
      "--json"
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.output).error.code, "INVALID_CURSOR");
  }
});

test("pages artifacts within the same bounded scope sequence", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-artifacts-"));
  const bpmn = join(directory, "artifacts.bpmn");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    bpmn,
    `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Artifacts" targetNamespace="https://example.test">
  <bpmn:process id="Process_Artifacts">
    <bpmn:task id="Task" />
    ${Array.from(
      { length: 5 },
      (_, index) =>
        `<bpmn:textAnnotation id="Annotation_${index}"><bpmn:text>${index}</bpmn:text></bpmn:textAnnotation>`
    ).join("\n    ")}
  </bpmn:process>
</bpmn:definitions>`
  );

  const artifactIds: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const args = [
      bpmn,
      "--scope",
      "Process_Artifacts",
      "--limit",
      "2",
      "--json"
    ];

    if (cursor !== null) {
      args.push("--cursor", cursor);
    }

    const document = JSON.parse((await inspect(args)).output);
    artifactIds.push(
      ...document.artifacts.map(({ id }: { id: string }) => id)
    );
    cursor = document.page.nextCursor;
    assert.ok(document.page.returned <= 2);
    pages += 1;
  } while (cursor !== null);

  assert.equal(pages, 3);
  assert.deepEqual(artifactIds, [
    "Annotation_0",
    "Annotation_1",
    "Annotation_2",
    "Annotation_3",
    "Annotation_4"
  ]);
});

test("represents collaborations and message flows with BPMN terminology", async () => {
  const model = JSON.parse(
    (await inspect([collaborationFixture, "--json"])).output
  );
  const flow = JSON.parse(
    (
      await inspect([
        collaborationFixture,
        "--element",
        "Flow_05wzjkc",
        "--json"
      ])
    ).output
  );
  const message = JSON.parse(
    (
      await inspect([
        collaborationFixture,
        "--element",
        "Message_2n0bnmk",
        "--json"
      ])
    ).output
  );
  const process = JSON.parse(
    (
      await inspect([
        collaborationFixture,
        "--process",
        "Process_0bgtcqq",
        "--json"
      ])
    ).output
  );

  assert.equal(model.analysis.collaborations[0].participantCount, 4);
  assert.equal(model.analysis.collaborations[0].messageFlowCount, 14);
  assert.equal(model.analysis.totals.semanticElements, 218);
  assert.equal(flow.element.$type, "bpmn:MessageFlow");
  assert.equal(flow.element.sourceRef, "Participant_0eew51h");
  assert.equal(flow.element.targetRef, "Event_1k76lxn");
  assert.equal(flow.context.sourceElement.$type, "bpmn:Participant");
  assert.equal(flow.context.sourceElement.name, "Customer");
  assert.equal(flow.context.targetElement.$type, "bpmn:StartEvent");
  assert.equal(message.element.$type, "bpmn:Message");
  assert.equal(message.element.name, "car_picked_up");
  assert.deepEqual(
    process.analysis.collaborations[0].participantRefs,
    ["Participant_0gpkl5f"]
  );
  assert.equal(
    process.analysis.collaborations[0].messageFlowRefs.length,
    14
  );
});

test("enforces the stdout budget without truncating an element", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-budget-"));
  const bpmn = join(directory, "large.bpmn");
  const output = join(directory, "large.json");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    bpmn,
    `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Large" targetNamespace="https://example.test">
  <bpmn:process id="Process_Large">
    <bpmn:task id="Task_Large">
      <bpmn:documentation>${"x".repeat(40000)}</bpmn:documentation>
    </bpmn:task>
  </bpmn:process>
</bpmn:definitions>`
  );

  const bounded = await inspect([
    bpmn,
    "--element",
    "Task_Large",
    "--json"
  ]);
  assert.equal(bounded.exitCode, 1);
  assert.equal(JSON.parse(bounded.output).error.code, "OUTPUT_TOO_LARGE");

  const artifact = await inspect([
    bpmn,
    "--element",
    "Task_Large",
    "--all",
    "--json",
    "--output",
    output
  ]);
  assert.equal(artifact.exitCode, 0);
  assert.match(await readFile(output, "utf8"), /x{100}/);
});

test("renders concise text from bounded semantic views", async () => {
  const model = await inspect([fixture]);
  const process = await inspect([
    fixture,
    "--process",
    "Process_0j5qzil"
  ]);
  const scope = await inspect([
    fixture,
    "--scope",
    "Activity_04glkkx",
    "--limit",
    "2"
  ]);

  assert.match(model.output, /Semantic elements: 76/);
  assert.match(process.output, /Containers: 3/);
  assert.match(scope.output, /bpmn:ServiceTask/);
  assert.match(scope.output, /Next cursor:/);
});
