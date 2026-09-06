# Plan, Generate, or Repair Playwright Tests

Use only the mode requested or needed by the task. Ordinary browser verification
does not require a plan file, seed test, new fixture, or test framework.

## Prerequisites

Read the repository's test commands, existing configuration, nearby tests, and any
user-supplied acceptance criteria. ToolPlane uses Vitest; do not introduce a
Playwright suite unless that setup is part of the request. If an existing local
Playwright runner is available, use `pnpm exec playwright`, not npm/npx.

For CLI commands, use the named session and artifact boundaries in `SKILL.md`.
Inspect the installed runner's help before relying on `--debug=cli` or other
version-specific features. See [playwright-tests.md](playwright-tests.md).

## Plan

Identify the relevant user journey and observable outcomes. Use existing test
setup and authorized test data. A task-specific plan can stay in the response;
write a plan file only when requested or required by the existing workflow.

Cover the requested behavior and meaningful failure cases. Expand coverage for
authentication, persistence, or cross-workspace access where those are affected.
Do not enumerate unrelated application features.

If fixtures or a seed test establish essential login or application state, enter
through that setup when exploring. Otherwise, opening the target URL directly
is sufficient. Create reusable fixtures only when actual repeated setup warrants
them, and keep scenarios independent of each other's state.

## Generate

1. Observe the flow with `playwright-cli` snapshots and actions. Use generated
   Playwright code as a starting point; adapt it to existing test conventions.
2. Use role, label, or test-id locators observed in the page. Do not retain
   ephemeral snapshot refs in test code or assume generated selectors are stable.
3. Assert the requested outcome explicitly. Generated actions alone do not verify
   behavior. For example, after a save, assert a success state or persisted value.
   Avoid assertions whose locator already requires the value being asserted.
4. Keep the repository's file layout and fixtures. Do not require one file per
   scenario, a `test.describe` wrapper, or comments repeating every test action.
5. Run the changed test and inspect the result. Broaden to related tests only for
   shared setup changes, failures, or other concrete impact.

An assertion after an observed action might be:

```ts
await page.getByRole('button', { name: 'Save' }).click();
await expect(page.getByRole('status')).toHaveText('Saved');
```

The names and expected text must come from the task and actual UI, not this
example. Prefer assertions on visible behavior over whole-page snapshots.

## Repair

Start from the reported failure, not the entire suite:

```bash
PLAYWRIGHT_HTML_OPEN=never pnpm exec playwright test path/to/existing.spec.ts
```

Inspect the test, application code, failing snapshot, console, and relevant
requests. If necessary, attach to a focused debug run as described in
[playwright-tests.md](playwright-tests.md), preserving its fixtures and hooks.

- Fix stale locators or setup when the intended behavior is unchanged.
- Fix application regressions when implementation work is authorized; preserve
  the assertion that exposed the bug. For test-only tasks, report the application
  defect and leave the failing coverage intact.
- Change expectations or a supplied spec only when the requested behavior or
  other concrete evidence establishes the new contract. A live application's
  current output is not proof of its correctness.
- If the contract remains genuinely ambiguous after inspection, ask one focused
  question with expected and observed behavior. Continue independent work.
- Wait for a specific visible state, URL, or response. Do not add arbitrary sleeps,
  use `networkidle` as a readiness assertion, skip hooks, or mark a test skipped
  merely to obtain a passing run.

Stop any debug process created for the task before the normal rerun. Run the
affected test after a fix. Once it and required related checks pass, finish;
otherwise report the remaining failure and evidence. Do not keep retrying without
a new diagnosis or change.

## Related references

- [playwright-tests.md](playwright-tests.md): running and attaching to tests.
- [request-mocking.md](request-mocking.md): intentional isolated network scenarios.
- [session-management.md](session-management.md): task-owned browser sessions.
