import "server-only";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ensureOmpInstalled,
  OMP_VERSION,
} from "../../../scripts/omp-install.mjs";
import {
  assertRuntimeOwner,
  runtimeAbortSignal,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";

/** Shared immutable artifact only: never put Agent configuration or credentials here. */
export function prepareOmpRuntime(): Promise<string> {
  // Preflight can also run in the owner's recovery maintenance context. The
  // installer coalesces concurrent work and rechecks the pinned digest on reuse.
  return trackRuntimeOperation(async () => {
    assertRuntimeOwner(true);
    const root = join(
      /* turbopackIgnore: true */ homedir(),
      ".cache",
      "toolplane",
      "omp",
      OMP_VERSION,
      `${process.platform}-${process.arch}`,
    );
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = await ensureOmpInstalled(
      join(/* turbopackIgnore: true */ root, "omp"),
      { signal: runtimeAbortSignal() },
    );
    assertRuntimeOwner(true);
    await chmod(path, 0o755);
    return path;
  }, true);
}
