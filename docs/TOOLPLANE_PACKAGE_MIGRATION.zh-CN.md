# ToolPlane 包迁移清单

将现有本地能力转换为外部包时，请按以下清单执行：

1. 将实现放入 GitHub 仓库，或按标准目录制作 ZIP。
2. 添加 `toolplane-package.json`，并使用 `docs/toolplane-package.schema.json` 校验。
3. 在 `resources/<resource-id>/manifest.json` 中声明资源。
4. 删除密钥、工作区 ID、本地数据库 ID、缓存和机器路径。
5. 固定运行时与依赖版本，不使用安装脚本或可变分支。
6. 使用带 40 位 commit 的 GitHub 地址，或生成可复现的 ZIP。
7. 通过“资源中心 → 导入”导入，检查预览、来源摘要和安全结果。
8. 先提交私有版本；确认内容后再申请公开审核。
9. 后续更新创建新的包版本，并重新导入不可变来源。
10. 保留源仓库和发布说明，方便审核复现。

旧的本地 MCP、Agent、Assistant 和 Pi 组合发布入口已退出。已有资源仍可使用和管理；新分发统一经过包标准边界。
