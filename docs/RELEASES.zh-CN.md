# 发布

> **English**: [RELEASES.md](./RELEASES.md)

ToolPlane 用 `release-please` 自动计算语义化版本，但发布准备由手动触发。实际流程以 [`release-please.yml`](../.github/workflows/release-please.yml) 为准。

## GitHub 配置

建议为准备发布的 bot 或维护者账户配置独立的 `RELEASE_PLEASE_TOKEN` 仓库 secret，并授予 release-please 所需的 contents 和 pull-request 权限。未配置时，工作流会回退到 `secrets.GITHUB_TOKEN`；独立 token 不是该工作流强制要求的前置条件。

`secrets.GITHUB_TOKEN` 用于登录 GHCR 和上传发布产物。独立的 release-please token 还能让 bot 创建的 PR 触发正常的 `pull_request` 事件。CI 对同仓库的 release-please 分支另外提供 `pull_request_target` 元数据校验，不能把该校验等同于完整应用测试。

仓库规则要求 review 时，release PR 也应按这些规则审查和合并。

## 日常 CI

[`ci.yml`](../.github/workflows/ci.yml) 监听 `pull_request`、指定的 `pull_request_target` 事件和 `workflow_dispatch`，不监听 `push`。

普通 PR 和手动 CI 运行会执行 lint、测试、应用构建、runtime 产物校验，以及 Linux、macOS、Windows 上的 Connector 检查。Linux 还执行 Docker runtime helper 检查。

同仓库中以 `release-please--branches--` 开头的分支使用发布元数据校验，不重复执行完整测试套件。该校验要求变更文件恰好为 `.release-please-manifest.json`、`CHANGELOG.md` 和 `package.json`，通过后提供对应的 Connector 校验结果。release PR 若混入其他文件变更，会在此校验失败。

普通功能合并不会重复运行完整 CI，也不会发布镜像。推送到 `main` 会触发独立的发布工作流，但只有 release-please 创建了 release 才执行发布步骤。推送 `vX.Y.Z` tag 也是一条显式发布路径。

## 发布流程

1. 用 **Squash and merge** 把功能 PR 合并进 `main`，使每个 PR 对应一个可发布提交。
2. 手动运行 `release-please` 工作流，设置 `target_branch=main`，打开或更新 release PR。
3. 审查版本号、changelog 和 manifest 的变更，准备好发布时合并 release PR。
4. 合并产生的 `main` 推送会运行 release-please，但禁用 PR 创建；当它创建了 release，后续步骤才构建并发布 GHCR 镜像 tag，并将 runtime tarball 及 SHA-256 校验文件上传到 GitHub Release。

标准流程无需手动改版本号或推 tag。工作流也支持显式推送 `vX.Y.Z` tag：先检查 tag 与 `package.json` 版本一致，再创建或更新 release 并发布产物。

## 如何发布

1. 打开 GitHub → Actions → `release-please`，点击 `Run workflow`。
2. 保持 `target_branch=main`。
3. 审查提议的版本号和 changelog，等待发布元数据检查通过，准备好后合并 release PR。

这次合并就是手动发布闸门。虽然 dispatch 接受其他 `target_branch`，自动分支推送发布只监听 `main`；在其他分支准备 release PR，不代表该分支已经配置了自动发布。
