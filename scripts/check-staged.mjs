import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const biome = require.resolve("@biomejs/biome/bin/biome");
const git = (...args) =>
  execFileSync("git", args, { maxBuffer: 32 * 1024 * 1024 });
const files = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
  .toString()
  .split("\0")
  .filter(Boolean);
if (files.length) {
  // Materialize index contents outside the worktree: Biome never edits user files.
  const snapshot = mkdtempSync(join(tmpdir(), "toolplane-staged-"));
  try {
    const context = git(
      "ls-files",
      "-z",
      "--",
      "biome.json",
      ".gitignore",
      "package.json",
    )
      .toString()
      .split("\0")
      .filter(Boolean);
    for (const file of new Set([...context, ...files])) {
      const target = join(snapshot, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, git("show", `:${file}`));
    }
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_")) delete env[key];
    execFileSync("git", ["init", "-q", snapshot], { env });
    for (let i = 0; i < files.length; i += 50) {
      const result = spawnSync(
        process.execPath,
        [
          biome,
          "check",
          "--error-on-warnings",
          "--no-errors-on-unmatched",
          ...files.slice(i, i + 50).map((file) => `./${file}`),
        ],
        { cwd: snapshot, env, stdio: "inherit" },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) process.exitCode = 1;
    }
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}
