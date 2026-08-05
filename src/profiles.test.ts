import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  declaresNamespace,
  ProfileError,
  resolveProfiles,
  ZEEBE_NAMESPACE
} from "./profiles.js";
import { withTemporaryDirectory } from "./test-support.test.js";

test("detects namespaces only on the definitions element, ignoring comments", () => {
  assert.equal(
    declaresNamespace(
      `<!-- <bpmn:definitions xmlns:zeebe="${ZEEBE_NAMESPACE}"> -->
<bpmn:definitions xmlns:bpmn="https://example.test" xmlns:zeebe="${ZEEBE_NAMESPACE}"/>`,
      ZEEBE_NAMESPACE
    ),
    true
  );
  assert.equal(
    declaresNamespace(
      `<bpmn:definitions xmlns:bpmn="https://example.test"><bpmn:task xmlns:zeebe="${ZEEBE_NAMESPACE}"/></bpmn:definitions>`,
      ZEEBE_NAMESPACE
    ),
    false
  );
});

test("resolves explicit, detected, and disabled Zeebe profiles predictably", async () => {
  const detected = await resolveProfiles({
    autoProfile: true,
    documents: [`<bpmn:definitions xmlns:zeebe="${ZEEBE_NAMESPACE}"/>`],
    extensions: []
  });
  const explicit = await resolveProfiles({
    autoProfile: false,
    documents: [],
    extensions: [],
    profile: "zeebe"
  });
  const disabled = await resolveProfiles({
    autoProfile: false,
    documents: [`<bpmn:definitions xmlns:zeebe="${ZEEBE_NAMESPACE}"/>`],
    extensions: []
  });

  assert.equal(detected.active[0]?.source, "detected");
  assert.equal(explicit.active[0]?.source, "explicit");
  assert.equal(disabled.declaresDisabledZeebe, true);
  assert.deepEqual(disabled.active, []);
});

test("rejects malformed, duplicate, and namespace-colliding custom descriptors", async () => {
  await withTemporaryDirectory("bpmn-profiles", async (directory) => {
    const invalid = join(directory, "invalid.json");
    const collision = join(directory, "collision.json");
    const valid = join(directory, "valid.json");
    await writeFile(invalid, '{"name":"Invalid"}', "utf8");
    await writeFile(
      collision,
      JSON.stringify({
        name: "Collision",
        prefix: "bpmn",
        uri: "https://example.test/collision",
        types: []
      }),
      "utf8"
    );
    await writeFile(
      valid,
      JSON.stringify({
        name: "Acme",
        prefix: "acme",
        uri: "https://example.test/acme",
        types: [{ name: "Settings", properties: [] }]
      }),
      "utf8"
    );

    await assert.rejects(
      resolveProfiles({ autoProfile: false, documents: [], extensions: ["invalid"] }),
      (error: unknown) => error instanceof ProfileError && error.exitCode === 1
    );
    await assert.rejects(
      resolveProfiles({
        autoProfile: false,
        documents: [],
        extensions: [`acme=${invalid}`]
      }),
      (error: unknown) => error instanceof ProfileError && error.exitCode === 3
    );
    await assert.rejects(
      resolveProfiles({
        autoProfile: false,
        documents: [],
        extensions: [`collision=${collision}`]
      }),
      (error: unknown) => error instanceof ProfileError && error.exitCode === 3
    );
    await assert.rejects(
      resolveProfiles({
        autoProfile: false,
        documents: [],
        extensions: [`acme=${valid}`, `acme=${valid}`]
      }),
      (error: unknown) => error instanceof ProfileError && error.exitCode === 3
    );
  });
});
