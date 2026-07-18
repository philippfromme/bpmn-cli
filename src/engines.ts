import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

interface PackageManifest {
  name: string;
  version: string;
}

function manifestNear(moduleName: string): PackageManifest {
  let directory = dirname(require.resolve(moduleName));

  while (true) {
    const manifestPath = join(directory, "package.json");

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(
        readFileSync(manifestPath, "utf8")
      ) as PackageManifest;

      if (manifest.name === moduleName) {
        return manifest;
      }
    }

    const parent = dirname(directory);

    if (parent === directory) {
      throw new Error(`Unable to locate package manifest for "${moduleName}"`);
    }
    directory = parent;
  }
}

export const engines = {
  autoLayout: {
    commit: "7351d19e9838a2923e4182c85effc33f74160224",
    name: "bpmn-auto-layout",
    version: manifestNear("bpmn-auto-layout").version
  },
  differ: {
    commit: "d55ca44ce5c3379bd852dbec97665d2713e5c086",
    name: "bpmn-js-differ",
    version: (
      require("bpmn-js-differ/package.json") as PackageManifest
    ).version
  },
  lint: {
    name: "bpmnlint",
    version: (require("bpmnlint/package.json") as PackageManifest).version
  }
} as const;
