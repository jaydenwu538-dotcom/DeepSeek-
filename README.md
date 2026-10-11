# dsh-plugin-model-router

DeepSeek Harness (DSH / Cordis) 插件：根据用户输入智能路由本地 Ollama 模型，
代码任务走严格的串行双模型流程，全程强制卸载已用模型以保护 16GB 内存。

## 工作流

```
session/event (user 消息)
   │
   ├─ 命中代码关键词（写代码/Python/Minecraft机器人/函数/debug…）
   │     ├─ ① qwen2.5:7b          → 输出"详细实现指令"
   │     ├─ ② ensureUnloaded(qwen2.5:7b)  ← 轮询 /api/ps 确认已卸载
   │     ├─ ③ deepseek-coder:6.7b  → 写出最终 Python 代码
   │     └─ ④ ensureUnloaded(deepseek-coder:6.7b)
   │
   └─ 日常聊天 → qwen2.5:7b 直接回答
```

## 插件身份证（dsh.bundle）

`package.json` 里：

```jsonc
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`cordis.patch.yml` 自安装一行 `model-router` 服务层，装完即激活，无需手编 yml。

## 安装

1. 拉模型：
   ```
   ollama pull qwen2.5:7b
   ollama pull deepseek-coder:6.7b
   ```
2. 本地构建（本仓库已预构建 `lib/`）：
   ```
   npm install
   npm run build
   ```
3. 在 DSH「添加插件」对话框输入本目录的绝对路径：
   ```
   C:\Users\Jayden Wu\Doubao\chats\2026-10-11\new-chat\deepseek-harness-router
   ```
   安装源保持「npm 官方源」。或用 CLI：
   ```
   npx @deepseek-ai/dsh plugin --profile web add <本目录或 tgz 路径>
   ```

## 配置

在 `cordis.patch.yml` 的 `config:` 块里可覆盖：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `ollamaHost` | `http://localhost:11434` | Ollama 地址 |
| `chatModel` | `qwen2.5:7b` | 聊天 / 架构指令模型 |
| `coderModel` | `deepseek-coder:6.7b` | 代码生成模型 |
| `unloadTimeoutMs` | `15000` | 等待上一个模型卸载的最长毫秒数 |

## 需要你装到 DSH 后微调的两个点

参考 `@dsh-pet/pet` 的事件契约，它观察的是 `assistant/*` / `tool/*` 事件；
user 侧事件名我按对称命名列了候选（`user/message` / `session/user` / …）。
装到 DSH 后如果消息没被路由：

1. **`src/index.ts` 里的 `USER_EVENT_TYPES`**：在 DSH 启动日志或事件调试器里
   看一次真实的 user 事件 `type`，把它加进这个 Set。
2. **`injectAssistantReply(session, text)`**：按候选顺序尝试了
   `session.reply()` / `session.assistant.say()` / `session.emit('assistant/message')`。
   如果回复没出现在对话框，`console.log(session)` 看真实形状，改成对应调用即可。

这两处是 DSH 不同 rc 线之间唯一可能漂移的地方；路由和内存卸载逻辑不需要动。
