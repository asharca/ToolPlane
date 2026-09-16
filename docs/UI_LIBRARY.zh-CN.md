# 共享 UI 与 CI

> **English**: [UI_LIBRARY.md](./UI_LIBRARY.md)

共享 UI 库维护在 https://github.com/asharca/ui，以 `@asharca/ui` 发布到 npm。ToolPlane
像其他应用一样消费其发布版本。路由、鉴权、API 客户端和业务适配层保留在 ToolPlane。

## 更新 UI

组件或样式改动在 `asharca/ui` 中进行，跑它的检查并合并 PR，再使用该仓库自己的发布工作流发布新包版本。
ToolPlane 不再拥有 UI 源码或其 npm 发布权。

在 ToolPlane PR 中更新应用：

```bash
pnpm add @asharca/ui@X.Y.Z --save-exact
```

升级前检查该版本的 React 和 assistant-ui peer 要求。保留全局样式表中现有的
`@asharca/ui/styles.css` 导入。重新构建并部署 ToolPlane 以采用包里的组件和样式变更。

## CI 与合并

普通 PR（包括堆叠 PR）运行完整的 [`ci.yml`](../.github/workflows/ci.yml)，也可手动触发。该工作流没有 `push` 触发器，因此合并进 `main` 不会重复运行完整 CI。

同仓库中以 `release-please--branches--` 开头的发布分支是例外：`pull_request_target` 校验变更文件只有 `.release-please-manifest.json`、`CHANGELOG.md` 和 `package.json`，通过后提供 Connector 校验结果；这种纯元数据 PR 不重新执行应用或 Connector 测试。参见[发布](./RELEASES.zh-CN.md)。

工作流提供的检查名称为 `validate`、`connector (ubuntu-latest)`、`connector (macos-latest)` 和 `connector (windows-latest)`。分支保护、必需的 review、管理员绕过权限，以及直接推送或删除限制，都在 GitHub 仓库规则中单独配置，不能仅凭工作流文件断言这些策略已启用或生效。

UI 发布在其自己的仓库中校验 UI 版本。ToolPlane 的 `release-please.yml` 应用发布流程和
`vX.Y.Z` tag 与此独立；普通功能合并不会发布新的 UI 包。
