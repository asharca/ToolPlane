# Browser Session Management

Use a unique named session to isolate this task's cookies, storage, tabs, and
navigation from other work. Inspect existing sessions before choosing a name:

```bash
playwright-cli list
playwright-cli -s=tp-check open http://localhost:3000
playwright-cli -s=tp-check snapshot
playwright-cli -s=tp-check close
```

`tp-check` is an example. If it already exists, choose another name. Keep `-s`
on every command; omitting it uses the default session and may affect other work.
Reference snippets without a session flag still require the task's named session.

## Separate sessions

Use distinct sessions for distinct identities or comparisons. Separate browser
contexts do not isolate the application's database: coordinate any shared test
data and do not run overlapping ToolPlane integration tests.

```bash
playwright-cli -s=tp-public open http://localhost:3000
playwright-cli -s=tp-auth open http://localhost:3000/app/login
playwright-cli -s=tp-public snapshot
playwright-cli -s=tp-auth snapshot
playwright-cli -s=tp-public close
playwright-cli -s=tp-auth close
```

## Persistence and configuration

Use the default in-memory profile unless the task requires persistence. Inspect
the installed CLI's help before using optional browser/configuration flags:

```bash
playwright-cli -s=tp-check open http://localhost:3000 --browser=firefox
playwright-cli -s=tp-check open http://localhost:3000 --config=.playwright/my-cli.json
playwright-cli -s=tp-check open http://localhost:3000 --persistent
playwright-cli -s=tp-check open http://localhost:3000 --profile=.playwright-cli/tp-check/profile
```

These are alternatives, not a sequence. Use only an existing, relevant config
file. Treat a persisted profile as sensitive; keep it under the ignored artifact
directory and do not reuse someone else's login state without authorization.

## Attach to an existing browser

Attach only when use of that browser is within the requested scope. Depending
on the installed version and the browser's debugging setup, options include:

```bash
playwright-cli -s=tp-attached attach --cdp=chrome
playwright-cli -s=tp-attached attach --cdp=http://localhost:9222
playwright-cli -s=tp-attached attach --extension
```

Use only the required connection method. Do not change a user's browser security
settings to make attachment work without authorization. End an attached session
without closing the external browser:

```bash
playwright-cli -s=tp-attached detach
```

For an existing test runner's debug session, use the session name it prints; see
[playwright-tests.md](playwright-tests.md#debugging-an-existing-test).

## Cleanup

Close only sessions opened for this task; detach from externally owned browsers.
If a task-owned process is stuck, target that process rather than all browser
processes. Do not use `close-all` or `kill-all` as routine cleanup.

Delete a persisted profile only when this task created it as disposable data and
it is no longer needed. Do not delete unrelated profiles or requested evidence.
