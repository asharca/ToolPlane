# UI 组件库

[English](./UI_LIBRARY.md)

本轮按用户明确选择迁移到 https://asharca.github.io/ui/llms.txt 的源码组件目录，不再使用旧 `@asharca/ui@0.2.1` npm 包。

源码固定提交、文件哈希和适配说明见 `src/components/ui/beui/provenance.json`。所有应用按钮、输入、选择框和表格通过 `src/components/ui/Controls.tsx`；弹窗和浮层采用统一 beUI 外观，保留 Radix 的焦点、键盘及嵌套关闭机制。原生表单事件、FormData、重置、校验、文件上传和拖放不能因为视觉替换而改变。

`compositions` 是明确保留来源及许可证的应用组合层，用于维持 assistant-ui 消息流和导航等接口，不冒充新版 registry 的组件。主视觉在统一主题和 `beui-overrides.css` 维护。没有复制旧包名的别名，没有修改业务权限和数据库。

验收包含新增组件契约测试和已有全量功能回归、类型检查、Lint、生产构建及运行产物验证。浏览器、真实模型与外部服务未执行时必须另行标注，不能把替身测试称为真实端到端通过。
