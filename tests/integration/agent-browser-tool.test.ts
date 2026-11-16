// @vitest-environment node
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertDefined } from "../assert-defined";
import {
  BrowserDriver,
  BROWSER_IMAGE_BYTES,
} from "../../scripts/pi-optional-tools/browser.mjs";

const executable = process.env.TOOLPLANE_CHROMIUM_PATH;
const drivers: BrowserDriver[] = [];
const cleanups: Array<() => Promise<void>> = [];
function driver(
  options: { network?: string; idleMs?: number; executable?: string } = {},
) {
  const value = new BrowserDriver({ executable, ...options });
  drivers.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(drivers.splice(0).map((value) => value.dispose()));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("fails closed with a stable reason when an old/custom image has no Chromium", async () => {
  const browser = driver({
    executable: "/toolplane-regression/missing-chromium",
  });
  await expect(
    browser.run({ action: "open", url: "about:blank" }),
  ).rejects.toMatchObject({ reason: "BROWSER_CHROMIUM_MISSING" });
});

// Host-browser checks are opt-in; CI exercises Chromium in the production image.
// An explicitly configured missing/broken executable must fail, not silently skip.
describe.skipIf(!executable)("sandbox browser real Chromium", () => {
  it("preserves local page state through input, click, keypress, text and a real JPEG screenshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "toolplane-browser-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const html = join(root, "index.html");
    await writeFile(
      html,
      '<!doctype html><title>Browser fixture</title><input id="name"><button id="apply" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Apply</button><p id="result">Initial</p>',
    );
    const browser = driver();
    await browser.run({ action: "open", url: pathToFileURL(html).href });
    await browser.run({
      action: "type",
      selector: "#name",
      text: "Persistent browser",
    });
    await browser.run({ action: "press", key: "Control+a" });
    await browser.run({
      action: "type",
      selector: "#name",
      text: "Real Chromium",
    });
    await browser.run({ action: "click", selector: "#apply" });
    await expect(
      browser.run({ action: "click", selector: "#missing" }),
    ).rejects.toMatchObject({ reason: "BROWSER_SELECTOR_NOT_FOUND" });
    expect(await browser.run({ action: "text" })).toMatchObject({
      content: [
        { type: "text", text: expect.stringContaining("Real Chromium") },
      ],
    });
    expect(
      await browser.run({
        action: "evaluate",
        js: "document.querySelector('#name').value",
      }),
    ).toMatchObject({ content: [{ text: '"Real Chromium"' }] });
    const screenshot = assertDefined(
      await browser.run({ action: "screenshot" }),
    );
    expect(screenshot).toMatchObject({
      content: [{ type: "image", mimeType: "image/jpeg" }],
      details: { width: 1024, height: 768 },
    });
    const image = screenshot.content[0];
    expect(image.type).toBe("image");
    if (!("data" in image)) throw new Error("Expected image bytes");
    const bytes = Buffer.from(image.data, "base64");
    expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
    expect(bytes.length).toBeLessThanOrEqual(BROWSER_IMAGE_BYTES);
    await browser.run({ action: "close" });
    await expect(browser.run({ action: "text" })).rejects.toMatchObject({
      reason: "BROWSER_NOT_OPEN",
    });
  }, 60_000);

  it("allows HTTP on isolated bridge networking, but reports none without issuing a request", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end(
        "<!doctype html><title>Network fixture</title><p>HTTP_BROWSER_OK</p>",
      );
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    cleanups.push(async () => {
      server.closeAllConnections();
      const closed = once(server, "close");
      server.close();
      await closed;
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP fixture address");
    const url = `http://127.0.0.1:${address.port}/`;
    const blocked = driver({ network: "none" });
    await expect(blocked.run({ action: "open", url })).rejects.toMatchObject({
      reason: "BROWSER_NETWORK_ISOLATED",
    });
    expect(requests).toBe(0);
    const allowed = driver({ network: "isolated" });
    await allowed.run({ action: "open", url });
    expect(await allowed.run({ action: "text" })).toMatchObject({
      content: [{ text: "HTTP_BROWSER_OK" }],
    });
    expect(requests).toBeGreaterThan(0);
  }, 60_000);

  it("bounds page output, rejects page exceptions safely, and reclaims idle browser processes", async () => {
    const browser = driver({ idleMs: 500 });
    await browser.run({ action: "open", url: "data:text/html,<p>Local</p>" });
    expect(
      await browser.run({ action: "evaluate", js: "'x'.repeat(20000)" }),
    ).toMatchObject({ details: { truncated: true } });
    await expect(
      browser.run({
        action: "evaluate",
        js: "(() => {throw new Error('private-page-error')})()",
      }),
    ).rejects.toMatchObject({
      reason: "BROWSER_EVALUATION_FAILED",
      message: "The page JavaScript could not be evaluated.",
    });
    // Await the real child-process exit caused by idle reclamation, not a sleep.
    const child = browser.child;
    if (!child) throw new Error("Expected a live Chromium process");
    await once(child, "exit");
    await expect(browser.run({ action: "text" })).rejects.toMatchObject({
      reason: "BROWSER_NOT_OPEN",
    });
  }, 60_000);
});
