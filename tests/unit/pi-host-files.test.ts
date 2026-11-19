// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { preProcessFile } from "typescript";
import { expect, it } from "vitest";
import {
  PI_HOST_ENTRY,
  PI_HOST_FILES,
} from "@/lib/agents/sandbox-runtime/pi-host-files";

it("ships the Pi host's complete local import closure", () => {
  const scripts = resolve("scripts");
  const shipped = new Set<string>(PI_HOST_FILES);
  // Walk the entry plus the files loaded by configured paths and generated code.
  const pending: string[] = [PI_HOST_ENTRY, ...PI_HOST_FILES];
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const path = join(scripts, file);
    expect(existsSync(path), `Missing host source: ${file}`).toBe(true);
    const { importedFiles } = preProcessFile(readFileSync(path, "utf8"));
    for (const { fileName } of importedFiles) {
      if (!/^\.{1,2}\//.test(fileName)) continue;
      const target = relative(scripts, resolve(dirname(path), fileName));
      expect(
        shipped.has(target) && !isAbsolute(target),
        `${file} imports ${fileName}, which is absent from PI_HOST_FILES`,
      ).toBe(true);
      pending.push(target);
    }
  }
});
