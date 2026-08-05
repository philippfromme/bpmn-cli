import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { BpmnModel } from "./index.js";
import {
  expectModelError,
  isModdleElement,
  moddleElements,
  withTemporaryDirectory,
  writeBpmn,
  ZEEBE_NAMESPACE
} from "./test-support.test.js";

test("ensures one I/O mapping, retains inputs, and rejects invalid input values", async () => {
  const model = await BpmnModel.create();
  const process = model.process();
  const task = model.create("bpmn:UserTask", {});
  model.append(process, task, "flowElements");
  const mapping = task.extensions.ensure("zeebe:IoMapping");
  mapping.addInput({ source: "=customer.id", target: "customerId" });
  task.extensions.ensure("zeebe:IoMapping").addInput({
    source: "=customer.name",
    target: "customerName"
  });

  expectModelError("INVALID_EXTENSION", () =>
    mapping.addInput({ source: "", target: "customerId" })
  );
  expectModelError("INVALID_EXTENSION", () =>
    mapping.addInput({ source: "=customer.id", target: "" })
  );

  const extensionElements = task.raw.get("extensionElements");
  assert.ok(isModdleElement(extensionElements));
  const values = moddleElements(extensionElements.get("values"));
  assert.equal(values.filter((value) => value.$type === "zeebe:IoMapping").length, 1);
  assert.deepEqual(
    moddleElements(values[0]?.get("inputParameters")).map((input) => [
      input.get("source"),
      input.get("target")
    ]),
    [
      ["=customer.id", "customerId"],
      ["=customer.name", "customerName"]
    ]
  );
});

test("allows I/O mappings only on Zeebe-supported BPMN elements", async () => {
  const model = await BpmnModel.create();
  const process = model.process();
  const task = model.create("bpmn:Task", {});
  const serviceTask = model.create("bpmn:ServiceTask", {});
  model.append(process, task, "flowElements");
  model.append(process, serviceTask, "flowElements");

  expectModelError("INVALID_EXTENSION", () =>
    task.extensions.ensure("zeebe:IoMapping")
  );
  serviceTask.extensions.ensure("zeebe:IoMapping").addInput({
    source: "=order.id",
    target: "orderId"
  });
  const extensionElements = serviceTask.raw.get("extensionElements");
  assert.ok(isModdleElement(extensionElements));
  assert.equal(moddleElements(extensionElements.get("values"))[0]?.$type, "zeebe:IoMapping");
});

test("configures forms only on user tasks and retains existing form properties", async () => {
  const model = await BpmnModel.create();
  const process = model.process();
  const userTask = model.create("bpmn:UserTask", {});
  const serviceTask = model.create("bpmn:ServiceTask", {});
  model.append(process, userTask, "flowElements");
  model.append(process, serviceTask, "flowElements");

  userTask.configureForm({ formId: "customer-form", formKey: "=customer.form" });
  userTask.configureForm({ externalReference: "forms/customer.json" });
  expectModelError("INVALID_FORM", () =>
    serviceTask.configureForm({ formId: "not-allowed" })
  );

  const extensionElements = userTask.raw.get("extensionElements");
  assert.ok(isModdleElement(extensionElements));
  const form = moddleElements(extensionElements.get("values"))[0];
  assert.equal(form?.$type, "zeebe:FormDefinition");
  assert.equal(form?.get("formId"), "customer-form");
  assert.equal(form?.get("formKey"), "=customer.form");
  assert.equal(form?.get("externalReference"), "forms/customer.json");
});

test("validates descriptor-backed custom extension construction and nested containment", async () => {
  await withTemporaryDirectory("bpmn-custom-extension", async (directory) => {
    const descriptor = join(directory, "acme.json");
    await writeFile(
      descriptor,
      JSON.stringify({
        name: "Acme",
        prefix: "acme",
        uri: "https://example.test/acme",
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
    const source = await writeBpmn(
      directory,
      "model.bpmn",
      '  <bpmn:process id="Process_1"><bpmn:task id="Task_1"/></bpmn:process>'
    );
    const model = await BpmnModel.open(source, { extensions: [`acme=${descriptor}`] });
    const settings = model.element("Task_1").extensions.ensureCustom(
      "acme:Settings",
      { priority: "normal" }
    );
    settings.set("priority", "high").append("rules", "acme:Rule", { name: "one" });

    expectModelError("INVALID_EXTENSION", () =>
      model.createCustom("missing:Settings")
    );
    expectModelError("INVALID_EXTENSION", () =>
      settings.set("unknown", "value")
    );
    expectModelError("INVALID_CONTAINMENT", () =>
      settings.append("priority", "acme:Rule", { name: "two" })
    );

    const output = join(directory, "output.bpmn");
    await model.publish({ layout: "none", output });
    const xml = await readFile(output, "utf8");
    assert.match(xml, /acme:Settings priority="high"/);
    assert.match(xml, /acme:Rule name="one"/);
  });
});

test("opens declared Zeebe extensions automatically", async () => {
  await withTemporaryDirectory("bpmn-zeebe-profile", async (directory) => {
    const source = await writeBpmn(
      directory,
      "model.bpmn",
      '  <bpmn:process id="Process_1"><bpmn:userTask id="Task_1"/></bpmn:process>',
      ` xmlns:zeebe="${ZEEBE_NAMESPACE}"`
    );
    const model = await BpmnModel.open(source);
    model.element("Task_1").extensions.ensure("zeebe:IoMapping").addInput({
      source: "=customer.id",
      target: "customerId"
    });
    const extensionElements = model.element("Task_1").raw.get("extensionElements");
    assert.ok(isModdleElement(extensionElements));
    assert.equal(
      moddleElements(extensionElements.get("values"))[0]?.$type,
      "zeebe:IoMapping"
    );
  });
});
