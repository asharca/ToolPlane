# 用 MCP 客户端调用原生 A2A 服务

> [English](A2A_MCP_BRIDGE.md)

面向外部 Agent 和客户端集成者。适配入口直接使用原生 A2A 的 Handler、Task、权限与执行器，
不调用旧 Responses API，也不另外保存一套 MCP 任务。

## 接入

先按[控制台指南](A2A_CONSOLE.zh-CN.md)发布、启用对外 A2A，创建专用客户端。使用服务器端
MCP 客户端连接以下 Streamable HTTP 地址，并安全配置 `Authorization: Bearer <服务密钥>`：

```text
POST /api/v1/agent-endpoints/{endpointId}/a2a/mcp
```

具体客户端配置格式可能不同；控制台的连接对象仅作参考，不是通用配置文件。现有锁定的
官方 MCP SDK 负责 MCP 版本协商与工具传输，A2A 数据仍使用锁定的 1.0 结构。
MCP 地址不作为新的 A2A 协议绑定写进 Agent Card。

只接受具有显式 `a2a:send`、`a2a:read`、`a2a:cancel` 权限的 Endpoint 凭据，取消同时要求读取。
旧 Responses 权限和单独的 `*` 不自动升级。账户 Token、Cookie、运行凭据和带 Origin 的
浏览器请求都不能冒充外部服务客户端。本文不提供 OAuth 自动授权或浏览器 CORS 接入。

| MCP 工具 | 参数与结果 |
|---|---|
| `a2a_send_message` | 标准 A2A SendMessageRequest，立即返回 `{task}`；不是执行完成承诺 |
| `a2a_get_task` | 标准 GetTaskRequest，返回有权读取的 `{task}` 与交付物 |
| `a2a_list_tasks` | 标准 ListTasksRequest；适配器限制为每页最多 20 个摘要，不含历史和交付物 |
| `a2a_cancel_task` | 标准 CancelTaskRequest，返回取消后的当前 `{task}`；WORKING 表示尚未停止 |

工具目录按权限过滤，执行时重新验证。目标由 Endpoint 地址绑定，不接受任意 agentId、
workspace、模型、系统提示词或工具覆盖。操作失败返回 MCP `isError: true`，不能当成任务完成。

## 使用官方 MCP 客户端

以下代码使用项目已经锁定的 MCP SDK，无需新增其他 Agent 框架。令牌通过客户端秘密配置
或进程环境提供，不写进源码。它只演示提交和读取一次，不会无限轮询或自动重提任务。

```typescript
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.TOOLPLANE_A2A_MCP_URL;
const token = process.env.TOOLPLANE_A2A_TOKEN;
if (!url || !token) throw new Error('Configure the MCP URL and service credential.');
const client = new Client({ name: 'a2a-caller', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}));
try {
  const rawResult = await client.callTool({ name: 'a2a_send_message', arguments: {
    message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Review the supplied patch.' }] },
    configuration: { returnImmediately: true, historyLength: 0 },
  } });
  const result = CallToolResultSchema.parse(rawResult);
  if (result.isError) throw new Error('Task submission failed. Inspect the safe MCP error.');
  const text = result.content.find((part) => part.type === 'text');
  if (!text || typeof text.text !== 'string') throw new Error('Missing task response.');
  const { task } = JSON.parse(text.text);
  if (!task || typeof task.id !== 'string') throw new Error('Missing task ID.');
  // Store the task ID in your own application; disconnecting does not cancel it.
  const current = await client.callTool({ name: 'a2a_get_task', arguments: { id: task.id, historyLength: 0 } });
  if (current.isError) throw new Error('Task lookup failed.');
  // Parse current.content and inspect the standard task.status.state before claiming completion.
} finally {
  await client.close();
}
```

重试提交必须保留原 messageId 和业务内容；新任务使用新 ID。只有 INPUT_REQUIRED 才能用
相同 taskId、新 messageId 补充信息；终态任务不能重开。退出 MCP 连接不会取消已接受任务。

需要真正的任务事件流时，使用标准 A2A `SendStreamingMessage` / `SubscribeToTask`。
本适配仅暴露普通 MCP 工具，不声明 MCP Tasks 扩展或工具调用中的逐 Token 流。权限、取消、
保留期与[资源限额](A2A_RESOURCE_LIMITS.zh-CN.md)仍由同一核心执行。
