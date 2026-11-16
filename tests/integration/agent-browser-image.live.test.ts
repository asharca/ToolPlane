// @vitest-environment node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SANDBOX_TURN_PREPARER } from "@/lib/agents/sandbox-runtime";

const execute = promisify(execFile);
const enabled = process.env.SANDBOX_DOCKER_SMOKE === "1";

(enabled ? describe : describe.skip)("default browser sandbox image", () => {
  it("repeatedly runs and reaps Chromium under production limits with sleep as PID 1", async () => {
    const browserSource = await readFile(
      "scripts/pi-optional-tools/browser.mjs",
      "utf8",
    );
    const scenario = `
const fs = require('node:fs');
const {spawn,spawnSync} = require('node:child_process');
const {once} = require('node:events');
const assert = require('node:assert/strict');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const root = '/workspace/conversations/browser-smoke';
const host = root + '/.toolplane/host/browser.mjs';
const prepared = spawnSync(process.execPath, ['-e', input.preparer], {
  input: JSON.stringify({
    directories: [root, '/workspace/.toolplane/agent-home'],
    files: [{path: host, content: input.browserSource}],
  }), encoding: 'utf8',
});
assert.equal(prepared.status, 0, prepared.stderr);
assert.deepEqual(JSON.parse(prepared.stdout), {runtimeReady:true});
assert.ok(fs.readFileSync('/proc/1/cmdline','utf8').startsWith('sleep'));
assert.equal(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(), input.resourceLimited ? '32' : '128');
assert.equal(fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),'100000 100000');
function zombies() {
  return fs.readdirSync('/proc').filter(name => /^\\d+$/.test(name)).filter(name => {
    try { return /^State:\\s+Z/m.test(fs.readFileSync('/proc/'+name+'/status','utf8')); }
    catch { return false; }
  });
}
(async () => {
  // Exercise loading the actual file produced by the trusted materializer.
  const {BrowserDriver} = await import(host);
  const browser = new BrowserDriver({network:'none'});
  const before = zombies();
  const counts = [];
  const hostLoad = [];
  try {
    if (input.resourceLimited) {
      await assert.rejects(browser.run({action:'open',url:'about:blank'}), error => error.reason === 'BROWSER_RESOURCE_LIMIT');
      assert.deepEqual(zombies(),before,'zombies accumulated after resource exhaustion');
      console.log('BROWSER_RESOURCE_LIMIT_REAPED');
      return;
    }
    // Reserve real PID slots for the broker/SDK host, not only the tiny driver.
    for (let i=0;i<20;i++) {
      const child = spawn('sleep',['infinity']);
      hostLoad.push(child);
      await once(child,'spawn');
    }
    const baselinePids = Number(fs.readFileSync('/sys/fs/cgroup/pids.current','utf8'));
    assert.ok(baselinePids >= 20);
    fs.writeFileSync(root+'/page.html','<!doctype html><p>IMAGE_BOOTSTRAP_OK</p><canvas width="200" height="100"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="green";c.fillRect(0,0,200,100);</script>');
    for (let cycle=0;cycle<10;cycle++) {
      await browser.run({action:'open',url:'file://'+root+'/page.html'});
      const text = await browser.run({action:'text'});
      assert.equal(text.content[0].text,'IMAGE_BOOTSTRAP_OK');
      const image = await browser.run({action:'screenshot'});
      assert.equal(image.content[0].mimeType,'image/jpeg');
      assert.ok(Buffer.from(image.content[0].data,'base64').length <= 153600);
      const crashpads = fs.readdirSync('/proc').filter(name => /^\\d+$/.test(name)).filter(name => {
        try { return fs.readFileSync('/proc/'+name+'/comm','utf8').includes('crashpad'); }
        catch { return false; }
      });
      assert.deepEqual(crashpads,[],'crashpad must not run in the constrained sandbox');
      counts.push(Number(fs.readFileSync('/sys/fs/cgroup/pids.current','utf8')));
      await browser.run({action:'close'});
      assert.deepEqual(zombies(),before,'zombies accumulated after cycle '+cycle);
    }
    // Cancellation follows the same supervisor kill-and-reap path.
    await browser.run({action:'open',url:'about:blank'});
    const controller = new AbortController();
    const pending = browser.run({action:'evaluate',js:'new Promise(() => {})'},controller.signal);
    setImmediate(() => controller.abort());
    await assert.rejects(pending, error => error.reason === 'BROWSER_ABORTED');
    assert.deepEqual(zombies(),before,'zombies accumulated after cancellation');
    console.log(JSON.stringify({marker:'IMAGE_BOOTSTRAP_BROWSER_OK',cycles:10,hostLoadPids:hostLoad.length,baselinePids,peakObservedPids:Math.max(...counts),zombies:zombies().length}));
  } finally {
    await browser.dispose();
    await Promise.all(hostLoad.map(async child => {
      const exited = once(child,'exit');
      child.kill('SIGTERM');
      await exited;
    }));
  }
})().catch(error => { console.error(error); process.exitCode=1; });
`;
    const name = `toolplane-browser-smoke-${randomUUID()}`;
    const image =
      process.env.TOOLPLANE_BROWSER_TEST_IMAGE || "toolplane-sandbox:local";
    try {
      await execute(
        "docker",
        [
          "run",
          "--detach",
          "--pull",
          "never",
          "--name",
          name,
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--memory",
          "512m",
          "--cpus",
          "1",
          "--pids-limit",
          "128",
          // Match an already initialized root-owned production volume. Neither a
          // user override nor an init process may conceal ownership/reaping bugs.
          "--mount",
          "type=volume,destination=/workspace,volume-nocopy",
          "--env",
          "HOME=/workspace/.toolplane/agent-home",
          "--env",
          "TOOLPLANE_CHROMIUM_PATH=/usr/bin/chromium",
          "--entrypoint",
          "sleep",
          image,
          "infinity",
        ],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      const result = execute(
        "docker",
        ["exec", "-i", name, "node", "-e", scenario],
        {
          timeout: 150_000,
          maxBuffer: 1024 * 1024,
        },
      );
      result.child.stdin?.end(
        JSON.stringify({ preparer: SANDBOX_TURN_PREPARER, browserSource }),
      );
      const report = JSON.parse((await result).stdout.trim());
      expect(report).toMatchObject({
        marker: "IMAGE_BOOTSTRAP_BROWSER_OK",
        cycles: 10,
        hostLoadPids: 20,
        zombies: 0,
      });
      expect(report.peakObservedPids).toBeLessThan(128);
      console.info("Browser production-limit smoke", report);
      await execute("docker", ["update", "--pids-limit", "32", name], {
        timeout: 30_000,
      });
      const limited = execute(
        "docker",
        ["exec", "-i", name, "node", "-e", scenario],
        { timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
      limited.child.stdin?.end(
        JSON.stringify({
          preparer: SANDBOX_TURN_PREPARER,
          browserSource,
          resourceLimited: true,
        }),
      );
      expect((await limited).stdout.trim()).toBe(
        "BROWSER_RESOURCE_LIMIT_REAPED",
      );
    } finally {
      await execute("docker", ["rm", "--force", "--volumes", name], {
        timeout: 30_000,
      });
    }
  }, 210_000);
});
