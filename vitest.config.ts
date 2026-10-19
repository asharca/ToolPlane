import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fumadocsMdx } from "fumadocs-mdx/vite";

export default defineConfig({
  plugins: [react(), ...fumadocsMdx({ index: { target: "default" } })],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcovonly"],
      reportsDirectory: "./coverage",
      include: [
        "src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
        "packages/connector/bin/**/*.mjs",
      ],
      exclude: ["**/*.d.ts"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "server-only": resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
});
