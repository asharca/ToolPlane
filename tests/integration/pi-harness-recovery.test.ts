// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Observation = {
  event: string;
  operationId: string;
  sessionId: string;
  outcome?: { status: string; operationId: string };
  open?: Array<{ operationId: string }>;
  transcript?: unknown[];
};
const directories: string[] = [];
const children = new Set<ChildProcess>();
function start(
  directory: string,
  mode: string,
  boundary: string,
  replay: string,
) {
  const child = fork(
    resolve("scripts/pi-harness-recovery-check.mjs"),
    [directory, mode, boundary, replay],
    { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  children.add(child);
  let stderr = "";
  assertDefined(child.stderr).on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = once(child, "exit");
  const observed = new Promise<Observation>((resolve, reject) => {
    child.once("message", (message) => resolve(message as Observation));
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(new Error(`Fixture exited ${code ?? signal}: ${stderr}`)),
    );
  });
  return { child, observed, exited };
}
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  children.clear();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("official Pi Harness SQLite process recovery", () => {
  it.each([
    ["settled", "never", 1],
    ["pending", "safe", 2],
    ["pending", "never", 1],
  ] as const)(
    "recovers %s effect with replay=%s",
    async (boundary, replay, count) => {
      const directory = await mkdtemp(join(tmpdir(), "pi-harness-recovery-"));
      directories.push(directory);
      const first = start(directory, "create", boundary, replay);
      const paused = await first.observed;
      expect(paused.event).toBe(boundary);
      expect(
        (await readFile(join(directory, "count.txt"), "utf8"))
          .trim()
          .split("\n"),
      ).toHaveLength(1);
      first.child.kill("SIGKILL");
      expect((await first.exited)[1]).toBe("SIGKILL");

      const second = start(directory, "resume", boundary, replay);
      const resumed = await second.observed;
      expect((await second.exited)[0]).toBe(0);
      expect(resumed.operationId).toBe(paused.operationId);
      expect(resumed.sessionId).toBe(paused.sessionId);
      expect(resumed.open?.map((entry) => entry.operationId)).toContain(
        paused.operationId,
      );
      expect(resumed.outcome).toMatchObject({
        status: "completed",
        operationId: paused.operationId,
      });
      expect(
        (await readFile(join(directory, "count.txt"), "utf8"))
          .trim()
          .split("\n"),
      ).toHaveLength(count);
      if (boundary === "pending" && replay === "never") {
        expect(JSON.stringify(resumed.transcript)).toMatch(/interrupt/i);
      }
      const third = start(directory, "resume", boundary, replay);
      const terminal = await third.observed;
      expect((await third.exited)[0]).toBe(0);
      expect(terminal.outcome).toEqual(resumed.outcome);
      expect(
        (await readFile(join(directory, "count.txt"), "utf8"))
          .trim()
          .split("\n"),
      ).toHaveLength(count);
    },
    30_000,
  );

  it("persists explicit cancellation without resurrecting the operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-cancel-"));
    directories.push(directory);
    const first = start(directory, "create", "settled", "never");
    const paused = await first.observed;
    first.child.kill("SIGKILL");
    await first.exited;
    const canceled = start(directory, "cancel", "settled", "never");
    const result = await canceled.observed;
    expect((await canceled.exited)[0]).toBe(0);
    expect(result.outcome).toMatchObject({
      status: "aborted",
      operationId: paused.operationId,
    });
    const reopened = start(directory, "resume", "settled", "never");
    expect((await reopened.observed).outcome).toEqual(result.outcome);
    expect((await reopened.exited)[0]).toBe(0);
    expect((await readFile(join(directory, "count.txt"), "utf8")).trim()).toBe(
      "effect",
    );
  }, 30_000);
});
