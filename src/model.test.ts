import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BpmnModel, ModelApiError } from "./index.js";
import { ModelLoadError } from "./model-loader.js";
import { ModelPublicationError } from "./model-runtime.js";
import { loadSemanticModel } from "./model-loader.js";
import {
  isSupportedElementType,
  type ElementProperties
} from "./model-types.js";

const zeebeFixture = fileURLToPath(
  new URL("../test/fixtures/AI Email Support Agent.bpmn", import.meta.url)
);

async function withTemporaryDirectory(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-model-"));

  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("creates and publishes a customer-email model with native form and Zeebe I/O", async () => {
  await withTemporaryDirectory(async (directory) => {
    const output = join(directory, "customer-email.bpmn");
    const model = await BpmnModel.create();
    const process = model.process({ name: "Customer email" });
    const task = model.create("bpmn:UserTask", { name: "Send customer email" });
    model.append(process, task, "flowElements");
    task.configureForm({ formId: "customer-email" });
    task.extensions.ensure("zeebe:IoMapping").addInput({
      source: "=customer.email",
      target: "email"
    });

    const publication = await model.publish({
      layout: "none",
      output,
      validate: true
    });
    const xml = await readFile(output, "utf8");

    assert.equal(publication.status, "written");
    assert.match(xml, /zeebe:formDefinition formId="customer-email"/);
    assert.match(
      xml,
      /zeebe:input source="=customer\.email" target="email"/
    );
    assert.equal((await BpmnModel.open(output)).element(task.id).name, "Send customer email");
  });
});

test("uses deterministic layout by default during publication", async () => {
  await withTemporaryDirectory(async (directory) => {
    const output = join(directory, "laid-out.bpmn");
    const model = await BpmnModel.create();
    const process = model.process();
    const start = model.create("bpmn:StartEvent", {});
    const task = model.create("bpmn:Task", { name: "Send email" });
    const end = model.create("bpmn:EndEvent", {});
    model.append(process, start, "flowElements");
    model.append(process, task, "flowElements");
    model.append(process, end, "flowElements");
    model.connect(start, task);
    model.connect(task, end);

    await model.publish({ output });

    assert.match(await readFile(output, "utf8"), /bpmndi:BPMNDiagram/);
  });
});

test("adds nested Zeebe I/O mappings to an existing task without replacing extensions", async () => {
  await withTemporaryDirectory(async (directory) => {
    const source = join(directory, "source.bpmn");
    const output = join(directory, "edited.bpmn");
    await writeFile(
      source,
      `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:userTask id="ServiceTask_1" name="Collect customer"/>
  </bpmn:process>
</bpmn:definitions>`,
      "utf8"
    );
    const model = await BpmnModel.open(source);
    model.element("ServiceTask_1").extensions.ensure("zeebe:IoMapping").addInput({
      source: "xyz",
      target: "customerId"
    });
    await model.publish({ layout: "none", output, validate: true });

    const xml = await readFile(output, "utf8");
    assert.match(xml, /zeebe:ioMapping/);
    assert.match(xml, /zeebe:input source="xyz" target="customerId"/);
  });
});

test("maintains sequence-flow reciprocal references while rewiring and removing", async () => {
  const model = await BpmnModel.create();
  const process = model.process();
  const first = model.create("bpmn:Task", {});
  const second = model.create("bpmn:Task", {});
  const replacement = model.create("bpmn:Task", {});
  model.append(process, first, "flowElements");
  model.append(process, second, "flowElements");
  model.append(process, replacement, "flowElements");
  const flow = model.connect(first, second);

  model.rewire(flow, { target: replacement });
  assert.deepEqual(second.raw.incoming, []);
  assert.deepEqual(replacement.raw.incoming, [flow.raw]);

  model.remove(flow);
  assert.deepEqual(first.raw.outgoing, []);
  assert.deepEqual(replacement.raw.incoming, []);
});

test("reserves generated IDs for unattached elements", async () => {
  const model = await BpmnModel.create();
  const deferred = model.create("bpmn:Task", {});

  model.process();
  const later = model.create("bpmn:Task", {});

  assert.equal(deferred.id, "Task_1");
  assert.equal(later.id, "Task_2");
});

test("rejects wrappers from another model without mutating either graph", async () => {
  const firstModel = await BpmnModel.create();
  const firstProcess = firstModel.process();
  const firstTask = firstModel.create("bpmn:Task", {});
  firstModel.append(firstProcess, firstTask, "flowElements");
  const secondModel = await BpmnModel.create();
  const secondTask = secondModel.create("bpmn:Task", {});

  const expectsForeignElement = (operation: () => void): void => {
    assert.throws(
      operation,
      (error: unknown) =>
        error instanceof ModelApiError && error.code === "FOREIGN_ELEMENT"
    );
  };

  expectsForeignElement(() =>
    firstModel.append(firstProcess, secondTask, "flowElements")
  );
  expectsForeignElement(() => firstModel.connect(firstTask, secondTask));
  expectsForeignElement(() => firstModel.remove(secondTask));
  assert.deepEqual(firstProcess.raw.flowElements, [firstTask.raw]);
  assert.equal(secondTask.raw.$parent, undefined);
});

test("excludes descriptor traits from constructible types while merging trait fields", () => {
  const serviceTask: ElementProperties<"bpmn:ServiceTask"> = {
    retryCounter: "3"
  };

  assert.equal(serviceTask.retryCounter, "3");
  assert.equal(isSupportedElementType("zeebe:ZeebeServiceTask"), false);
});

test("rejects ambiguous lookup and in-use element removal", async () => {
  const model = await BpmnModel.create();
  const process = model.process();
  const first = model.create("bpmn:Task", {});
  const second = model.create("bpmn:Task", {});
  model.append(process, first, "flowElements");
  model.append(process, second, "flowElements");
  model.connect(first, second);

  assert.throws(
    () => model.element("missing"),
    (error: unknown) => error instanceof ModelApiError && error.code === "ELEMENT_NOT_FOUND"
  );
  assert.throws(
    () => model.remove(first),
    (error: unknown) => error instanceof ModelApiError && error.code === "ELEMENT_REFERENCED"
  );
});

test("publishes loaded custom extension descriptors without JSON Pointer mutation", async () => {
  await withTemporaryDirectory(async (directory) => {
    const descriptor = join(directory, "acme.json");
    const source = join(directory, "source.bpmn");
    const output = join(directory, "edited.bpmn");
    await writeFile(
      descriptor,
      JSON.stringify({
        name: "Acme",
        prefix: "acme",
        uri: "https://example.com/acme",
        types: [
          {
            name: "Settings",
            superClass: ["Element"],
            properties: [
              { name: "priority", type: "String", isAttr: true },
              { name: "rules", type: "Rule", isMany: true }
            ]
          },
          {
            name: "Rule",
            superClass: ["Element"],
            properties: [{ name: "name", type: "String", isAttr: true }]
          }
        ]
      }),
      "utf8"
    );
    await writeFile(
      source,
      `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:acme="https://example.com/acme"
  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1"><bpmn:task id="Task_1"/></bpmn:process>
</bpmn:definitions>`,
      "utf8"
    );
    const model = await BpmnModel.open(source, {
      extensions: [`acme=${descriptor}`]
    });
    const settings = model.element("Task_1").extensions.ensureCustom(
      "acme:Settings",
      { priority: "high" }
    );
    settings.append("rules", "acme:Rule", { name: "customer" });
    await model.publish({ layout: "none", output, validate: true });

    const xml = await readFile(output, "utf8");
    assert.match(xml, /acme:Settings priority="high"/);
    assert.match(xml, /acme:Rule name="customer"/);
  });
});

test("refuses publication when extension data has no loaded descriptor", async () => {
  await withTemporaryDirectory(async (directory) => {
    const source = join(directory, "unsupported.bpmn");
    const output = join(directory, "edited.bpmn");
    await writeFile(
      source,
      `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:acme="https://example.com/acme"
  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1"><bpmn:task id="Task_1">
    <bpmn:extensionElements><acme:settings priority="high"/></bpmn:extensionElements>
  </bpmn:task></bpmn:process>
</bpmn:definitions>`,
      "utf8"
    );

    const model = await BpmnModel.open(source);
    await assert.rejects(
      model.publish({ layout: "none", output }),
      (error: unknown) =>
        error instanceof ModelPublicationError &&
        error.code === "UNSUPPORTED_EXTENSION_DATA"
    );
  });
});

test("rejects malformed extension XML while opening a model", async () => {
  await withTemporaryDirectory(async (directory) => {
    const source = join(directory, "malformed.bpmn");
    await writeFile(
      source,
      `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="Process_1"><bpmn:task id="Task_1">
    <bpmn:extensionElements><acme:settings>
  </bpmn:task></bpmn:process>
</bpmn:definitions>`,
      "utf8"
    );

    await assert.rejects(
      BpmnModel.open(source),
      (error: unknown) =>
        error instanceof ModelLoadError && error.code === "BPMN_PARSE_FAILED"
    );
  });
});

test("preserves existing output when atomic publication rejects replacement", async () => {
  await withTemporaryDirectory(async (directory) => {
    const output = join(directory, "existing.bpmn");
    await writeFile(output, "unchanged", "utf8");
    const model = await BpmnModel.create();
    model.process();

    await assert.rejects(
      model.publish({ layout: "none", output }),
      (error: unknown) =>
        error instanceof ModelPublicationError &&
        error.code === "OUTPUT_WRITE_FAILED"
    );
    assert.equal(await readFile(output, "utf8"), "unchanged");
  });
});

test("preserves semantic hashes when replacing only DI", async () => {
  await withTemporaryDirectory(async (directory) => {
    const output = join(directory, "without-di.bpmn");
    const before = await loadSemanticModel({
      autoProfile: true,
      extensions: [],
      file: zeebeFixture
    });
    const model = await BpmnModel.open(zeebeFixture);
    const publication = await model.publish({ layout: "none", output });
    const after = await loadSemanticModel({
      autoProfile: true,
      extensions: [],
      file: output
    });

    assert.equal(publication.semanticHash, before.semanticHash);
    assert.equal(after.semanticHash, before.semanticHash);
  });
});
