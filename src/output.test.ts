import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeNewOutput } from "./output.js";

test("uses exclusive creation when hard links are unavailable", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bpmn-cli-output-"));
  const temporary = join(directory, "output.tmp");
  const output = join(directory, "output.json");
  context.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(temporary, "written");

  const unsupportedLink: typeof import("node:fs/promises").link = async () => {
    const error = new Error("hard links are unavailable") as NodeJS.ErrnoException;
    error.code = "ENOTSUP";
    throw error;
  };

  await writeNewOutput(temporary, output, "written", unsupportedLink);

  assert.equal(await readFile(output, "utf8"), "written");
  await assert.rejects(
    writeNewOutput(temporary, output, "replacement", unsupportedLink),
    { code: "EEXIST" }
  );
  assert.equal(await readFile(output, "utf8"), "written");
});
