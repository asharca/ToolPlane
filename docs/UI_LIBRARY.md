# Shared UI and CI

> **中文**：[UI_LIBRARY.zh-CN.md](./UI_LIBRARY.zh-CN.md)

The shared UI library is maintained in https://github.com/asharca/ui and
published to npm as `@asharca/ui`. ToolPlane consumes a released version, just
like any other application. Keep routing, authentication, API clients, and
business adapters in ToolPlane.

## Updating UI

Make component or stylesheet changes in `asharca/ui`, run its checks, and merge
the PR. Release a new package version using that repository's release workflow.
ToolPlane no longer owns the UI source or its npm publisher.

Update the application in a ToolPlane PR:

```bash
pnpm add @asharca/ui@X.Y.Z --save-exact
```

Check the release's React and assistant-ui peer requirements before upgrading.
Keep the existing `@asharca/ui/styles.css` import in the global stylesheet.
Rebuild and deploy ToolPlane to adopt the package's component and style changes.

## CI and merging

Ordinary PRs, including stacked PRs, run the full [`ci.yml`](../.github/workflows/ci.yml) workflow. It can also be started manually. Merging into `main` does not repeat the full CI run because this workflow has no `push` trigger.

Same-repository release-please branches beginning `release-please--branches--` are an exception: `pull_request_target` validates that only `.release-please-manifest.json`, `CHANGELOG.md`, and `package.json` changed, then supplies the Connector gate results. It does not rerun application tests or Connector tests for that metadata-only PR. See [Releases](./RELEASES.md).

The workflow's check names are `validate`, `connector (ubuntu-latest)`, `connector (macos-latest)`, and `connector (windows-latest)`. Branch protection, required approvals, administrator bypasses, and restrictions on direct pushes or deletion are configured separately in GitHub repository rules; the workflow file alone does not establish or enforce those policies.

UI publishing validates the UI release in its own repository. ToolPlane's
`release-please.yml` application release flow and `vX.Y.Z` tags remain separate;
a normal feature merge does not publish a new UI package.
