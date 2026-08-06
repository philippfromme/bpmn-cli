import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Bpmn } from "./index.js";
import { loadSemanticModel } from "./model-loader.js";
import { withTemporaryDirectory } from "./test-support.test.js";

const fixture = fileURLToPath(
  new URL(
    "../test/fixtures/blueprint.bank-customer-complaint-dispute-handling.bpmn",
    import.meta.url
  )
);

async function supportedFixture(directory: string): Promise<string> {
  const path = join(directory, "bank-complaint.bpmn");
  const source = await readFile(fixture, "utf8");
  await writeFile(
    path,
    source.replace(/\s+camunda:diagramRelationId="[^"]*"/g, ""),
    "utf8"
  );
  return path;
}

test("loads collaborations, message flows, nested scopes, gateways, and boundary handlers", async () => {
  await withTemporaryDirectory("bpmn-collaboration-load", async (directory) => {
    const model = await loadSemanticModel({
      autoProfile: true,
      extensions: [],
      file: await supportedFixture(directory)
    });
    const types = model.allElements.map((element) => element.$type);

    for (const id of [
      "Collaboration_1qr2ldp",
      "Flow_05gvfe6",
      "Activity_02tn153",
      "Activity_07yih62",
      "Event_10q75mf",
      "TimerEventDefinition_1o16v25",
      "Gateway_0vlbih2"
    ]) {
      assert.ok(model.byId.has(id), `${id} must be addressable`);
    }
    assert.ok(types.includes("bpmn:Collaboration"));
    assert.ok(types.includes("bpmn:MessageFlow"));
    assert.ok(types.includes("bpmn:SubProcess"));
    assert.ok(types.includes("bpmn:BoundaryEvent"));
    assert.ok(types.includes("bpmn:ExclusiveGateway"));
    assert.deepEqual(model.diagnostics, []);
  });
});

test("round-trips a complex collaboration without altering business semantics", async () => {
  await withTemporaryDirectory("bpmn-collaboration-roundtrip", async (directory) => {
    const source = await supportedFixture(directory);
    const original = await loadSemanticModel({
      autoProfile: true,
      extensions: [],
      file: source
    });
    const fluent = await Bpmn.open(source);
    const temporary = join(directory, "roundtrip.bpmn");
    const result = await fluent.write({
      layout: "none",
      output: temporary
    });
    const roundTripped = await loadSemanticModel({
      autoProfile: true,
      extensions: [],
      file: temporary
    });

    assert.equal(result.semanticHash, original.semanticHash);
    assert.equal(roundTripped.semanticHash, original.semanticHash);
    assert.equal(
      (await readFile(temporary, "utf8")).includes("bpmndi:BPMNDiagram"),
      false
    );
  });
});
