# 共享 UI 与 CI

> **English**: [UI_LIBRARY.md](./UI_LIBRARY.md)

共享 UI 库维护在 https://github.com/asharca/ui，以 `@asharca/ui` 发布到 npm。ToolPlane
像其他应用一样消费其发布版本。路由、鉴权、API 客户端和业务适配层保留在 ToolPlane。

## 更新 UI

组件或样式改动在 `asharca/ui` 中进行，跑它的检查并合并 PR。在该仓库用配套的
`ui-vX.Y.Z` tag 发布新包版本。ToolPlane 不再拥有 UI 源码或其 npm 发布权。

在 ToolPlane PR 中更新应用：

```bash
pnpm add @asharca/ui@X.Y.Z --save-exact
```

升级前检查该版本的 React 和 assistant-ui peer 要求。保留全局样式表中现有的
`@asharca/ui/styles.css` 导入。重新构建并部署 ToolPlane 以采用包里的组件和样式变更。

## CI 与合并

每个 PR（包括堆叠 PR）都运行完整 CI 工作流，也可手动触发。合并进 `main` 不会重复
跑一次完整 CI。

受保护的 `main` 分支要求 PR 保持最新，并通过以下 GitHub Actions 检查：`validate`、
`connector (ubuntu-latest)`、`connector (macos-latest)`、`connector (windows-latest)`。
管理员同样受这些要求约束；直接推送、强制推送和删除分支都被阻止。检查是必需的，但此
仓库不要求第二位维护者批准。

UI 发布在其自己的仓库中校验 UI 版本。ToolPlane 现有的 `release-please.yml` 应用发布
流程和 `vX.Y.Z` tag 保持不变；普通功能合并不会发布新的 UI 包。
