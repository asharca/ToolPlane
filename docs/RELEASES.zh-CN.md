# 发布

> **English**: [RELEASES.md](./RELEASES.md)

ToolPlane 现在用 `release-please` 自动计算语义化版本，但发布准备由手动触发。

## 必需的 GitHub 配置

1. 添加 `RELEASE_PLEASE_TOKEN` 仓库 secret。
   该 token 应属于一个有权限的 bot 或维护者账户：
   - 读写 contents
   - 开 pull request
2. 如果分支保护要求每个 PR 都要 review，把 release PR 当作普通 PR 处理，准备好后手动
   合并。

`secrets.GITHUB_TOKEN` 仍用于推送 GHCR 镜像和上传发布产物，但建议使用单独的 token，
这样 release-please 的 PR 才能触发正常的 `pull_request` 工作流。

## 日常 CI

普通推送和 PR 只运行 [`ci.yml`](../.github/workflows/ci.yml)：

- `pnpm lint`
- `pnpm test`
- `pnpm build`

日常开发不会推送 Docker 镜像或创建 GitHub Release。

## 发布流程

1. 用 **Squash and merge** 合并 PR 进 `main`。这样每个 PR 对应一个可发布提交，避免
   changelog 出现重复条目。
2. 要准备发布时，打开 GitHub Actions，在 `main` 上手动运行 `release-please` 工作流。
3. 工作流会开（或更新）一个 release PR，提升 `package.json` 版本并更新
   `CHANGELOG.md`。
4. 审查该 release PR，想发布时合并它。
5. release PR 进入 `main` 后，`release-please` 工作流会创建 Git tag、GitHub
   Release、GHCR 镜像 tag 和 runtime tarball 产物。

无需手动推 tag 或手动改版本号。

## 如何发布

1. 打开 GitHub → Actions → `release-please`。
2. 点击 `Run workflow`。
3. `target_branch` 保持 `main`，除非有意发布其他分支。
4. 等 release PR 打开或更新。
5. 确认提议的版本号和 changelog 无误。
6. 想发布时合并该 PR。

这次合并就是手动的发布闸门。
