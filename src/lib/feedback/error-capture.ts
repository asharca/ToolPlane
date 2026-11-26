"use client";

export type ErrorFeedbackCapture = {
  screenshotDataUrl: string;
  errorText: string;
  failureCode?: string;
  agentName?: string;
  sessionTitle?: string;
  path: string;
  capturedAt: string;
};

const CAPTURE_KEY_PREFIX = "toolplane:feedback-capture:";
const MAX_CAPTURE_AGE_MS = 15 * 60 * 1000;

function captureStorageKey(workspaceSlug: string) {
  return `${CAPTURE_KEY_PREFIX}${workspaceSlug}`;
}

export function buildErrorFeedbackHref(options: {
  workspaceSlug: string;
  failureCode?: string;
  workSessionId?: string;
  taskId?: string;
  conversationId?: string;
  agentId?: string;
  captured?: boolean;
}): string {
  const params = new URLSearchParams({ category: "failure" });
  if (options.failureCode) params.set("failureCode", options.failureCode);
  if (options.workSessionId) params.set("workSessionId", options.workSessionId);
  if (options.taskId) params.set("taskId", options.taskId);
  if (options.conversationId) {
    params.set("conversationId", options.conversationId);
  }
  if (options.agentId) params.set("agentId", options.agentId);
  if (options.captured) params.set("captured", "1");
  return `/app/${encodeURIComponent(options.workspaceSlug)}/feedback?${params.toString()}`;
}

function wrapCanvasLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let current = "";
    for (const char of trimmed) {
      const candidate = current + char;
      if (ctx.measureText(candidate).width > maxWidth && current) {
        lines.push(current);
        current = char;
        if (lines.length >= maxLines) return lines;
      } else {
        current = candidate;
      }
    }
    if (current) {
      lines.push(current);
      if (lines.length >= maxLines) return lines;
    }
  }
  return lines;
}

function collectVisibleTranscriptSnippets(): Array<{
  role: string;
  text: string;
}> {
  if (typeof document === "undefined") return [];
  const root =
    document.querySelector('[data-ui="work.transcript"]') ??
    document.querySelector("main");
  if (!root) return [];

  const blocks: Array<{ role: string; text: string }> = [];
  const candidates = root.querySelectorAll("article, [data-role], section");
  const seen = new Set<string>();
  for (const node of candidates) {
    if (node.closest('[role="alert"]')) continue;
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text || text.length < 4 || seen.has(text)) continue;
    seen.add(text);
    const role =
      node.getAttribute("data-role") ||
      (node.getAttribute("aria-label") ?? "").slice(0, 32) ||
      "context";
    blocks.push({ role, text: text.slice(0, 280) });
    if (blocks.length >= 6) break;
  }
  if (!blocks.length) {
    const fallback = (root.textContent ?? "").replace(/\s+/g, " ").trim();
    if (fallback) {
      blocks.push({ role: "page", text: fallback.slice(0, 500) });
    }
  }
  return blocks;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function renderErrorScreenshotDataUrl(params: {
  errorText: string;
  failureCode?: string;
  agentName?: string;
  sessionTitle?: string;
  path: string;
  capturedAt: string;
}): string | null {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }
  try {
    const style = getComputedStyle(document.documentElement);
    const dark = document.documentElement.classList.contains("dark");
    const bg =
      style.getPropertyValue("--background").trim() ||
      (dark ? "#151515" : "#ffffff");
    const card =
      style.getPropertyValue("--card").trim() || (dark ? "#1c1c1c" : "#f8fafc");
    const fg =
      style.getPropertyValue("--foreground").trim() ||
      (dark ? "#fafafa" : "#09090b");
    const mutedFg =
      style.getPropertyValue("--muted-foreground").trim() ||
      (dark ? "#a1a1aa" : "#71717a");
    const border =
      style.getPropertyValue("--border").trim() ||
      (dark ? "#27272a" : "#e4e4e7");
    const destructive =
      style.getPropertyValue("--destructive").trim() || "#ef4444";

    const width = 960;
    const height = 540;
    const dpr = 1.5;
    const canvas = document.createElement("canvas");
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // Header bar
    ctx.fillStyle = card;
    ctx.fillRect(0, 0, width, 54);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 54);
    ctx.lineTo(width, 54);
    ctx.stroke();

    ctx.fillStyle = fg;
    ctx.font = "600 14px system-ui, -apple-system, sans-serif";
    const heading = [params.agentName || "ToolPlane", params.sessionTitle]
      .filter(Boolean)
      .join(" / ");
    ctx.fillText(heading.slice(0, 72), 24, 32);

    ctx.fillStyle = mutedFg;
    ctx.font = "12px ui-monospace, SFMono-Regular, monospace";
    const metaRight = `${params.path.slice(0, 48)} · ${params.capturedAt.slice(11, 19)} UTC`;
    const metaWidth = ctx.measureText(metaRight).width;
    ctx.fillText(metaRight, Math.max(24, width - 24 - metaWidth), 32);

    // Recent visible page/transcript blocks
    let y = 76;
    const snippets = collectVisibleTranscriptSnippets();
    for (const block of snippets.slice(0, 4)) {
      ctx.font = "12px system-ui, -apple-system, sans-serif";
      const lines = wrapCanvasLines(ctx, block.text, width - 92, 2);
      if (!lines.length) continue;
      const boxH = 22 + lines.length * 18;
      if (y + boxH > height - 150) break;

      drawRoundedRect(ctx, 24, y, width - 48, boxH, 10);
      ctx.fillStyle = card;
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.stroke();

      ctx.fillStyle = fg;
      let lineY = y + 20;
      for (const line of lines) {
        ctx.fillText(line, 40, lineY);
        lineY += 18;
      }
      y += boxH + 10;
    }

    // Error alert banner at bottom
    const alertText = params.errorText.trim() || params.failureCode || "Error";
    ctx.font = "500 13px system-ui, -apple-system, sans-serif";
    const errorLines = wrapCanvasLines(ctx, alertText, width - 96, 4);
    const alertH = Math.max(82, 46 + errorLines.length * 20);
    const alertY = Math.max(y + 10, height - alertH - 24);

    drawRoundedRect(ctx, 24, alertY, width - 48, alertH, 12);
    ctx.fillStyle = dark
      ? "rgba(239, 68, 68, 0.14)"
      : "rgba(239, 68, 68, 0.08)";
    ctx.fill();
    ctx.strokeStyle = destructive;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = destructive;
    ctx.font = "600 12px ui-monospace, SFMono-Regular, monospace";
    ctx.fillText(
      params.failureCode ? `ERROR · ${params.failureCode}` : "RUNTIME ERROR",
      42,
      alertY + 24,
    );

    ctx.fillStyle = fg;
    ctx.font = "500 13px system-ui, -apple-system, sans-serif";
    let errY = alertY + 46;
    for (const line of errorLines) {
      ctx.fillText(line, 42, errY);
      errY += 20;
    }

    const dataUrl = canvas.toDataURL("image/png");
    return dataUrl.length <= 550_000 ? dataUrl : null;
  } catch {
    return null;
  }
}

export function captureAndStoreErrorFeedback(options: {
  workspaceSlug: string;
  errorText: string;
  failureCode?: string;
  agentName?: string;
  sessionTitle?: string;
}): void {
  if (typeof window === "undefined") return;
  const capturedAt = new Date().toISOString();
  const path = `${window.location.pathname}${window.location.search}`;
  const screenshotDataUrl = renderErrorScreenshotDataUrl({
    errorText: options.errorText,
    failureCode: options.failureCode,
    agentName: options.agentName,
    sessionTitle: options.sessionTitle,
    path,
    capturedAt,
  });
  const payload: ErrorFeedbackCapture = {
    screenshotDataUrl: screenshotDataUrl ?? "",
    errorText: options.errorText.slice(0, 2000),
    ...(options.failureCode ? { failureCode: options.failureCode } : {}),
    ...(options.agentName ? { agentName: options.agentName } : {}),
    ...(options.sessionTitle ? { sessionTitle: options.sessionTitle } : {}),
    path,
    capturedAt,
  };
  try {
    window.sessionStorage.setItem(
      captureStorageKey(options.workspaceSlug),
      JSON.stringify(payload),
    );
  } catch {
    // Ignore storage quota or private browsing errors.
  }
}

export function consumeStoredErrorFeedbackCapture(
  workspaceSlug: string,
): ErrorFeedbackCapture | null {
  if (typeof window === "undefined") return null;
  const key = captureStorageKey(workspaceSlug);
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    window.sessionStorage.removeItem(key);
    const parsed = JSON.parse(raw) as Partial<ErrorFeedbackCapture>;
    if (!parsed || typeof parsed !== "object") return null;
    const capturedAtMs =
      typeof parsed.capturedAt === "string"
        ? Date.parse(parsed.capturedAt)
        : Number.NaN;
    if (
      Number.isFinite(capturedAtMs) &&
      Date.now() - capturedAtMs > MAX_CAPTURE_AGE_MS
    ) {
      return null;
    }
    return {
      screenshotDataUrl:
        typeof parsed.screenshotDataUrl === "string"
          ? parsed.screenshotDataUrl
          : "",
      errorText: typeof parsed.errorText === "string" ? parsed.errorText : "",
      failureCode:
        typeof parsed.failureCode === "string" ? parsed.failureCode : undefined,
      agentName:
        typeof parsed.agentName === "string" ? parsed.agentName : undefined,
      sessionTitle:
        typeof parsed.sessionTitle === "string"
          ? parsed.sessionTitle
          : undefined,
      path: typeof parsed.path === "string" ? parsed.path : "",
      capturedAt:
        typeof parsed.capturedAt === "string"
          ? parsed.capturedAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
