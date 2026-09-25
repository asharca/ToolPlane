# UI library

The platform uses the source registry selected at https://asharca.github.io/ui/llms.txt, pinned to `85b080aafe2f7e3aaf720e5a2ffdf035289c49c1`. The former `@asharca/ui@0.2.1` npm package is not the same catalog and has been removed.

## Ownership and architecture

- `src/components/ui/beui`: pinned registry Button, Input and their helpers, MIT license and file hashes.
- `Controls.tsx`: form-compatible application adapters. Native events, refs, reset, required validation, multiple selection, form association and drag-and-drop are preserved.
- `Dialog.tsx` and `primitives.tsx`: beUI surface/motion styling over existing Radix headless focus, dismissal and keyboard primitives. Aesthetic reuse does not justify replacing a proven focus stack with a partial custom trap.
- `compositions`: explicitly attributed, application-specific assistant-ui and layout ports. These retain chat streaming and navigation state; they are not claimed to be registry components.
- `composition-layout.css` retains geometry; `beui-overrides.css` owns the new visual treatment. All controls inherit the app theme.

## Verification

Run `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test`, `pnpm build` and `pnpm runtime:assemble`. New contract tests cover real form events/reset, disabled links, confirmation, keyboard focus and native drag events. API/auth/DB/approval logic is unchanged. Existing functionality regressions must be fixed, not skipped. Actual CLI/model and production integrations remain separate acceptance checks.

The migration script uses AST offset edits and a fixed upstream commit. It is a one-time migration and refuses an already migrated package. Keep future source updates explicit and update provenance.
