# 共享 UI 与 CI

> **English**: [UI_LIBRARY.md](./UI_LIBRARY.md)

当前 beUI 源码来自 https://asharca.github.io/ui/llms.txt 提供的 Registry。
ToolPlane 将原版组件源码安装到 `src/components/`，将原版 helper 安装到
`src/lib/`，路由、鉴权、API 客户端和业务适配层仍保留在 ToolPlane。

## 更新 UI

Registry 源码不添加主题或组件外观覆盖。更新时从原版目录发现组件，读取 detail/source
和依赖后，合并到对应的 `src/components/` 或 `src/lib/` 路径，并保留原版主题 token
和动画行为。

ToolPlane 只允许添加为保留 Server Action、FormData、工作区权限、流式输出或安全边界
所需的领域适配器；不得重新定义 beUI 样式或建立第二套通用组件库。

公开首页组合 Registry 的徽章、倾斜卡片、按钮、输入框、标签页与 FAQ 组件。
GitHub 源码链接统一使用 `react-icons/fa` 的 `FaGithub`。导航栏的 Popover
触发器和按钮须位于同一客户端组件树，确保克隆触发器的事件在 hydration 后仍生效。
顶部吸附导航采用透明外层和半透明毛玻璃卡片。
首页使用原版 `ShaderBackground` 的 metaballs，以低透明度、低速运行，
固定铺满视口，滚动时保持在整页内容之后，不拦截交互。站点布局通过 isolate
使负 z-index 背景层位于底色之上；减少动态效果设置会冻结 Shader 动画。
公开首页（`/`）固定使用深色主题，Shader 不透明度为 30%。共享主题提供器通过
`forcedTheme` 固定首页外观并隐藏主题切换按钮，不修改已保存的主题偏好；其他页面保留原有主题选择。

所有 Center Morph Modal 使用 `CenterMorphModalContent` 内置关闭按钮，通过
`closeButtonLabel` 本地化；不得自绘标题栏关闭按钮或另写 Escape 监听。底部取消操作使用
`CenterMorphModalClose`。未保存检查和开关状态更新保留在 `onOpenChange`；导航及父级卸载
必须等到 `CenterMorphModalContent.onExitComplete` 再执行。该接入回调透传已有的
`AnimatePresence` 退出完成事件，不修改 Registry 动画，也不使用定时器模拟完成。
提交中可暂时隐藏原生按钮并禁用关闭，但不另建关闭实现。标题栏为内置按钮预留空间，
嵌入弹窗的面板不再显示自身用于独立展示的关闭按钮。

MCP 列表使用一行搜索与状态筛选，每项仅常驻启停或配置操作；日志、重启与需确认的
删除收进现有 Popover，朝视口空间更充足的一侧展开。选中条目后才显示批量操作，
新增入口只在列表上方出现一次。新增弹窗采用单列 JSON 表单，不显示推测的连接地址。
示例、可选文件与网络选项使用 BouncyAccordion；折叠时显示当前网络模式，仍保留
FormData 提交值。信任提示、远程 HTTP 风险提示、配置校验及固定底栏均保留。

工作区页面不再显示面包屑栏，也不保留原行占位。详情页保留正文标题与操作区；
`DashboardHeader` 仅为没有可见一级标题的页面提供屏幕阅读器标题。

当前 Registry-source 接入不使用 `@asharca/ui` npm 包。除非项目明确切换接入策略并迁移
全部 Registry 组件回发布包，否则不要重新引入该依赖。

智能体编辑使用受视口约束的完整设置弹窗。桌面导航使用扁平列表，每项独占一行并左对齐，
不显示父级分组标题；手机使用无分组的原生选择器。表单显示当前配置分区与自动保存状态。
Pi 模型与身份配置保留在基础，沙箱和 A2A 接入可直接从同一导航进入。

共享资源树行将操作区（包括通过 Portal 渲染的三点菜单）的点击和双击与行选择、
展开／折叠、重命名隔离。树的键盘快捷键只处理行本身接收的事件，菜单控件保留
自身的键盘激活与 Escape 关闭行为。

智能体和助手共用紧凑的 Morph Popover 模型选择器，无居中遮罩，从按钮旁空间较大的一侧展开；提供商标题使用不透明背景，可折叠并显示模型数量，模型行保留能力标签，
右侧显示输入／输出基础价格，单位 `$/M`（每百万 Token 的美元价格）；未配置价格显示 `—`，不视为免费。
搜索时临时展开匹配分组，清空搜索后恢复折叠状态。模型列表独立滚动，长名称在窄屏换行。
开启联网搜索后，工具栏持续显示选中态的高亮地球按钮，即使它未被固定。关闭后移除临时按钮；
已固定的按钮保持原位并恢复未选中样式。切换不会改动已保存的工具栏配置，每次发送使用当前联网状态。
助手对话由服务器持有并持续消费执行流；关闭网页或切换会话不会中止模型及联网搜索。
重新打开当前会话会恢复已有输出流，不会重复发送问题；已完成的回答从数据库读取。
“停止”会显式取消对应轮次并保留已生成内容，同一会话只允许一个轮次运行。
仍遵循现有五分钟轮次期限和工作区权限检查。实时重放保存在单一运行时进程中，
结束后保留 60 秒；不保证服务器重启或崩溃后续跑，也不会自动重试副作用操作。
执行中的会话及其所属助手在图标右上角显示绿色呼吸角标。页面可见时每两秒读取一次
经工作区授权的服务器状态，返回页面时立即刷新；完成、失败或停止后移除角标。
开启“减少动态效果”时保留静态绿点，不播放呼吸动画。

## CI 与合并

普通 PR（包括堆叠 PR）运行完整的 [`ci.yml`](../.github/workflows/ci.yml)，也可手动触发。该工作流没有 `push` 触发器，因此合并进 `main` 不会重复运行完整 CI。

同仓库中以 `release-please--branches--` 开头的发布分支是例外：`pull_request_target` 校验变更文件只有 `.release-please-manifest.json`、`CHANGELOG.md` 和 `package.json`，通过后提供 Connector 校验结果；这种纯元数据 PR 不重新执行应用或 Connector 测试。参见[发布](./RELEASES.zh-CN.md)。

工作流提供的检查名称为 `validate`、`connector (ubuntu-latest)`、`connector (macos-latest)` 和 `connector (windows-latest)`。分支保护、必需的 review、管理员绕过权限，以及直接推送或删除限制，都在 GitHub 仓库规则中单独配置，不能仅凭工作流文件断言这些策略已启用或生效。

UI 发布在其自己的仓库中校验 UI 版本。ToolPlane 的 `release-please.yml` 应用发布流程和
`vX.Y.Z` tag 与此独立；普通功能合并不会发布新的 UI 包。
