# Releases

ToolPlane now uses `release-please` to compute semantic versions
automatically, but release preparation is started manually.

## Required GitHub setup

1. Add a `RELEASE_PLEASE_TOKEN` repository secret.
   The token should belong to a bot or maintainer account with permission to:
   - read and write contents
   - open pull requests
2. If branch protection requires reviews for every PR, treat the release PR the
   same as any other pull request and merge it manually when ready.

`secrets.GITHUB_TOKEN` is still used to push GHCR images and upload release
artifacts, but a separate token is recommended so release-please PRs can
trigger the normal `pull_request` workflows.

## Daily CI

Regular pushes and pull requests only run [`ci.yml`](../.github/workflows/ci.yml):

- `pnpm lint`
- `pnpm test`
- `pnpm build`

No Docker image push or GitHub Release happens during normal development.

## Release flow

1. Merge conventional commits into `main`.
2. When you want to prepare a release, open GitHub Actions and run the
   `release-please` workflow on `main`.
3. The workflow opens or updates a release PR that bumps `package.json` and
   `CHANGELOG.md`.
4. Review that release PR and merge it when you want to publish.
5. After the release PR lands on `main`, the `release-please` workflow creates
   the Git tag, GitHub Release, GHCR image tags, and runtime tarball assets.

No manual tag push or manual version bump is required.

## How to publish

1. Go to GitHub -> Actions -> `release-please`.
2. Click `Run workflow`.
3. Leave `target_branch` as `main` unless you intentionally release another branch.
4. Wait for the release PR to open or update.
5. Confirm the proposed version and changelog look right.
6. Merge that PR when you want to publish.

That merge is the manual release gate.
