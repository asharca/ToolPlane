import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Generated application-composition ports retain their published semantics.
  { files: ['src/components/ui/compositions/**/*.js'], rules: { '@typescript-eslint/no-unused-vars': 'off', '@typescript-eslint/no-this-alias': 'off', 'react-hooks/set-state-in-effect': 'off' } },
  // Pinned registry effects synchronize media queries and validation feedback.
  { files: ['src/components/ui/beui/**/*.{ts,tsx}', 'src/components/ui/Forms.tsx'], rules: { 'react-hooks/set-state-in-effect': 'off' } },
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
  ]),
]);

export default eslintConfig;
