import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// Release archives and Docker dependency layers do not contain Git metadata.
if (existsSync(".git")) {
  let current = "";
  try {
    current = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  if (current && current !== ".githooks") {
    throw new Error(
      `Existing core.hooksPath=${current}; integrate the repository hooks before replacing it.`,
    );
  }
  execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"]);
  console.log("Installed pre-commit and pre-push checks.");
}
