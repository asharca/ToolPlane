import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "packages/*/dist/**",
    "next-env.d.ts",
    ".remember/**",
    ".worktrees/**",
    "src/components/motion/**",
    "src/components/agents/**",
    "src/components/workspace/**",
    "src/lib/ease.ts",
    "src/lib/utils.ts",
    "src/lib/touch.ts",
    "src/lib/presence-gate.tsx",
    "src/lib/command-search.ts",
    "src/lib/hooks/**",
  ]),

]);
export default eslintConfig;
