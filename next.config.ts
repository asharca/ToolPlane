import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { securityHeaders } from "./src/lib/http/security-headers";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const allowedDevOrigins = ["localhost", "127.0.0.1"];
try {
  const hostname = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").hostname;
  if (!allowedDevOrigins.includes(hostname)) allowedDevOrigins.push(hostname);
} catch {
  // Keep loopback development access when the public URL is not configured.
}

const nextConfig: NextConfig = {
  allowedDevOrigins,
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["@earendil-works/pi-ai", "@larksuiteoapi/node-sdk"],
  async redirects() {
    const docs = "https://asharca.github.io/toolplane-docs/docs";
    return [
      { source: "/docs/api", destination: "/docs-api", permanent: true },
      {
        source: "/docs/en/api/reference",
        destination: "/docs-api",
        permanent: true,
      },
      { source: "/docs", destination: `${docs}/zh`, permanent: true },
      {
        source: "/docs/:category(guides|developers)",
        destination: `${docs}/zh/:category`,
        permanent: true,
      },
      {
        source: "/docs/developers/CHANGELOG",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/en/developers/CHANGELOG",
        permanent: true,
      },
      {
        source: "/docs/guides/README",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/guides/README",
        permanent: true,
      },
      {
        source: "/docs/guides/docs/A2A_CONSOLE.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/guides/docs/A2A_CONSOLE",
        permanent: true,
      },
      {
        source: "/docs/guides/docs/A2A_INGRESS_APPROVALS.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/guides/docs/A2A_INGRESS_APPROVALS",
        permanent: true,
      },
      {
        source: "/docs/developers/docs/A2A_LOCAL_COLLABORATION.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/developers/docs/A2A_LOCAL_COLLABORATION",
        permanent: true,
      },
      {
        source: "/docs/api/docs/A2A_MCP_BRIDGE.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/api/docs/A2A_MCP_BRIDGE",
        permanent: true,
      },
      {
        source: "/docs/api/docs/A2A_NATIVE.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/api/docs/A2A_NATIVE",
        permanent: true,
      },
      {
        source: "/docs/guides/docs/A2A_REMOTE_AGENTS.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/guides/docs/A2A_REMOTE_AGENTS",
        permanent: true,
      },
      {
        source: "/docs/developers/docs/A2A_RESOURCE_LIMITS.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/developers/docs/A2A_RESOURCE_LIMITS",
        permanent: true,
      },
      {
        source: "/docs/api/docs/AGENT_CONTROL_MCP.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/api/docs/AGENT_CONTROL_MCP",
        permanent: true,
      },
      {
        source: "/docs/guides/docs/AGENT_MESSAGING_PLATFORMS.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/guides/docs/AGENT_MESSAGING_PLATFORMS",
        permanent: true,
      },
      {
        source: "/docs/api/docs/AGENT_PUBLIC_API.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/api/docs/AGENT_PUBLIC_API",
        permanent: true,
      },
      {
        source: "/docs/developers/docs/AGENT_RUNTIMES.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/developers/docs/AGENT_RUNTIMES",
        permanent: true,
      },
      {
        source: "/docs/developers/docs/OBSERVABILITY.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/developers/docs/OBSERVABILITY",
        permanent: true,
      },
      {
        source: "/docs/guides/docs/README.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/guides/docs/README",
        permanent: true,
      },
      {
        source: "/docs/developers/docs/RELEASES.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/developers/docs/RELEASES",
        permanent: true,
      },
      {
        source: "/docs/api/docs/REMOTE_MCP_HTTP.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/api/docs/REMOTE_MCP_HTTP",
        permanent: true,
      },
      {
        source: "/docs/developers/docs/RUNTIME_OPERATIONS.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/developers/docs/RUNTIME_OPERATIONS",
        permanent: true,
      },
      {
        source: "/docs/guides/docs/SANDBOXES.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/guides/docs/SANDBOXES",
        permanent: true,
      },
      {
        source: "/docs/developers/docs/UI_LIBRARY.zh-CN",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/zh/developers/docs/UI_LIBRARY",
        permanent: true,
      },
      {
        source: "/docs/guides/infra/firecrawl/README",
        destination:
          "https://asharca.github.io/toolplane-docs/docs/en/guides/infra/firecrawl/README",
        permanent: true,
      },
      {
        source: "/docs/:path*",
        destination: `${docs}/:path*`,
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders() },
      {
        source: "/app/:workspace/:path+",
        headers: securityHeaders(process.env.NODE_ENV, true),
      },
    ];
  },
  outputFileTracingIncludes: {
    "/*": ["node_modules/node-pty/**/*", "node_modules/ws/**/*"],
  },
  outputFileTracingExcludes: {
    "/*": [
      "src/**/*",
      "tests/**/*",
      "e2e/**/*",
      "scraper/**/*",
      "infra/**/*",
      "runtime/**/*",
      // Dynamic Pi sandbox hosts and offline migration utilities are copied by
      // scripts/assemble-runtime.mjs, not resolved as application dependencies.
      "scripts/**/*",
      "packages/**/*",
      "prisma/**/*",
      "public/**/*",
      "**/*.md",
      "*.json",
      "*.mjs",
      "*.ts",
      "*.yml",
      "Dockerfile",
      "pnpm-lock.yaml",
    ],
  },
  experimental: {
    turbopackFileSystemCacheForDev: false,
    serverActions: {
      bodySizeLimit: "64mb",
    },
  },
};

export default withNextIntl(nextConfig);
