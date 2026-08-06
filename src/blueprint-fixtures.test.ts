import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BpmnModel } from "./index.js";
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
      const model = await BpmnModel.open(source);
      const publication = await model.publish({ layout: "none", output });
      const roundTripped = await loadSemanticModel({
        autoProfile: true,
        extensions: [],
        file: output
      });

      assert.equal(
        publication.semanticHash,
        original.semanticHash,
        `${fixture} publication must preserve semantics`
      );
      assert.equal(
        roundTripped.semanticHash,
        original.semanticHash,
        `${fixture} round-trip must preserve semantics`
      );
    }
  });
});
