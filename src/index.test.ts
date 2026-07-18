import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  execute,
  getCapabilities,
  version
} from "./index.js";

const require = createRequire(import.meta.url);
const packageManifest = require("../package.json") as { version: string };
const entrypoint = fileURLToPath(new URL("./index.js", import.meta.url));

test("renders help by default and for both help aliases", () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    const result = execute(args);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stream, "stdout");
    assert.match(result.output, /^bpmn-cli /);
    assert.match(result.output, /Usage:/);
    assert.match(result.output, /capabilities/);
    assert.match(result.output, /-h, --help/);
    assert.match(result.output, /-v, --version/);
    assert.match(result.output, /PLAN\.md/);
    assert.ok(result.output.endsWith("\n"));
  }
});

test("renders the package version for both version aliases", () => {
  assert.equal(version, packageManifest.version);

  for (const option of ["--version", "-v"]) {
    assert.deepEqual(execute([option]), {
      exitCode: 0,
      output: `${packageManifest.version}\n`,
      stream: "stdout"
    });
  }
});

test("reports capabilities as text", () => {
  const result = execute(["capabilities"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stream, "stdout");
  assert.match(result.output, new RegExp(`CLI version: ${version}`));
  assert.match(result.output, /capabilities\s+available/);
  assert.match(result.output, /inspect\s+planned/);
  assert.match(result.output, /BPMN parsing: not implemented/);
  assert.match(result.output, /BPMN mutation: not implemented/);
});

test("reports stable machine-readable capabilities", () => {
  const result = execute(["capabilities", "--json"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stream, "stdout");
  assert.ok(result.output.endsWith("\n"));
  assert.deepEqual(JSON.parse(result.output), getCapabilities());
  assert.deepEqual(getCapabilities(), {
    schemaVersion: "1",
    cli: {
      name: "bpmn-cli",
      version: packageManifest.version,
      node: ">=20"
    },
    commands: [
      {
        name: "capabilities",
        status: "available",
        outputFormats: ["text", "json"]
      },
      { name: "inspect", status: "planned" },
      { name: "validate", status: "planned" },
      { name: "plan", status: "planned" },
      { name: "diff", status: "planned" },
      { name: "apply", status: "planned" },
      { name: "verify", status: "planned" }
    ],
    bpmn: {
      parsing: false,
      mutation: false,
      moddleExtensions: []
    }
  });
});

test("renders command-specific help", () => {
  for (const option of ["--help", "-h"]) {
    const result = execute(["capabilities", option]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stream, "stdout");
    assert.match(result.output, /bpmn-cli capabilities \[--json\]/);
  }
});

test("rejects unsupported and malformed arguments", () => {
  for (const args of [
    ["edit"],
    ["--version", "extra"],
    ["capabilities", "--yaml"],
    ["capabilities", "--json", "extra"]
  ]) {
    const result = execute(args);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stream, "stderr");
    assert.match(
      result.output,
      new RegExp(`Unknown command or option: ${args.join(" ")}`)
    );
    assert.match(result.output, /bpmn-cli --help/);
  }
});

test("writes successful output only to stdout", async () => {
  const { run } = await import("./index.js");
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = run(
    ["--version"],
    { write: (chunk) => stdout.push(chunk) },
    { write: (chunk) => stderr.push(chunk) }
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(stdout, [`${version}\n`]);
  assert.deepEqual(stderr, []);
});

test("writes errors only to stderr", async () => {
  const { run } = await import("./index.js");
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = run(
    ["unsupported"],
    { write: (chunk) => stdout.push(chunk) },
    { write: (chunk) => stderr.push(chunk) }
  );

  assert.equal(exitCode, 1);
  assert.deepEqual(stdout, []);
  assert.match(stderr[0] ?? "", /Unknown command or option: unsupported/);
});

test("runs the compiled entrypoint as a process", () => {
  const capabilities = spawnSync(
    process.execPath,
    [entrypoint, "capabilities", "--json"],
    {
      encoding: "utf8"
    }
  );

  assert.equal(capabilities.status, 0);
  assert.equal(
    JSON.parse(capabilities.stdout).cli.version,
    packageManifest.version
  );
  assert.equal(capabilities.stderr, "");

  const help = spawnSync(process.execPath, [entrypoint, "--help"], {
    encoding: "utf8"
  });

  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(help.stderr, "");

  const invalid = spawnSync(process.execPath, [entrypoint, "unsupported"], {
    encoding: "utf8"
  });

  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Unknown command or option: unsupported/);
});
