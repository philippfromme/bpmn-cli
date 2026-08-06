import assert from "node:assert/strict";
import { execFile as executeFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const execFile = promisify(executeFile);
const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function runNpm(arguments_, cwd) {
  if (process.platform !== "win32") {
    return execFile(npm, arguments_, { cwd });
  }

  return execFile(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", `${npm} ${arguments_.join(" ")}`],
    { cwd }
  );
}

const pack = await runNpm(["pack", "--json"], root);
const { stdout } = pack;
const packed = JSON.parse(stdout);

assert.equal(Array.isArray(packed), true);
assert.equal(packed.length, 1);
assert.equal(typeof packed[0]?.filename, "string");

const archive = join(root, packed[0].filename);
const consumerRoot = await mkdtemp(join(tmpdir(), "bpmn-cli-package-"));
const packageRoot = join(consumerRoot, "node_modules", "@philippfromme", "bpmn-cli");

try {
  await writeFile(
    join(consumerRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
    "utf8"
  );
  await runNpm([
    "install",
    archive,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock"
  ], consumerRoot);
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8")
  );
  const files = packed[0].files.map((entry) => entry.path);

  assert.deepEqual(packageJson.exports["."], {
    import: "./dist/index.js",
    types: "./dist/index.d.ts"
  });
  assert.equal(files.some((path) => path.includes(".test.")), false);
  assert.equal(files.includes("dist/index.js"), true);
  assert.equal(files.includes("dist/index.d.ts"), true);
  assert.equal(files.includes("dist/bpmn-moddle.d.ts"), true);
  assert.equal(files.includes("dist/model-types.generated/bpmn.d.ts"), true);
  assert.equal(files.includes("dist/model-types.generated/bpmndi.d.ts"), true);
  assert.equal(files.includes("dist/model-types.generated/dc.d.ts"), true);
  assert.equal(files.includes("dist/model-types.generated/di.d.ts"), true);
  assert.equal(files.includes("dist/model-types.generated/zeebe.d.ts"), true);

  const consumerJavaScript = join(consumerRoot, "consumer.mjs");
  const consumerTypeScript = join(consumerRoot, "consumer.ts");
  await writeFile(
    consumerJavaScript,
    `import { Bpmn } from "@philippfromme/bpmn-cli";
if (typeof Bpmn !== "object") throw new Error("Bpmn export missing");
if (typeof Bpmn.create !== "function" || typeof Bpmn.open !== "function") {
  throw new Error("Bpmn editor entry points missing");
}`,
    "utf8"
  );
  await writeFile(
    consumerTypeScript,
    `import {
  Bpmn,
  type BpmnEditor,
  type ElementProperties,
  type WriteOptions
} from "@philippfromme/bpmn-cli";
const options: WriteOptions = { layout: "none" };
const task: ElementProperties<"bpmn:ServiceTask"> = { retryCounter: "3" };
void options;
void task;
const model: BpmnEditor = await Bpmn.create();
void model;`,
    "utf8"
  );

  await execFile(process.execPath, [consumerJavaScript], { cwd: consumerRoot });
  await execFile(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "bin", "tsc"),
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      consumerTypeScript
    ],
    { cwd: consumerRoot }
  );
} finally {
  await rm(archive, { force: true });
  await rm(consumerRoot, { force: true, recursive: true });
}
