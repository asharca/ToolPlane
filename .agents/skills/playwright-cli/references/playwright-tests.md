# Running Playwright Tests

Use the repository's existing test script or installed local Playwright runner.
These commands require an existing Playwright setup; they are not a reason to
replace ToolPlane's Vitest suite or install another framework.

Run the affected test first. Disable automatic HTML report opening for unattended
runs:

```bash
PLAYWRIGHT_HTML_OPEN=never pnpm exec playwright test path/to/existing.spec.ts
```

Use a broader run only when the task or changed shared behavior requires it.

## Debugging an existing test

If the installed version's help lists `--debug=cli`, run the focused test in a
background terminal and inspect its output for the debugging session name:

```bash
PLAYWRIGHT_HTML_OPEN=never pnpm exec playwright test path/to/existing.spec.ts --debug=cli
# Attach using the actual session name printed by the runner.
playwright-cli attach tw-abcdef
```

If that option is unavailable, use the runner's supported debug mode or existing
failure artifacts; do not upgrade tools automatically for this workflow.

Keep the debug process running while inspecting the paused page. Preserve the
test's fixtures and hooks. Step or resume according to the printed instructions,
then inspect the failing state using snapshots, console output, and requests.
Direct subsequent CLI commands to the session established by the attachment.

Generated action code can help repair a locator, but an assertion failure may
also reveal an application bug. Check the intended behavior before changing an
expectation; see [test-generation.md](test-generation.md#repair).

When done, detach the session and stop the debug process you started. Rerun the
affected test normally and report its actual result, including any remaining
failure. Do not leave a paused debug process behind or stop unrelated sessions.
