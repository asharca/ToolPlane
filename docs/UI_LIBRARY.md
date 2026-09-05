# Shared UI and CI

The shared UI library is maintained in https://github.com/asharca/ui and
published to npm as `@asharca/ui`. ToolPlane consumes a released version, just
like any other application. Keep routing, authentication, API clients, and
business adapters in ToolPlane.

## Updating UI

Make component or stylesheet changes in `asharca/ui`, run its checks, and merge
the PR. Release a new package version from that repository using its matching
`ui-vX.Y.Z` tag. ToolPlane no longer owns the UI source or its npm publisher.

Update the application in a ToolPlane PR:

```bash
pnpm add @asharca/ui@X.Y.Z --save-exact
```

Check the release's React and assistant-ui peer requirements before upgrading.
Keep the existing `@asharca/ui/styles.css` import in the global stylesheet.
Rebuild and deploy ToolPlane to adopt the package's component and style changes.

## CI and merging

Every PR, including stacked PRs, runs the full CI workflow. It can also be
started manually. Merging into `main` does not repeat the same full CI run.

The protected `main` branch requires an up-to-date PR and these GitHub Actions
checks: `validate`, `connector (ubuntu-latest)`, `connector (macos-latest)`, and
`connector (windows-latest)`. Administrators must follow the same requirements;
direct pushes, force pushes, and branch deletion are blocked. Checks are
required, but a second maintainer's approval is not required for this repository.

UI publishing validates the UI release in its own repository. ToolPlane's
existing `release-please.yml` application release flow and `vX.Y.Z` tags remain
unchanged; a normal feature merge does not publish a new UI package.
