import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("writes a resolvable fluent API entry point", async () => {
  const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    exports: {
      ".": {
        import: string;
        types: string;
      };
    };
    main: string;
    types: string;
  };

  assert.equal(manifest.main, "./dist/index.js");
  assert.equal(manifest.types, "./dist/index.d.ts");
  assert.deepEqual(manifest.exports["."], {
    import: "./dist/index.js",
    types: "./dist/index.d.ts"
  });
  await access(fileURLToPath(new URL("./index.js", import.meta.url)));
  const library = await import("./index.js");
  assert.equal(typeof library.Bpmn, "object");
  assert.equal(typeof library.BpmnModel, "function");
});
