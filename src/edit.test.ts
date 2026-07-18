import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BpmnModdle } from "bpmn-moddle";

import { executeEdit } from "./edit.js";
import {
  applyEditRequest,
  canonicalJson,
  EditEngineError
} from "./edit-engine.js";
import type { EditRequest } from "./edit-schema.js";
import { createSemanticModel } from "./semantic.js";

const sourceXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  id="Definitions_1" targetNamespace="https://example.com/edit">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:userTask id="Task_A" name="Original A">
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:userTask id="Task_B" name="Original B" />
    <bpmn:endEvent id="End_1">
      <bpmn:incoming>Flow_2</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_A" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_A" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>
`;

const splitRequest: EditRequest = {
  schemaVersion: "1",
  operations: [
    {
      op: "add",
      target: "Process_1",
      path: "/flowElements/-",
      value: {
        $type: "bpmn:UserTask",
        name: "Review"
      },
      as: "$review",
      expect: [
        { target: "Process_1", path: "/flowElements", length: 6 }
      ]
    },
    {
      op: "replace",
      target: "Flow_1",
      path: "/targetRef",
      value: "$review",
      expect: [
        { target: "Flow_1", path: "/targetRef", equals: "Task_A" }
      ]
    },
    {
      op: "add",
      target: "Process_1",
      path: "/flowElements/-",
      value: {
        $type: "bpmn:SequenceFlow",
        sourceRef: "$review",
        targetRef: "Task_A"
      },
      as: "$reviewFlow",
      expect: [
        { target: "Process_1", path: "/flowElements", length: 7 }
      ]
    }
  ]
};

async function withFiles(
  callback: (paths: { source: string; request: string; output: string }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-edit-"));
  const paths = {
    source: join(directory, "source.bpmn"),
    request: join(directory, "request.json"),
    output: join(directory, "output.bpmn")
  };

  try {
    await Promise.all([
      writeFile(paths.source, sourceXml),
      writeFile(paths.request, JSON.stringify(splitRequest))
    ]);
    await callback(paths);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("discovers the strict Edit v1 schema", async () => {
  const result = await executeEdit(["--schema", "--json"]);
  const schema = JSON.parse(result.output) as Record<string, unknown>;

  assert.equal(result.exitCode, 0);
  assert.equal(
    schema.$id,
    "https://github.com/bpmn-io/bpmn-cli/schema/edit-request-v1.schema.json"
  );
});

test("previews deterministically without writing and applies the exact plan", async () => {
  await withFiles(async ({ source, request, output }) => {
    const before = await readFile(source, "utf8");
    const args = [source, "--request", request, "--no-layout", "--json"];
    const first = await executeEdit(args);
    const second = await executeEdit(args);
    const preview = JSON.parse(first.output) as {
      operations: Array<{ effects: unknown[]; resolvedId?: string }>;
      planHash: string;
      status: string;
    };

    assert.equal(first.exitCode, 0, first.output);
    assert.equal(second.output, first.output);
    assert.equal(preview.status, "preview");
    assert.match(preview.planHash, /^[a-f0-9]{64}$/);
    assert.match(preview.operations[0]?.resolvedId ?? "", /^UserTask_/);
    assert.ok((preview.operations[1]?.effects.length ?? 0) >= 2);
    assert.equal(await readFile(source, "utf8"), before);

    const applied = await executeEdit([
      source,
      "--request",
      request,
      "--no-layout",
      "--apply",
      preview.planHash,
      "--output",
      output,
      "--json"
    ]);
    const envelope = JSON.parse(applied.output) as { status: string };
    const xml = await readFile(output, "utf8");
    const parsed = await new BpmnModdle().fromXML(xml);
    const process = parsed.rootElement.rootElements?.[0];
    const review = process?.flowElements?.find(
      (element) => element.name === "Review"
    );
    const flow1 = process?.flowElements?.find(
      (element) => element.id === "Flow_1"
    );

    assert.equal(applied.exitCode, 0, applied.output);
    assert.equal(envelope.status, "written");
    assert.doesNotMatch(xml, /<bpmndi:/);
    assert.equal(flow1?.get("targetRef"), review);
    assert.equal(await readFile(source, "utf8"), before);
  });
});

test("rejects a stale plan without publishing", async () => {
  await withFiles(async ({ source, request, output }) => {
    const result = await executeEdit([
      source,
      "--request",
      request,
      "--no-layout",
      "--apply",
      "0".repeat(64),
      "--output",
      output,
      "--json"
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(
      (JSON.parse(result.output) as { error: { code: string } }).error.code,
      "STALE_PLAN"
    );
    await assert.rejects(readFile(output), /ENOENT/);
  });
});

test("does not publish a success report when BPMN publication fails", async () => {
  await withFiles(async ({ source, request, output }) => {
    const preview = await executeEdit([
      source,
      "--request",
      request,
      "--no-layout",
      "--json"
    ]);
    const planHash = (JSON.parse(preview.output) as { planHash: string }).planHash;
    const report = `${output}.json`;
    await writeFile(output, "occupied");

    const result = await executeEdit([
      source,
      "--request",
      request,
      "--no-layout",
      "--apply",
      planHash,
      "--output",
      output,
      "--report",
      report,
      "--json"
    ]);

    assert.equal(result.exitCode, 2);
    assert.equal(await readFile(output, "utf8"), "occupied");
    await assert.rejects(readFile(report), /ENOENT/);
  });
});

test("executes add, move, replace, and remove through descriptors", async () => {
  const moddle = new BpmnModdle();
  const parsed = await moddle.fromXML(sourceXml);
  const model = createSemanticModel({
    definitions: parsed.rootElement,
    disabledZeebe: false,
    moddle,
    parseWarnings: parsed.warnings,
    profiles: [],
    sourceBytes: Buffer.from(sourceXml),
    sourcePath: "memory.bpmn"
  });
  const request: EditRequest = {
    schemaVersion: "1",
    operations: [
      {
        op: "add",
        target: "Task_A",
        path: "/documentation/-",
        value: { $type: "bpmn:Documentation", text: "Agent note" },
        as: "$note",
        expect: [{ target: "Task_A", path: "/documentation", length: 0 }]
      },
      {
        op: "move",
        from: { target: "Task_A", path: "/documentation/0" },
        to: { target: "Task_B", path: "/documentation/-" },
        expect: [{ target: "Task_A", path: "/documentation", length: 1 }]
      },
      {
        op: "replace",
        target: "Task_A",
        path: "/name",
        value: "Changed A",
        expect: [{ target: "Task_A", path: "/name", equals: "Original A" }]
      },
      {
        op: "remove",
        target: "Task_B",
        path: "/name",
        expect: [{ target: "Task_B", path: "/name", equals: "Original B" }]
      }
    ]
  };
  const result = applyEditRequest(
    model,
    request,
    canonicalJson(request).padEnd(64, "0").slice(0, 64)
  );
  const taskA = model.byId.get("Task_A");
  const taskB = model.byId.get("Task_B");

  assert.equal(result.operations.length, 4);
  assert.equal(taskA?.name, "Changed A");
  assert.equal(taskB?.name, undefined);
  assert.equal((taskA?.get("documentation") as unknown[]).length, 0);
  assert.equal((taskB?.get("documentation") as unknown[]).length, 1);
});

test("uses layout by default and rejects invalid requests", async () => {
  await withFiles(async ({ source, request, output }) => {
    const preview = await executeEdit([
      source,
      "--request",
      request,
      "--json"
    ]);
    const previewEnvelope = JSON.parse(preview.output) as {
      layout: string;
      planHash: string;
    };

    assert.equal(preview.exitCode, 0, preview.output);
    assert.equal(previewEnvelope.layout, "auto");

    const applied = await executeEdit([
      source,
      "--request",
      request,
      "--apply",
      previewEnvelope.planHash,
      "--output",
      output,
      "--json"
    ]);
    const laidOutXml = await readFile(output, "utf8");

    assert.equal(applied.exitCode, 0, applied.output);
    assert.match(laidOutXml, /<bpmndi:BPMNDiagram/);
    assert.match(laidOutXml, /<bpmndi:BPMNShape/);

    await writeFile(request, JSON.stringify({ schemaVersion: "1", operations: [] }));
    const invalid = await executeEdit([
      source,
      "--request",
      request,
      "--json"
    ]);

    assert.equal(invalid.exitCode, 1);
    assert.equal(
      (JSON.parse(invalid.output) as { error: { code: string } }).error.code,
      "EDIT_REQUEST_SCHEMA_INVALID"
    );
  });
});

test("replaces an element type while preserving its ID and references", async () => {
  await withFiles(async ({ source, request }) => {
    const replacement: EditRequest = {
      schemaVersion: "1",
      operations: [
        {
          op: "replace",
          target: "Task_A",
          path: "",
          value: {
            $type: "bpmn:ServiceTask",
            name: "Automated A"
          },
          as: "$service",
          expect: [
            { target: "Task_A", path: "/$type", equals: "bpmn:UserTask" }
          ]
        }
      ]
    };
    await writeFile(request, JSON.stringify(replacement));
    const result = await executeEdit([
      source,
      "--request",
      request,
      "--no-layout",
      "--json"
    ]);
    const envelope = JSON.parse(result.output) as {
      operations: Array<{ effects: unknown[]; resolvedId: string }>;
    };

    assert.equal(result.exitCode, 0, result.output);
    assert.equal(envelope.operations[0]?.resolvedId, "Task_A");
    assert.ok((envelope.operations[0]?.effects.length ?? 0) >= 2);
  });
});

test("creates and preserves Zeebe extension elements generically", async () => {
  await withFiles(async ({ source, request }) => {
    const zeebeXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  id="Definitions_Zeebe" targetNamespace="https://example.com/zeebe">
  <bpmn:process id="Process_Zeebe">
    <bpmn:serviceTask id="Task_InvokeWorker" />
  </bpmn:process>
</bpmn:definitions>`;
    const zeebeRequest: EditRequest = {
      schemaVersion: "1",
      operations: [
        {
          op: "add",
          target: "Task_InvokeWorker",
          path: "/extensionElements",
          value: {
            $type: "bpmn:ExtensionElements",
            values: [
              {
                $type: "zeebe:TaskDefinition",
                type: "payment-worker",
                retries: "3"
              }
            ]
          },
          expect: [
            {
              target: "Task_InvokeWorker",
              path: "/extensionElements",
              absent: true
            }
          ]
        }
      ]
    };
    await Promise.all([
      writeFile(source, zeebeXml),
      writeFile(request, JSON.stringify(zeebeRequest))
    ]);
    const result = await executeEdit([
      source,
      "--request",
      request,
      "--no-layout",
      "--json"
    ]);
    const envelope = JSON.parse(result.output) as {
      profiles: Array<{ descriptorSha256: string; name: string }>;
    };

    assert.equal(result.exitCode, 0, result.output);
    assert.equal(envelope.profiles[0]?.name, "zeebe");
    assert.match(envelope.profiles[0]?.descriptorSha256 ?? "", /^[a-f0-9]{64}$/);
  });
});

test("clears reciprocal indexes and defaults when removing a SequenceFlow", async () => {
  const xml = sourceXml.replace(
    'id="Task_A" name="Original A"',
    'id="Task_A" name="Original A" default="Flow_2"'
  );
  const moddle = new BpmnModdle();
  const parsed = await moddle.fromXML(xml);
  const model = createSemanticModel({
    definitions: parsed.rootElement,
    disabledZeebe: false,
    moddle,
    parseWarnings: parsed.warnings,
    profiles: [],
    sourceBytes: Buffer.from(xml),
    sourcePath: "memory.bpmn"
  });
  const request: EditRequest = {
    schemaVersion: "1",
    operations: [
      {
        op: "remove",
        target: "Flow_2",
        path: "",
        expect: [{ target: "Task_A", path: "/default", equals: "Flow_2" }]
      }
    ]
  };
  const result = applyEditRequest(model, request, "a".repeat(64));
  const task = model.byId.get("Task_A");
  const end = model.byId.get("End_1");

  assert.equal(task?.get("default"), undefined);
  assert.deepEqual(task?.get("outgoing"), []);
  assert.deepEqual(end?.get("incoming"), []);
  assert.ok(
    (result.operations[0]?.effects as unknown[]).some(
      (effect) => (effect as { path: string }).path === "/default"
    )
  );
});

test("rejects structurally illegal SequenceFlow endpoints", async () => {
  const moddle = new BpmnModdle();
  const parsed = await moddle.fromXML(sourceXml);
  const model = createSemanticModel({
    definitions: parsed.rootElement,
    disabledZeebe: false,
    moddle,
    parseWarnings: parsed.warnings,
    profiles: [],
    sourceBytes: Buffer.from(sourceXml),
    sourcePath: "memory.bpmn"
  });
  const request: EditRequest = {
    schemaVersion: "1",
    operations: [
      {
        op: "replace",
        target: "Flow_2",
        path: "/sourceRef",
        value: "End_1",
        expect: [{ target: "Flow_2", path: "/sourceRef", equals: "Task_A" }]
      }
    ]
  };

  assert.throws(
    () => applyEditRequest(model, request, "b".repeat(64)),
    (error) =>
      error instanceof EditEngineError &&
      error.code === "EDIT_BPMN_STRUCTURE_INVALID"
  );
});
