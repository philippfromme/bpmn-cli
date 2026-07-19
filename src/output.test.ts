import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishNewOutput } from "./output.js";

test("uses exclusive creation when hard links are unavailable", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-output-"));
  const temporary = join(directory, "output.tmp");
  const output = join(directory, "output.json");
  context.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(temporary, "published");

  const unsupportedLink: typeof import("node:fs/promises").link = async () => {
    const error = new Error("hard links are unavailable") as NodeJS.ErrnoException;
    error.code = "ENOTSUP";
    throw error;
  };

  await publishNewOutput(temporary, output, "published", unsupportedLink);

  assert.equal(await readFile(output, "utf8"), "published");
  await assert.rejects(
    publishNewOutput(temporary, output, "replacement", unsupportedLink),
    { code: "EEXIST" }
  );
  assert.equal(await readFile(output, "utf8"), "published");
});
