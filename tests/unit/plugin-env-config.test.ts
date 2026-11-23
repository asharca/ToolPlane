import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parsePiPackageReleaseManifest,
  type PiPackageManifestV1,
} from "@/lib/pi-packages/manifest";
import {
  computePluginCapabilities,
  requiresReview,
} from "@/lib/plugins/capabilities";
import {
  evaluatePluginEnvStatus,
  supportsPlatformPreset,
  type PiPackageEnvRequirement,
  type PiPackageHttpProxy,
} from "@/lib/plugins/env-schema";
import { runtimePluginUpstreamUrl } from "@/lib/agents/runtime-access";

function baseManifest(extra?: {
  env?: PiPackageEnvRequirement[];
  httpProxies?: PiPackageHttpProxy[];
}): PiPackageManifestV1 {
  const indexContent = "export default () => {}";
  return {
    schemaVersion: 1 as const,
    kind: "pi-package" as const,
    listing: {
      slug: "ocrplane-cli",
      name: "ocrplane-cli",
      summary: "OCR CLI",
      iconUrl: null,
      tags: [],
      author: "toolplane",
    },
    package: {
      source: {
        kind: "git" as const,
        requested: `https://github.com/asharca/toolplane-plugins.git#${"a".repeat(40)}`,
        url: "https://github.com/asharca/toolplane-plugins.git",
        commit: "a".repeat(40),
        path: "plugins/ocrplane-cli",
      },
      name: "ocrplane-cli",
      version: "2.1.0",
      root: "package",
      runtime: {
        kind: "pi-sdk" as const,
        piVersion: "1.5.2" as const,
        nodeMajor: 26 as const,
        platform: "any" as const,
        arch: "any" as const,
      },
      resources: {
        extensions: ["package/index.mjs"],
        skills: [],
        prompts: [],
        themes: [],
      },
      entries: [
        { type: "directory" as const, path: "package" },
        {
          type: "file" as const,
          path: "package/index.mjs",
          contentEncoding: "base64" as const,
          content: Buffer.from(indexContent).toString("base64"),
          executable: false,
          sha256: createHash("sha256").update(indexContent).digest("hex"),
        },
      ],
      ...(extra
        ? {
            toolplane: {
              schemaVersion: 1 as const,
              mcp: [],
              ...extra,
            },
          }
        : {}),
    },
  };
}

describe("plugin environment schema and capability checks", () => {
  it("validates valid httpProxies declarations including bearer, header, and query auth", () => {
    const env: PiPackageEnvRequirement[] = [
      {
        name: "OCRPLANE_BASE_URL",
        required: true,
        secret: false,
        kind: "url",
      },
      { name: "OCRPLANE_API_KEY", required: true, secret: true },
      { name: "CUSTOM_URL", required: false, secret: false, kind: "url" },
      { name: "CUSTOM_HEADER_KEY", required: true, secret: true },
      { name: "QUERY_KEY", required: true, secret: true },
    ];
    const httpProxies: PiPackageHttpProxy[] = [
      {
        key: "ocrplane",
        baseUrlEnv: "OCRPLANE_BASE_URL",
        auth: { type: "bearer", secretEnv: "OCRPLANE_API_KEY" },
      },
      {
        key: "custom-header",
        baseUrlEnv: "CUSTOM_URL",
        defaultUpstreamUrl: "https://service.example.com/v1",
        auth: {
          type: "header",
          headerName: "X-Api-Token",
          prefix: "Token ",
          secretEnv: "CUSTOM_HEADER_KEY",
        },
      },
      {
        key: "custom-query",
        baseUrlEnv: "OCRPLANE_BASE_URL",
        auth: { type: "query", paramName: "api_key", secretEnv: "QUERY_KEY" },
      },
    ];
    // Sharing baseUrlEnv across two proxies is rejected to prevent ambiguity.
    expect(() =>
      parsePiPackageReleaseManifest(baseManifest({ env, httpProxies })),
    ).toThrow();

    env.push({
      name: "QUERY_URL",
      required: true,
      secret: false,
      kind: "url",
    });
    httpProxies[2] = {
      key: "custom-query",
      baseUrlEnv: "QUERY_URL",
      auth: { type: "query", paramName: "api_key", secretEnv: "QUERY_KEY" },
    };
    expect(
      parsePiPackageReleaseManifest(baseManifest({ env, httpProxies })).package
        .toolplane?.env,
    ).toHaveLength(6);
  });

  it("rejects reserved env names, invalid header names, and mismatched proxy types", () => {
    for (const reserved of [
      "TOOLPLANE_RUNTIME_TOKEN",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "SSL_CERT_FILE",
      "LD_PRELOAD",
      "NODE_OPTIONS",
      "PATH",
    ]) {
      expect(() =>
        parsePiPackageReleaseManifest(
          baseManifest({
            env: [{ name: reserved, required: true, secret: false }],
          }),
        ),
      ).toThrow();
    }

    // Secret baseUrlEnv is rejected.
    expect(() =>
      parsePiPackageReleaseManifest(
        baseManifest({
          env: [
            {
              name: "OCRPLANE_BASE_URL",
              required: true,
              secret: true,
              kind: "url",
            },
            { name: "OCRPLANE_API_KEY", required: true, secret: true },
          ],
          httpProxies: [
            {
              key: "ocrplane",
              baseUrlEnv: "OCRPLANE_BASE_URL",
              auth: { type: "bearer", secretEnv: "OCRPLANE_API_KEY" },
            },
          ],
        }),
      ),
    ).toThrow();

    // Optional baseUrlEnv without defaultUpstreamUrl is rejected.
    expect(() =>
      parsePiPackageReleaseManifest(
        baseManifest({
          env: [
            {
              name: "OCRPLANE_BASE_URL",
              required: false,
              secret: false,
              kind: "url",
            },
            { name: "OCRPLANE_API_KEY", required: true, secret: true },
          ],
          httpProxies: [
            {
              key: "ocrplane",
              baseUrlEnv: "OCRPLANE_BASE_URL",
              auth: { type: "bearer", secretEnv: "OCRPLANE_API_KEY" },
            },
          ],
        }),
      ),
    ).toThrow();

    // Non-secret secretEnv is rejected.
    expect(() =>
      parsePiPackageReleaseManifest(
        baseManifest({
          env: [
            {
              name: "OCRPLANE_BASE_URL",
              required: true,
              secret: false,
              kind: "url",
            },
            { name: "OCRPLANE_API_KEY", required: true, secret: false },
          ],
          httpProxies: [
            {
              key: "ocrplane",
              baseUrlEnv: "OCRPLANE_BASE_URL",
              auth: { type: "bearer", secretEnv: "OCRPLANE_API_KEY" },
            },
          ],
        }),
      ),
    ).toThrow();

    // Forbidden header name is rejected.
    expect(() =>
      parsePiPackageReleaseManifest(
        baseManifest({
          env: [
            {
              name: "OCRPLANE_BASE_URL",
              required: true,
              secret: false,
              kind: "url",
            },
            { name: "OCRPLANE_API_KEY", required: true, secret: true },
          ],
          httpProxies: [
            {
              key: "ocrplane",
              baseUrlEnv: "OCRPLANE_BASE_URL",
              auth: {
                type: "header",
                headerName: "Authorization",
                secretEnv: "OCRPLANE_API_KEY",
              },
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("evaluates supportsPlatformPreset and evaluatePluginEnvStatus accurately", () => {
    const requirements: PiPackageEnvRequirement[] = [
      { name: "OCRPLANE_BASE_URL", required: true, secret: false, kind: "url" },
      { name: "OCRPLANE_API_KEY", required: true, secret: true },
    ];
    const httpProxies: PiPackageHttpProxy[] = [
      {
        key: "ocrplane",
        baseUrlEnv: "OCRPLANE_BASE_URL",
        auth: { type: "bearer", secretEnv: "OCRPLANE_API_KEY" },
      },
    ];

    expect(supportsPlatformPreset({ env: requirements, httpProxies })).toBe(
      true,
    );
    expect(
      supportsPlatformPreset({
        env: [
          ...requirements,
          { name: "EXTRA_SECRET", required: false, secret: true },
        ],
        httpProxies,
      }),
    ).toBe(false);

    const officialReady = evaluatePluginEnvStatus({
      requirements,
      httpProxies,
      isOfficial: true,
      presetConfiguredKeys: ["OCRPLANE_BASE_URL", "OCRPLANE_API_KEY"],
    });
    expect(officialReady).toMatchObject({
      presetSupported: true,
      presetComplete: true,
      effectiveDefaultMode: "platform_preset",
      complete: true,
      missingRequiredKeys: [],
    });

    const officialIncompletePreset = evaluatePluginEnvStatus({
      requirements,
      httpProxies,
      isOfficial: true,
      presetConfiguredKeys: ["OCRPLANE_BASE_URL"],
      installedMode: "platform_preset",
    });
    expect(officialIncompletePreset).toMatchObject({
      presetSupported: true,
      presetComplete: false,
      effectiveDefaultMode: "custom",
      mode: "platform_preset",
      complete: false,
      missingRequiredKeys: ["OCRPLANE_API_KEY"],
    });

    const privatePlugin = evaluatePluginEnvStatus({
      requirements,
      httpProxies,
      isOfficial: false,
      presetConfiguredKeys: ["OCRPLANE_BASE_URL", "OCRPLANE_API_KEY"],
      installedMode: "platform_preset",
    });
    expect(privatePlugin).toMatchObject({
      presetSupported: false,
      presetComplete: false,
      complete: false,
      missingRequiredKeys: ["OCRPLANE_BASE_URL", "OCRPLANE_API_KEY"],
    });
  });

  it("joins upstream proxy paths verbatim without deduplicating prefix segments", () => {
    expect(
      runtimePluginUpstreamUrl(
        "http://ocr.internal/v1/",
        ["v1", "parse"],
        "?sync=1",
      ),
    ).toBe("http://ocr.internal/v1/v1/parse?sync=1");
    expect(
      runtimePluginUpstreamUrl("http://ocr.internal/api", [], "?page=2"),
    ).toBe("http://ocr.internal/api?page=2");
    expect(() =>
      runtimePluginUpstreamUrl("http://ocr.internal/api", ["..", "secret"]),
    ).toThrow();
    expect(() =>
      runtimePluginUpstreamUrl("ftp://ocr.internal/api", ["parse"]),
    ).toThrow();
  });

  it("triggers capability review when env or httpProxies change while leaving no-env digests untouched", () => {
    const plain = baseManifest();
    const withEnv = baseManifest({
      env: [
        {
          name: "OCRPLANE_BASE_URL",
          required: true,
          secret: false,
          kind: "url",
        },
        { name: "OCRPLANE_API_KEY", required: true, secret: true },
      ],
      httpProxies: [
        {
          key: "ocrplane",
          baseUrlEnv: "OCRPLANE_BASE_URL",
          auth: { type: "bearer", secretEnv: "OCRPLANE_API_KEY" },
        },
      ],
    });
    const changedProxy = baseManifest({
      env: [
        {
          name: "OCRPLANE_BASE_URL",
          required: true,
          secret: false,
          kind: "url",
        },
        { name: "OCRPLANE_API_KEY", required: true, secret: true },
      ],
      httpProxies: [
        {
          key: "ocrplane",
          baseUrlEnv: "OCRPLANE_BASE_URL",
          auth: {
            type: "header",
            headerName: "X-API-Key",
            secretEnv: "OCRPLANE_API_KEY",
          },
        },
      ],
    });

    const cPlain = computePluginCapabilities(plain);
    const cWithEnv = computePluginCapabilities(withEnv);
    const cChanged = computePluginCapabilities(changedProxy);
    expect(cPlain.codeDigest).not.toBe(cWithEnv.codeDigest);
    expect(cWithEnv.codeDigest).not.toBe(cChanged.codeDigest);
    expect(requiresReview(cPlain, cWithEnv)).toBe(true);
    expect(requiresReview(cWithEnv, cChanged)).toBe(true);
  });
});
