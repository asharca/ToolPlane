# UI 组件库

[English](./UI_LIBRARY.md)

本轮按用户明确选择迁移到 https://asharca.github.io/ui/llms.txt 的源码组件目录，不再使用旧 `@asharca/ui@0.2.1` npm 包。

源码固定提交、文件哈希和适配说明见 `src/components/ui/beui/provenance.json`。所有应用按钮、输入、选择框和表格通过 `src/components/ui/Controls.tsx`；弹窗和浮层采用统一 beUI 外观，保留 Radix 的焦点、键盘及嵌套关闭机制。原生表单事件、FormData、重置、校验、文件上传和拖放不能因为视觉替换而改变。

`compositions` 是明确保留来源及许可证的应用组合层，用于维持 assistant-ui 消息流和导航等接口，不冒充新版 registry 的组件。主视觉在统一主题和 `beui-overrides.css` 维护。没有复制旧包名的别名，没有修改业务权限和数据库。

验收包含新增组件契约测试和已有全量功能回归、类型检查、Lint、生产构建及运行产物验证。浏览器、真实模型与外部服务未执行时必须另行标注，不能把替身测试称为真实端到端通过。


## 工作区源码组合

主控制台已使用固定版本的 `WorkspaceShell` 和 `WorkspaceTabBar` 源码及其菜单、浮层和运动辅助组件。标签选择、固定顺序、窗口打开、会话存储和未保存内容确认仍由 ToolPlane 管理，不复制组件演示中的业务状态。保留平台 1024px 断点、中英文标签及编辑器快捷键；受控折叠不会重新挂载表单。源码改动及来源哈希一并记录在 provenance 文件。

## 浏览器验收

`ui-browser` 工作流启动真实生产构建、独立 PostgreSQL 数据库和 Chromium。`tests/browser/platform-ui.mjs` 检查登录、组件挂载、表单创建与刷新后持久化、表格过滤、可用性修改、标签导航、草稿保留、A2A 禁用配置、页面入口、成员权限、移动端焦点和暗色主题；截图及逐项结果保存为 `ui-browser-evidence`。测试不拦截业务 API，也不以 mock 返回值冒充保存成功。

运行命令：`pnpm exec tsx scripts/ui/seed-browser.ts`，`pnpm build`，`node tests/browser/platform-ui.mjs`。工具链由工作流隔离安装并固定版本，不加入生产依赖。fixture 必须显式设置 `TOOLPLANE_UI_E2E=1`、独立空的 loopback `toolplane_ui_e2e` 数据库及临时密码；脚本拒绝正常开发库、外部数据库或生产部署。

这是界面与真实本地服务端集成验收，不代表真实模型、CLI 执行、第三方渠道或外部 A2A 服务验收。实际通过状态以当前提交 CI 和逐项报告为准，不能用旧提交结果替代。
