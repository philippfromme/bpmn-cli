import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "dist");

await mkdir(destination, { recursive: true });
await copyFile(
  resolve(root, "src", "bpmn-moddle.d.ts"),
  resolve(destination, "bpmn-moddle.d.ts")
);

const entryPoint = resolve(destination, "index.d.ts");
const contents = await readFile(entryPoint, "utf8");
await writeFile(
  entryPoint,
  `/// <reference path="./bpmn-moddle.d.ts" />\n${contents}`,
  "utf8"
);
