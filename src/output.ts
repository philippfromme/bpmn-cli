import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  link,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export async function writeOutputFile(
  path: string,
  contents: string,
  force: boolean,
  sourcePath: string
): Promise<void> {
  const resolved = resolve(path);
  const resolvedSource = resolve(sourcePath);

  if (resolved === resolvedSource) {
    throw new Error("Output file must not be the BPMN source");
  }

  try {
    const [outputStats, sourceStats] = await Promise.all([
      stat(resolved),
      stat(resolvedSource)
    ]);

    if (
      outputStats.dev === sourceStats.dev &&
      outputStats.ino === sourceStats.ino
    ) {
      throw new Error("Output file must not alias the BPMN source");
    }
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
  }

  if (!force) {
    try {
      await access(resolved, constants.F_OK);
      throw new Error(`Output file already exists: ${path}`);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
  }

  const temporary = join(
    dirname(resolved),
    `.${basename(resolved)}.${randomUUID()}.tmp`
  );

  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      flag: "wx"
    });

    if (force) {
      await rename(temporary, resolved);
    } else {
      await link(temporary, resolved);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
