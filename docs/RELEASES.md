# Releases

> **中文**：[RELEASES.zh-CN.md](./RELEASES.zh-CN.md)

ToolPlane uses `release-please` to compute semantic versions automatically, but release preparation is started manually. The source of truth is [`release-please.yml`](../.github/workflows/release-please.yml).

## GitHub configuration

A separate `RELEASE_PLEASE_TOKEN` repository secret is recommended for the bot or maintainer account that prepares releases. It needs the contents and pull-request permissions used by release-please. When the secret is absent, the workflow falls back to `secrets.GITHUB_TOKEN`; a separate token is not a prerequisite enforced by this workflow.

`secrets.GITHUB_TOKEN` is used for GHCR login and release-asset uploads. A separate release-please token also lets bot-created PRs trigger the normal `pull_request` event. The CI workflow has a dedicated `pull_request_target` metadata gate for same-repository release-please branches; do not confuse this with a full application test run.

When repository rules require reviews, review and merge the release PR under those rules.

## Daily CI

[`ci.yml`](../.github/workflows/ci.yml) listens to `pull_request`, selected `pull_request_target` events, and `workflow_dispatch`; it does not listen to `push`.

Ordinary PRs and manual CI runs execute lint, tests, the application build, runtime-artifact verification, and Connector checks on Linux, macOS, and Windows. Linux also runs the Docker runtime helper checks.

Same-repository branches beginning `release-please--branches--` use the release-metadata gate instead of rerunning the full suite. That gate requires the changed-file list to be exactly `.release-please-manifest.json`, `CHANGELOG.md`, and `package.json`, then supplies the corresponding Connector gate results. A release PR containing other file changes fails this gate.

A normal feature merge does not rerun full CI or publish an image. A push to `main` does trigger the separate release workflow, but publishing steps run only when release-please creates a release. A pushed `vX.Y.Z` tag is also an explicit publishing path.

## Release flow

1. Merge feature PRs into `main` with **Squash and merge** to keep one releasable commit per PR.
2. Run the `release-please` workflow manually with `target_branch=main` to open or update the release PR.
3. Review the version, changelog, and manifest changes, then merge the release PR when ready to publish.
4. The resulting push to `main` runs release-please with PR creation disabled. When it creates a release, subsequent steps build and publish GHCR image tags and upload the runtime tarball plus its SHA-256 checksum to the GitHub Release.

The standard flow does not require a manual version bump or tag push. The workflow also supports explicit `vX.Y.Z` tag pushes: it validates the tag against `package.json`, then creates or updates the release and publishes artifacts.

## How to publish

1. Go to GitHub → Actions → `release-please` and click `Run workflow`.
2. Keep `target_branch` set to `main`.
3. Review the proposed version and changelog, wait for the release-metadata checks, and merge the release PR when ready.

That merge is the manual release gate. Although dispatch accepts another `target_branch`, the automatic branch-push publishing trigger only watches `main`; preparing a PR on another branch does not by itself configure automatic publishing for that branch.
