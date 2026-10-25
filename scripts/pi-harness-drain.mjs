#!/usr/bin/env node
// Cleanup only: never opens native sessions, loads tools, installs a runtime or replays effects.
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const host =
  "/workspace/.toolplane/runtime-packages/pi-harness-0.87.1/pi-harness-session.mjs";
const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
};
const identity = (pid) => {
  const stat = read(`/proc/${pid}/stat`);
  if (!stat) return null;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[0] === "Z" ? null : fields[19];
};
const tracked = new Map();
const signal = (pid, start, name) => {
  if (identity(pid) !== start) return;
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
function capture(pid) {
  const start = identity(pid);
  if (!start) return;
  tracked.set(pid, start);
  for (const child of (read(`/proc/${pid}/task/${pid}/children`) ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean))
    capture(Number(child));
}
for (const entry of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
  const pid = Number(entry);
  const args = read(`/proc/${pid}/cmdline`)?.split("\0").filter(Boolean);
  if (
    args?.length !== 3 ||
    args[1] !== host ||
    !/^\/workspace\/\.toolplane\/runtime-tmp\/[a-f0-9-]+-pi-harness\.json$/.test(
      args[2],
    )
  )
    continue;
  const raw = read(args[2]);
  if (!raw) continue;
  const config = JSON.parse(raw);
  if (
    config.action !== "run" ||
    config.taskId !== input.taskId ||
    config.contextId !== input.contextId ||
    config.operationId !== input.operationId ||
    config.directory !==
      `/workspace/.toolplane/runtimes/pi/agents/${input.agentId}/harness`
  )
    continue;
  capture(pid);
}
const roots = [...tracked.keys()];
for (const [pid, start] of tracked) signal(pid, start, "SIGTERM");
await sleep(500);
for (const pid of roots) if (tracked.get(pid) === identity(pid)) capture(pid);
for (const [pid, start] of tracked) signal(pid, start, "SIGKILL");
const deadline = Date.now() + 5000;
while ([...tracked].some(([pid, start]) => identity(pid) === start)) {
  if (Date.now() >= deadline) throw new Error("PI_PROCESS_STOP_UNCONFIRMED");
  await sleep(50);
}
process.stdout.write(
  JSON.stringify({
    status: "aborted",
    operationId: input.operationId,
    text: "Legacy native processes drained. Previously started side effects remain unknown and were not replayed.",
  }),
);
