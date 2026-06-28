# i18n 中文支持设计文档

**日期：** 2026-06-28  
**范围：** 全站（公开目录站 + 控制台 + 认证页 + API 错误边界）  
**语言：** 英文（en）+ 简体中文（zh）

---

## 目标

为 mcp-market 添加中英文双语支持。语言偏好通过 cookie 持久化，无 URL 变化。登录用户的偏好同步到数据库账户，跨设备生效。

---

## 技术选型

- **库：** next-intl（专为 Next.js App Router 设计，Server Components 原生支持）
- **模式：** `localePrefix: 'never'`（URL 不变）
- **翻译来源：** 静态 JSON 文件（`messages/en.json`、`messages/zh.json`）
- **语言切换：** Header 右侧 `EN | 中` 按钮 → Server Action 写 cookie

---

## 文件结构

```
messages/
  en.json              # 英文翻译（约 300–400 key）
  zh.json              # 中文翻译（同结构）
src/i18n/
  config.ts            # locales: ['en', 'zh'], defaultLocale: 'en', localePrefix: 'never'
  request.ts           # next-intl getRequestConfig — 读 cookie 确定 locale
src/middleware.ts      # next-intl createMiddleware — 拦截所有请求注入 locale
src/components/layout/
  LocaleSwitcher.tsx   # EN | 中 切换按钮（Client Component）
```

---

## Locale 解析优先级

1. `NEXT_LOCALE` cookie（用户显式选择，httpOnly，1 年有效期）
2. `Accept-Language` 请求头（浏览器首选语言，自动检测）
3. 默认 `'en'`

---

## 语言切换流程

1. 用户点击 Header 里的语言切换器
2. 调用 Server Action `setLocale(locale)`：
   - 写 `NEXT_LOCALE` cookie
   - 若用户已登录，更新 `User.locale`（DB）
   - 调用 `revalidatePath('/', 'layout')` 触发页面重渲染
3. 页面以新语言重新渲染（无页面跳转）

**登录时同步：** 登录 action 成功后读取 `User.locale`，若有值则覆盖写 cookie，实现跨设备语言恢复。

---

## 数据库变更

```prisma
model User {
  // 新增一列
  locale  String  @default("en")
  // ...其余字段不变
}
```

无需数据回填（default 值覆盖所有现有用户）。

---

## 消息文件结构（按功能域分层）

```json
{
  "header": { "mcpServers": "...", "agentSkills": "...", "sellSkills": "...", "signIn": "...", "dashboard": "..." },
  "footer": { "browse": "...", "rankings": "...", "about": "..." },
  "home": { "hero": { "title": "...", "subtitle": "..." }, ... },
  "search": { "placeholder": "...", "noResults": "...", ... },
  "server": { "tools": "...", "install": "...", ... },
  "auth": { "signIn": "...", "signUp": "...", "email": "...", "password": "...", ... },
  "console": { "sidebar": { ... }, "agents": { ... }, "deployments": { ... }, "settings": { ... } },
  "errors": { "notFound": "...", "serverError": "...", "unauthorized": "..." },
  "common": { "loading": "...", "save": "...", "cancel": "...", "delete": "...", ... }
}
```

---

## 翻译覆盖范围（实施顺序）

### 波次 1 — 共享 UI
- `Header`、`Footer`、`Logo` 文字
- 通用错误页（`not-found.tsx`、`error.tsx`）
- `<html lang>` 动态设置、`metadata.title/description`

### 波次 2 — 公开目录站 `(site)/**`（22 个页面）
- 首页、搜索页、MCP 服务器/客户端详情、分类、排行榜
- 提交表单、what-is-mcp、privacy、terms 等静态页

### 波次 3 — 控制台 `app/[workspace]/**`
- 侧边栏导航、Dashboard 概览
- Agents、MCP 部署、工具包、Token 管理等各子页面
- Toast 消息、确认对话框、空状态文案

### 波次 4 — 认证 & API 错误边界
- 登录/注册页表单文案
- API 响应 `message` 字段（仅 HTTP 边界，不改内部日志）

### 不翻译
- MCP 服务器名称/描述（第三方数据库内容）
- 代码示例、JSON 片段
- 管理后台 `admin/**`

---

## 根布局改动

`src/app/layout.tsx` 变为异步，调用 `getLocale()` 获取当前 locale，传给 `NextIntlClientProvider`：

```tsx
// 概念示意
const locale = await getLocale();
const messages = (await import(`../../messages/${locale}.json`)).default;

return (
  <html lang={locale}>
    <body>
      <NextIntlClientProvider locale={locale} messages={messages}>
        {children}
      </NextIntlClientProvider>
    </body>
  </html>
);
```

---

## 测试策略

**单元测试（vitest）：**
- `setLocale` server action — cookie 写入正确、登录用户同步 DB
- locale 解析逻辑 — 三级优先级（cookie → Accept-Language → default）
- 翻译 key 完整性 — `zh.json` 所有 key 在 `en.json` 中均存在

**集成测试：**
- 登录流程 → `User.locale` 同步到 cookie
- 语言切换 → cookie 持久化

**手动验收标准：**
- 切换到中文，刷新页面保持中文
- 新标签页打开保持语言（cookie 跨 tab 生效）
- 登出再登录恢复语言偏好
- `Accept-Language: zh` 环境下默认渲染中文

---

## 估算

- 翻译 key 数量：~300–400
- 涉及文件：~60 个组件/页面
- DB migration：1 个（`User.locale` 列）
