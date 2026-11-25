import { ImageResponse } from "next/og";

export const alt = "ToolPlane — self-hosted agent control plane";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#151515",
        color: "#f5f5f5",
        padding: "72px 80px",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
        <div
          style={{
            width: 72,
            height: 72,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 18,
            background: "#1c1c1c",
            border: "1px solid rgba(255, 255, 255, 0.12)",
          }}
        >
          <svg width="46" height="46" viewBox="0 0 64 64">
            <title>ToolPlane</title>
            <path d="M12 14h30v9H31v27H21V23h-9z" fill="#f5f5f5" />
            <path d="m34 27 20 9-20 9 4-7H29v-4h9z" fill="#0285f7" />
          </svg>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 48,
            fontWeight: 700,
            letterSpacing: "-0.02em",
          }}
        >
          ToolPlane
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div
          style={{
            maxWidth: 960,
            fontSize: 66,
            fontWeight: 800,
            lineHeight: 1.08,
            letterSpacing: "-0.03em",
          }}
        >
          One self-hosted control plane for MCP, skills, and agents.
        </div>
        <div
          style={{
            maxWidth: 920,
            color: "#9e9e9e",
            fontSize: 30,
            lineHeight: 1.4,
          }}
        >
          Operate MCP runtimes, GitHub-pinned Pi plugins, persistent sandboxes,
          and Pi SDK agents inside a workspace your team owns.
        </div>
      </div>
    </div>,
    size,
  );
}
