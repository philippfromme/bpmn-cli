import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BpmnModdle,
  type ModdleElement
} from "bpmn-moddle";

import { executeEdit } from "./edit.js";
import {
  applyEditRequest,
  EditEngineError
} from "./edit-engine.js";
import type {
  EditOperation,
  EditRequest
} from "./edit-schema.js";
import { createSemanticModel } from "./semantic.js";

const fixtureDirectory = fileURLToPath(
  new URL("../test/fixtures/", import.meta.url)
);

function processXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_1" targetNamespace="https://example.com/acceptance">
  <bpmn:process id="Process_1">
    ${body}
  </bpmn:process>
</bpmn:definitions>`;
}

const simpleFlow = processXml(`
  <bpmn:startEvent id="Start_1" />
  <bpmn:userTask id="Task_A" name="A" />
  <bpmn:userTask id="Task_B" name="B" />
  <bpmn:endEvent id="End_1" />
  <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_A" />
  <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_A" targetRef="End_1" />
`);

async function modelFromXml(xml: string) {
  const moddle = new BpmnModdle();
  const parsed = await moddle.fromXML(xml);

  return createSemanticModel({
    definitions: parsed.rootElement,
    disabledZeebe: false,
    moddle,
    parseWarnings: parsed.warnings,
    profiles: [],
    sourceBytes: Buffer.from(xml),
    sourcePath: "memory.bpmn"
  });
}

async function assertStructureRejected(
  xml: string,
  operation: EditOperation
): Promise<void> {
  const model = await modelFromXml(xml);
  const request: EditRequest = {
    schemaVersion: "1",
    operations: [operation]
  };

  assert.throws(
    () => applyEditRequest(model, request, "a".repeat(64)),
    (error) =>
      error instanceof EditEngineError &&
      error.code === "EDIT_BPMN_STRUCTURE_INVALID"
  );
}

const structureCases: Array<{
  name: string;
  operation: EditOperation;
  xml: string;
}> = [
  {
    name: "End Events cannot source SequenceFlows",
    xml: simpleFlow,
    operation: {
      op: "replace",
      target: "Flow_2",
      path: "/sourceRef",
      value: "End_1",
      expect: [{ target: "Flow_2", path: "/sourceRef", equals: "Task_A" }]
    }
  },
  {
    name: "Start Events cannot target SequenceFlows",
    xml: simpleFlow,
    operation: {
      op: "replace",
      target: "Flow_2",
      path: "/targetRef",
      value: "Start_1",
      expect: [{ target: "Flow_2", path: "/targetRef", equals: "End_1" }]
    }
  },
  {
    name: "SequenceFlows cannot cross flow scopes",
    xml: processXml(`
      <bpmn:userTask id="Task_A" />
      <bpmn:endEvent id="End_1" />
      <bpmn:subProcess id="Sub_1">
        <bpmn:userTask id="Nested_Task" />
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="Flow_1" sourceRef="Task_A" targetRef="End_1" />
    `),
    operation: {
      op: "replace",
      target: "Flow_1",
      path: "/targetRef",
      value: "Nested_Task",
      expect: [{ target: "Flow_1", path: "/targetRef", equals: "End_1" }]
    }
  },
  {
    name: "event subprocesses cannot be SequenceFlow targets",
    xml: processXml(`
      <bpmn:userTask id="Task_A" />
      <bpmn:endEvent id="End_1" />
      <bpmn:subProcess id="Event_Sub" triggeredByEvent="true">
        <bpmn:startEvent id="Event_Start" />
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="Flow_1" sourceRef="Task_A" targetRef="End_1" />
    `),
    operation: {
      op: "replace",
      target: "Flow_1",
      path: "/targetRef",
      value: "Event_Sub",
      expect: [{ target: "Flow_1", path: "/targetRef", equals: "End_1" }]
    }
  },
  {
    name: "conditions cannot be added to a default flow",
    xml: processXml(`
      <bpmn:userTask id="Task_A" default="Flow_1" />
      <bpmn:endEvent id="End_1" />
      <bpmn:sequenceFlow id="Flow_1" sourceRef="Task_A" targetRef="End_1" />
    `),
    operation: {
      op: "add",
      target: "Flow_1",
      path: "/conditionExpression",
      value: { $type: "bpmn:FormalExpression", body: "approved" },
      expect: [{ target: "Flow_1", path: "/conditionExpression", absent: true }]
    }
  },
  {
    name: "Parallel Gateways cannot own conditions",
    xml: processXml(`
      <bpmn:parallelGateway id="Gateway_1" />
      <bpmn:endEvent id="End_1" />
      <bpmn:sequenceFlow id="Flow_1" sourceRef="Gateway_1" targetRef="End_1" />
    `),
    operation: {
      op: "add",
      target: "Flow_1",
      path: "/conditionExpression",
      value: { $type: "bpmn:FormalExpression", body: "approved" },
      expect: [{ target: "Flow_1", path: "/conditionExpression", absent: true }]
    }
  },
  {
    name: "EventBased Gateways may target only legal catch nodes",
    xml: processXml(`
      <bpmn:eventBasedGateway id="Gateway_1" />
      <bpmn:receiveTask id="Receive_1" />
      <bpmn:userTask id="Task_A" />
      <bpmn:sequenceFlow id="Flow_1" sourceRef="Gateway_1" targetRef="Receive_1" />
    `),
    operation: {
      op: "replace",
      target: "Flow_1",
      path: "/targetRef",
      value: "Task_A",
      expect: [{ target: "Flow_1", path: "/targetRef", equals: "Receive_1" }]
    }
  },
  {
    name: "EventBased Gateway targets cannot have competing incoming flows",
    xml: processXml(`
      <bpmn:startEvent id="Start_1" />
      <bpmn:eventBasedGateway id="Gateway_1" />
      <bpmn:receiveTask id="Receive_1" />
      <bpmn:userTask id="Task_A" />
      <bpmn:sequenceFlow id="Flow_1" sourceRef="Gateway_1" targetRef="Receive_1" />
      <bpmn:sequenceFlow id="Flow_2" sourceRef="Start_1" targetRef="Task_A" />
    `),
    operation: {
      op: "replace",
      target: "Flow_2",
      path: "/targetRef",
      value: "Receive_1",
      expect: [{ target: "Flow_2", path: "/targetRef", equals: "Task_A" }]
    }
  },
  {
    name: "defaults must be outgoing flows of their owner",
    xml: simpleFlow,
    operation: {
      op: "add",
      target: "Task_B",
      path: "/default",
      value: "Flow_2",
      expect: [{ target: "Task_B", path: "/default", absent: true }]
    }
  },
  {
    name: "BoundaryEvents cannot attach across scopes",
    xml: processXml(`
      <bpmn:userTask id="Task_A" />
      <bpmn:boundaryEvent id="Boundary_1" attachedToRef="Task_A">
        <bpmn:timerEventDefinition id="Timer_1" />
      </bpmn:boundaryEvent>
      <bpmn:subProcess id="Sub_1">
        <bpmn:userTask id="Nested_Task" />
      </bpmn:subProcess>
    `),
    operation: {
      op: "replace",
      target: "Boundary_1",
      path: "/attachedToRef",
      value: "Nested_Task",
      expect: [{ target: "Boundary_1", path: "/attachedToRef", equals: "Task_A" }]
    }
  },
  {
    name: "compensation BoundaryEvents cannot source SequenceFlows",
    xml: processXml(`
      <bpmn:userTask id="Task_A" />
      <bpmn:boundaryEvent id="Boundary_1" attachedToRef="Task_A">
        <bpmn:timerEventDefinition id="Timer_1" />
      </bpmn:boundaryEvent>
      <bpmn:endEvent id="End_1" />
      <bpmn:sequenceFlow id="Flow_1" sourceRef="Boundary_1" targetRef="End_1" />
    `),
    operation: {
      op: "replace",
      target: "Boundary_1",
      path: "/eventDefinitions/0",
      value: { $type: "bpmn:CompensateEventDefinition" },
      expect: [{ target: "Boundary_1", path: "/eventDefinitions", length: 1 }]
    }
  },
  {
    name: "Link throw and catch names must match",
    xml: processXml(`
      <bpmn:userTask id="Task_A" />
      <bpmn:intermediateThrowEvent id="Link_Throw">
        <bpmn:linkEventDefinition id="Link_Throw_Def" name="next" target="Link_Catch_Def" />
      </bpmn:intermediateThrowEvent>
      <bpmn:intermediateCatchEvent id="Link_Catch">
        <bpmn:linkEventDefinition id="Link_Catch_Def" name="next">
          <bpmn:source>Link_Throw_Def</bpmn:source>
        </bpmn:linkEventDefinition>
      </bpmn:intermediateCatchEvent>
      <bpmn:endEvent id="End_1" />
      <bpmn:sequenceFlow id="Flow_1" sourceRef="Task_A" targetRef="Link_Throw" />
      <bpmn:sequenceFlow id="Flow_2" sourceRef="Link_Catch" targetRef="End_1" />
    `),
    operation: {
      op: "replace",
      target: "Link_Throw_Def",
      path: "/name",
      value: "different",
      expect: [{ target: "Link_Throw_Def", path: "/name", equals: "next" }]
    }
  }
];

for (const scenario of structureCases) {
  test(`rejects invalid BPMN structure: ${scenario.name}`, async () => {
    await assertStructureRejected(scenario.xml, scenario.operation);
  });
}

test("rejects failed expectations, no-ops, forward aliases, and unsafe replacement", async () => {
  const cases: Array<{ code: string; request: EditRequest }> = [
    {
      code: "EDIT_PRECONDITION_FAILED",
      request: {
        schemaVersion: "1",
        operations: [
          {
            op: "replace",
            target: "Task_A",
            path: "/name",
            value: "Changed",
            expect: [{ target: "Task_A", path: "/name", equals: "wrong" }]
          }
        ]
      }
    },
    {
      code: "EDIT_OPERATION_NOOP",
      request: {
        schemaVersion: "1",
        operations: [
          {
            op: "replace",
            target: "Task_A",
            path: "/name",
            value: "A",
            expect: [{ target: "Task_A", path: "/name", equals: "A" }]
          }
        ]
      }
    },
    {
      code: "EDIT_TARGET_NOT_FOUND",
      request: {
        schemaVersion: "1",
        operations: [
          {
            op: "add",
            target: "Process_1",
            path: "/flowElements/-",
            value: {
              $type: "bpmn:SequenceFlow",
              sourceRef: "$future",
              targetRef: "Task_A"
            },
            expect: [{ target: "Process_1", path: "/flowElements", length: 6 }]
          }
        ]
      }
    },
    {
      code: "EXTERNAL_REFERENCE_CONFLICT",
      request: {
        schemaVersion: "1",
        operations: [
          {
            op: "replace",
            target: "Task_A",
            path: "",
            value: { $type: "bpmn:DataObjectReference" },
            expect: [{ target: "Task_A", path: "/$type", equals: "bpmn:UserTask" }]
          }
        ]
      }
    }
  ];

  for (const scenario of cases) {
    const model = await modelFromXml(simpleFlow);
    assert.throws(
      () => applyEditRequest(model, scenario.request, "b".repeat(64)),
      (error) =>
        error instanceof EditEngineError && error.code === scenario.code,
      scenario.code
    );
  }
});

test("retargets one flow without rewriting unrelated references", async () => {
  const xml = processXml(`
    <bpmn:userTask id="Task_A">
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:userTask id="Task_B">
      <bpmn:incoming>Flow_2</bpmn:incoming>
      <bpmn:outgoing>Flow_3</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:userTask id="Task_C">
      <bpmn:outgoing>Flow_4</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:endEvent id="End_1">
      <bpmn:incoming>Flow_3</bpmn:incoming>
      <bpmn:incoming>Flow_4</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_A" targetRef="Task_B" />
    <bpmn:sequenceFlow id="Flow_3" sourceRef="Task_B" targetRef="End_1" />
    <bpmn:sequenceFlow id="Flow_4" sourceRef="Task_C" targetRef="End_1" />
  `);
  const model = await modelFromXml(xml);
  const request: EditRequest = {
    schemaVersion: "1",
    operations: [
      {
        op: "replace",
        target: "Flow_2",
        path: "/targetRef",
        value: "Task_C",
        expect: [{ target: "Flow_2", path: "/targetRef", equals: "Task_B" }]
      }
    ]
  };
  const result = applyEditRequest(model, request, "c".repeat(64));
  const flow2 = model.byId.get("Flow_2");
  const flow3 = model.byId.get("Flow_3");
  const flow4 = model.byId.get("Flow_4");
  const taskB = model.byId.get("Task_B");
  const taskC = model.byId.get("Task_C");

  assert.equal(flow2?.get("targetRef"), taskC);
  assert.equal(flow3?.get("sourceRef"), taskB);
  assert.equal(flow4?.get("sourceRef"), taskC);
  assert.deepEqual(taskB?.get("incoming"), []);
  assert.deepEqual(taskB?.get("outgoing"), [flow3]);
  assert.deepEqual(taskC?.get("incoming"), [flow2]);
  assert.deepEqual(taskC?.get("outgoing"), [flow4]);
  assert.deepEqual(
    (result.operations[0]?.effects as Array<{ path: string; target: string }>)
      .map(({ path, target }) => `${target}${path}`)
      .sort(),
    ["Task_B/incoming", "Task_C/incoming"]
  );
});

async function withTemporaryFiles(
  callback: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-edit-acceptance-"));

  try {
    await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("moves contained values through preview and exact apply", async () => {
  await withTemporaryFiles(async (directory) => {
    const source = join(directory, "source.bpmn");
    const requestPath = join(directory, "request.json");
    const output = join(directory, "output.bpmn");
    const xml = processXml(`
      <bpmn:userTask id="Task_A">
        <bpmn:documentation>Move me</bpmn:documentation>
      </bpmn:userTask>
      <bpmn:userTask id="Task_B" />
    `);
    const request: EditRequest = {
      schemaVersion: "1",
      operations: [
        {
          op: "move",
          from: { target: "Task_A", path: "/documentation/0" },
          to: { target: "Task_B", path: "/documentation/-" },
          expect: [{ target: "Task_A", path: "/documentation", length: 1 }]
        }
      ]
    };
    await Promise.all([
      writeFile(source, xml),
      writeFile(requestPath, JSON.stringify(request))
    ]);
    const preview = await executeEdit([
      source,
      "--request",
      requestPath,
      "--no-layout",
      "--json"
    ]);
    const planHash = (JSON.parse(preview.output) as { planHash: string }).planHash;
    const applied = await executeEdit([
      source,
      "--request",
      requestPath,
      "--no-layout",
      "--apply",
      planHash,
      "--output",
      output,
      "--json"
    ]);
    const parsed = await new BpmnModdle().fromXML(await readFile(output, "utf8"));
    const process = parsed.rootElement.rootElements?.[0];
    const taskA = process?.flowElements?.find(({ id }) => id === "Task_A");
    const taskB = process?.flowElements?.find(({ id }) => id === "Task_B");

    assert.equal(preview.exitCode, 0, preview.output);
    assert.equal(applied.exitCode, 0, applied.output);
    assert.deepEqual(taskA?.get("documentation"), []);
    assert.equal(
      ((taskB?.get("documentation") as ModdleElement[])[0]?.get("text")),
      "Move me"
    );
  });
});

test("edits both production-like fixtures without semantic loss", async () => {
  const fixtures = [
    {
      file: "car rental booking process.bpmn",
      target: "Activity_1g8uvah",
      before: "Update car availability",
      after: "Update fleet availability"
    },
    {
      file: "AI Email Support Agent.bpmn",
      target: "Ask_a_specialist",
      before: "Ask loan specialist",
      after: "Ask support specialist"
    }
  ];

  await withTemporaryFiles(async (directory) => {
    for (const fixture of fixtures) {
      const source = join(directory, fixture.file);
      const requestPath = join(directory, `${fixture.target}.json`);
      const output = join(directory, `edited-${basename(fixture.file)}`);
      const sourceBytes = await readFile(join(fixtureDirectory, fixture.file));
      const request: EditRequest = {
        schemaVersion: "1",
        operations: [
          {
            op: "replace",
            target: fixture.target,
            path: "/name",
            value: fixture.after,
            expect: [
              { target: fixture.target, path: "/name", equals: fixture.before }
            ]
          }
        ]
      };
      await Promise.all([
        writeFile(source, sourceBytes),
        writeFile(requestPath, JSON.stringify(request))
      ]);
      const preview = await executeEdit([
        source,
        "--request",
        requestPath,
        "--no-layout",
        "--json"
      ]);
      const planHash = (JSON.parse(preview.output) as { planHash: string }).planHash;
      const applied = await executeEdit([
        source,
        "--request",
        requestPath,
        "--no-layout",
        "--apply",
        planHash,
        "--output",
        output,
        "--json"
      ]);

      assert.equal(preview.exitCode, 0, preview.output);
      assert.equal(applied.exitCode, 0, applied.output);
      assert.match(await readFile(output, "utf8"), new RegExp(fixture.after));
      assert.deepEqual(await readFile(source), sourceBytes);
    }
  });
});

test("edits data from a custom moddle descriptor", async () => {
  await withTemporaryFiles(async (directory) => {
    const descriptor = join(directory, "custom.json");
    const source = join(directory, "custom.bpmn");
    const requestPath = join(directory, "request.json");
    const output = join(directory, "output.bpmn");
    await writeFile(
      descriptor,
      JSON.stringify({
        name: "Custom",
        prefix: "custom",
        uri: "https://example.test/custom",
        xml: { tagAlias: "lowerCase" },
        types: [
          {
            name: "Property",
            superClass: ["Element"],
            properties: [{ name: "value", type: "String", isAttr: true }]
          }
        ]
      })
    );
    await writeFile(
      source,
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
    const request: EditRequest = {
      schemaVersion: "1",
      operations: [
        {
          op: "replace",
          target: "Task_Custom",
          path: "/extensionElements/values/0/value",
          value: "changed-value",
          expect: [
            {
              target: "Task_Custom",
              path: "/extensionElements/values/0/value",
              equals: "business-value"
            }
          ]
        }
      ]
    };
    await writeFile(requestPath, JSON.stringify(request));
    const common = [
      source,
      "--request",
      requestPath,
      "--extension",
      `custom=${descriptor}`,
      "--no-layout",
      "--json"
    ];
    const preview = await executeEdit(common);
    const planHash = (JSON.parse(preview.output) as { planHash: string }).planHash;
    const applied = await executeEdit([
      ...common.slice(0, -1),
      "--apply",
      planHash,
      "--output",
      output,
      "--json"
    ]);

    assert.equal(preview.exitCode, 0, preview.output);
    assert.equal(applied.exitCode, 0, applied.output);
    assert.match(await readFile(output, "utf8"), /changed-value/);
  });
});

test("rejects stale source, request, layout mode, and token casing", async () => {
  await withTemporaryFiles(async (directory) => {
    const source = join(directory, "source.bpmn");
    const requestPath = join(directory, "request.json");
    const xml = processXml('<bpmn:userTask id="Task_A" name="A" />');
    const request: EditRequest = {
      schemaVersion: "1",
      operations: [
        {
          op: "replace",
          target: "Task_A",
          path: "/name",
          value: "Changed",
          expect: [{ target: "Task_A", path: "/name", equals: "A" }]
        }
      ]
    };
    await Promise.all([
      writeFile(source, xml),
      writeFile(requestPath, JSON.stringify(request))
    ]);
    const preview = await executeEdit([
      source,
      "--request",
      requestPath,
      "--no-layout",
      "--json"
    ]);
    const planHash = (JSON.parse(preview.output) as { planHash: string }).planHash;
    const attempts: Array<{
      args: string[];
      mutate: () => Promise<void>;
      output: string;
    }> = [
      {
        args: [],
        mutate: async () => {},
        output: join(directory, "layout-stale.bpmn")
      },
      {
        args: ["--no-layout"],
        mutate: () => writeFile(source, `${xml}\n`),
        output: join(directory, "source-stale.bpmn")
      },
      {
        args: ["--no-layout"],
        mutate: async () => {
          await writeFile(source, xml);
          await writeFile(
            requestPath,
            JSON.stringify({
              ...request,
              operations: [
                {
                  ...request.operations[0],
                  value: "Changed again"
                }
              ]
            })
          );
        },
        output: join(directory, "request-stale.bpmn")
      },
      {
        args: ["--no-layout"],
        mutate: async () => {
          await writeFile(requestPath, JSON.stringify(request));
        },
        output: join(directory, "case-stale.bpmn")
      }
    ];

    for (const [index, attempt] of attempts.entries()) {
      await attempt.mutate();
      const result = await executeEdit([
        source,
        "--request",
        requestPath,
        ...attempt.args,
        "--apply",
        index === 3 ? planHash.toUpperCase() : planHash,
        "--output",
        attempt.output,
        "--json"
      ]);

      assert.equal(
        (JSON.parse(result.output) as { error: { code: string } }).error.code,
        "STALE_PLAN"
      );
      await assert.rejects(readFile(attempt.output), /ENOENT/);
    }
  });
});

test("bounds interactive edit output and writes a complete report", async () => {
  await withTemporaryFiles(async (directory) => {
    const source = join(directory, "source.bpmn");
    const requestPath = join(directory, "request.json");
    const report = join(directory, "report.json");
    const xml = processXml('<bpmn:userTask id="Task_A" />');
    const operations: EditOperation[] = Array.from(
      { length: 100 },
      (_, index) => ({
        op: "add",
        target: "Task_A",
        path: "/documentation/-",
        value: {
          $type: "bpmn:Documentation",
          text: `${index}:${"x".repeat(400)}`
        },
        expect: [
          { target: "Task_A", path: "/documentation", length: index }
        ]
      })
    );
    await Promise.all([
      writeFile(source, xml),
      writeFile(
        requestPath,
        JSON.stringify({ schemaVersion: "1", operations })
      )
    ]);
    const common = [
      source,
      "--request",
      requestPath,
      "--no-layout",
      "--json"
    ];
    const bounded = await executeEdit(common);
    const complete = await executeEdit([
      ...common,
      "--report",
      report
    ]);
    const reportJson = JSON.parse(await readFile(report, "utf8")) as {
      operations: unknown[];
    };

    assert.equal(bounded.exitCode, 1);
    assert.equal(
      (JSON.parse(bounded.output) as { error: { code: string } }).error.code,
      "OUTPUT_TOO_LARGE"
    );
    assert.equal(complete.exitCode, 0, complete.output);
    assert.equal(complete.output, "");
    assert.equal(reportJson.operations.length, 100);
    assert.ok((await readFile(report)).byteLength > 32 * 1024);
  });
});
