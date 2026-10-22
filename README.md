# @local/dsh-subagent-codebuddy

**CodeBuddy subagent**：一次性 CodeBuddy 子代理 provider，走 Agent Client Protocol（`codebuddy --acp`，stdio NDJSON）。

实现参照 DSH 实验性插件 `@deepseek-ai/dsh-subagent-claude-code`（Claude Code 子代理）：同样的 out-of-process 能力声明（`NO_START_CAPABILITIES`、`inheritsParentContext: false`）、同样的 `settleRunResult`/`subprocessRunHandle` 结果发布、同样的 managed-range 进程终止阶梯。差异在线上协议：Claude Code 用官方 Agent SDK，本插件直接手写 ACP NDJSON 客户端（无外部 SDK 依赖）。

## 使用

在 Plugins 页启用 **CodeBuddy subagent** 后，每个 Agent 会获得全局工具 `subagent_codebuddy`：委派一个自包含文本任务，返回 CodeBuddy 的最终回答（或安全失败诊断）。推理、工具流量、stderr、工作区 diff 不进入父会话。

```yaml
- insert:
    - id: subagent-codebuddy
      name: '@local/dsh-subagent-codebuddy'
    - id: tool-subagent-codebuddy
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: codebuddy
        toolName: subagent_codebuddy
        maxDepth: provider-managed
```

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `providerName` | `codebuddy` | `ctx.subagents` 上的注册名；每个挂载实例需唯一 |
| `model` | 省略 | 可选模型 id，经 `session/set_model` 固定每次运行 |
| `command` | `codebuddy` | `codebuddy` 可执行文件路径或命令名 |
| `env` | `{}` | 显式环境变量，叠加在脱敏后的父环境之上 |
| `permissionMode` | `dontAsk` | 无人值守权限策略（见下） |
| `disposeGraceMs` | `3000` | 进程终止阶梯的宽限毫秒 |
| `startupTimeoutMs` | `20000` | `initialize` + `session/new` 的启动超时 |

`permissionMode` 映射：

| 值 | 行为 |
|---|---|
| `dontAsk` | 所有工具权限请求（`interruption_request` / `session/request_permission`）应答 `deny` |
| `acceptEdits` | 编辑类工具应答 `allow`，其余 `deny` |
| `bypassPermissions` | 全部 `allow`（危险，需显式配置） |

## 运行流

1. 校验 child cwd（`assertUsableCwd`），spawn `codebuddy --acp`（经 `ctx.subprocess.spawn`，环境 = `scrubbedParentEnv()` + 配置 `env`）；
2. `initialize` → `session/new`（可选 `session/set_model`）；
3. `session/prompt`（请求-响应），期间消费 `session/update` 通知：`agent_message_chunk` 累积最终文本、`interruption_request` 按策略应答；
4. 仅 `stopReason: 'end_turn'` 且输出非空 → `{output:[text], stopReason:'completed'}`；`cancelled`/`refusal`/超时/进程退出 → 固定类别的 `error` 诊断；
5. 取消：本地 AbortController → `session/cancel` 通知 + `terminate()` + `waitForExit()`。

## 已知限制

- 一次性执行：不接受追问、resume、pooling；无进度流。
- 每次运行一个独立 ACP 进程与会话；`~/.codebuddy` 会落一份 CodeBuddy 自己的会话记录。
- 登录态是原生的：未登录时 `session/new` 失败（`AUTH`），插件无法代做 OAuth，需先运行 `codebuddy` 登录。
- `--tools` 白名单未配置：CodeBuddy 使用自己的工具（同 Claude Code 子代理语义），在工作区直接操作文件，不受 DSH 文件沙箱约束；权限策略默认 deny 限制其需要审批的操作。
- stdio 上的非 JSON 脏行会被跳过并计数，不中断协议流。
