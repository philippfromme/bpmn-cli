import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Bpmn } from "./index.js";
import { loadSemanticModel } from "./model-loader.js";
import { withTemporaryDirectory } from "./test-support.test.js";

const fixtureDirectory = fileURLToPath(
  new URL("../test/fixtures", import.meta.url)
);

async function blueprintFixtures(): Promise<string[]> {
  const fixtures = (await readdir(fixtureDirectory))
    .filter((name) => name.startsWith("blueprint.") && name.endsWith(".bpmn"))
    .sort();

  assert.ok(fixtures.length > 0, "The blueprint fixture corpus must not be empty");
  return fixtures.map((name) => join(fixtureDirectory, name));
}

async function copyBpmnAndZeebeFixture(
  fixture: string,
  directory: string
): Promise<string> {
  const contents = await readFile(fixture, "utf8");
  const supportedContents = contents
    .replace(/\s+camunda:diagramRelationId="[^"]*"/g, "")
    .replace(/\s+bioc:[\w-]+="[^"]*"/g, "")
    .replace(/\s+color:[\w-]+="[^"]*"/g, "");
  const output = join(directory, basename(fixture));
  await writeFile(output, supportedContents, "utf8");
  return output;
}

test("round-trips BPMN and Zeebe semantics from every blueprint fixture", async () => {
  const fixtures = await blueprintFixtures();

  await withTemporaryDirectory("bpmn-blueprint-roundtrip", async (directory) => {
    for (const fixture of fixtures) {
      const source = await copyBpmnAndZeebeFixture(fixture, directory);
      const original = await loadSemanticModel({
        autoProfile: true,
        extensions: [],
        file: source
      });
      const output = join(directory, `roundtrip-${basename(source)}`);
      const model = await Bpmn.open(source);
      const result = await model.write({ layout: "none", output });
      const roundTripped = await loadSemanticModel({
        autoProfile: true,
        extensions: [],
        file: output
      });

      assert.equal(
        result.semanticHash,
        original.semanticHash,
        `${fixture} write result must preserve semantics`
      );
      assert.equal(
        roundTripped.semanticHash,
        original.semanticHash,
        `${fixture} round-trip must preserve semantics`
      );
    }
  });
});

test("edits nested Zeebe properties in a representative blueprint fixture", async () => {
  await withTemporaryDirectory("bpmn-blueprint-edit", async (directory) => {
    const source = await copyBpmnAndZeebeFixture(
      join(fixtureDirectory, "blueprint.ai-email-support-agent.bpmn"),
      directory
    );
    const output = join(directory, "edited.bpmn");
    const model = await Bpmn.open(source);
    const task = model.element<"bpmn:ServiceTask">("Reply_with_email_to_customer");
    const extensions = task.child("extensionElements");
    const definition = extensions
      .children<"zeebe:TaskDefinition">("values")
      .find((element) => element.type === "zeebe:TaskDefinition");

    assert.ok(definition, "fixture task must have a Zeebe task definition");
    task.setName("Send customer reply");
    definition.setProperties({ retries: "5" });
    await model.write({ layout: "none", output });

    const reopened = await Bpmn.open(output);
    const editedTask = reopened.element<"bpmn:ServiceTask">(
      "Reply_with_email_to_customer"
    );
    const editedDefinition = editedTask
      .child("extensionElements")
      .children<"zeebe:TaskDefinition">("values")
      .find((element) => element.type === "zeebe:TaskDefinition");

    assert.equal(editedTask.name, "Send customer reply");
    assert.equal(editedDefinition?.raw.get("retries"), "5");
  });
});
