# DSH 0.2.1-rc.2 兼容性核对报告 / Compatibility report

这份文档记录「这个插件到底依赖 DSH 的哪些东西」，以及每一条依赖是**怎么核实的**。给两种人看：想升级 DSH 的人（先看这里判断会不会炸），和想改这个插件的人（这 12 个服务、6 个事件、1 个 slot 就是全部契约面）。

This document lists every DSH surface this plugin depends on, and how each one was verified. It exists so that a DSH upgrade can be judged before it lands, and so that anyone editing the plugin knows the whole contract surface: 12 host services, 6 host events, 1 slot, 2 client services.

---

## 核对方式 / How this was verified

**没有一条是照抄文档或凭印象写的。** 三类证据：

1. **活体自省**：对正在运行的宿主调用 `cordis_inspect_query`（只读），拿它自己吐出来的服务目录、事件目录、Slot 拓扑。这是运行时的事实，不是源码里的意图。
2. **字节级读源码**：`D:\dsh\resources\app.asar` 解包后逐文件读，用来确认常量值（如 `SESSION_FORMAT_VERSION`）和快照结构的字段名。
3. **端到端点测**：真装、真开面板、真触达每条路径。

三条互不替代：自省告诉你「现在有没有」，源码告诉你「为什么会这样」，端测告诉你「用户能不能用」。

**Nothing here is copied from documentation or recalled from memory.** Three independent evidence classes: live `cordis_inspect_query` (read-only) against the running Host for the service/event/Slot catalogs; byte-level reading of the unpacked `app.asar` for constants and snapshot field names; and end-to-end testing with the plugin actually installed.

## 环境 / Environment

| 项 | 值 |
| --- | --- |
| 报告原始核对版本 | DSH 桌面版 **0.2.1-rc.2** |
| 复核版本（2026-11-08） | DSH 桌面版 **0.2.2-rc.1**（`runtime.json` 的 `desktopVersion`），本报告全部条目在该版本上逐条复测通过 |
| 运行时 Node | **24.21.0**（`runtime/versions.json`）；插件 `engines.node` 要求 `>=22.19.0` |
| 平台 | win32 / x64 |
| 会话格式 | `SESSION_FORMAT_VERSION = 4`（`@deepseek-ai/dsh-session/lib/index.js`） |

两个版本结论一致，所以下表对 0.2.1-rc.2 与 0.2.2-rc.1 同时成立。

---

## 1. 会话格式：v4 / Session format

```js
// @deepseek-ai/dsh-session/lib/index.js
const SESSION_FORMAT_VERSION = 4;
```

插件往会话里写提示时，每条消息都带一个**生产者自有的 source**：`{ kind: 'plugin:dsh-todo-board', form: 'notice' }`。

这不是风格选择，是 v4 的硬性要求：**没有合法 source 的消息会被持久化层拒绝，而拒绝会带走整个回合**——不只是那条提示。0.4.1 / 0.5.0 / 0.6.1 三个发布版缺这个适配，症状是「提示偶尔把整轮对话吞掉」。

Each plugin-authored message carries a producer-owned `source`. This is a v4 requirement, not a style choice: a message without one is rejected by the persistence layer, and the rejection takes the whole turn with it.

---

## 2. Host 服务：12 个 / Host services

全部经 `ctx.get(name)` 取得（`webServer` 经 `ctx.inject(['webServer'])` 后取 `hostCtx.webServer`）。每个都在活体目录里命中。

| 服务 | 插件用它做什么 | 关键方法 |
| --- | --- | --- |
| `tools` | 注册 `todo_board` 工具 | `register` |
| `systemPrompt` | 注册提示段（告诉模型板子的存在） | `section` |
| `webServer` | 注册面板的 HTTP 路由 `/dsh-todo-board/api` 与图片路由 | `register` |
| `skills` | 注册随插件分发的一个 skill | `register` |
| `commands` | 注册斜杠命令 | `register` |
| `llm` | `autoJudge` 可选功能：用当前会话模型判定「算不算回答了」 | `stream` |
| `agentDefaultModel` | 取会话当前选择的模型 | `currentSelection` |
| `agents` | 找会话对应的 agent、判断存活 | `get` / `list` |
| `agentPresets` | 读会话所属 preset 的展示名 | `presetForSession` |
| `sessionQuery` | 查会话标题与摘要（用于待办卡片的会话归属显示） | 见服务契约 |
| `workspaceRegistry` | 目录→工作区归类（「全部」tab 按工作区分组） | `list` / `resolveByPath` |
| `attachments` | 提示里引用图片时的落盘（少量路径） | `saveImages` / `imageHostPath` |

**为什么这 12 个而不是更多**：插件刻意不做「全量注入」。`ctx.inject([...])` 里少一个服务就会让整个插件的启动串断掉，所以除 `webServer` 之外的服务一律**惰性取**（点开面板、或走到那条功能时才 `ctx.get`），任一服务缺失只让对应功能降级，不让面板变白板。

**Why these and no more:** the plugin deliberately does not inject everything. `ctx.inject([...])` fails the whole plugin if one named service is missing, so apart from `webServer` every service is resolved lazily — a missing service degrades one feature instead of blanking the panel.

## 3. Host 事件：6 个 / Host events

| 事件 | 模式 | 插件用它做什么 |
| --- | --- | --- |
| `session/event` | emit | **核心**。自动捕获的全部判定都从这里来：`turn/start`、`user/message`、`assistant/message`、`turn/end` 四种事件喂进每个会话的状态机 |
| `agent/status` | emit | `idle` 时给待判定项重新计时（30 分钟宽限） |
| `agent/disposed` | emit | 会话销毁时立刻冲刷未决项，不等计时器 |
| `agent/turn-stopping` | serial | 轮次收尾时机，用于收束状态 |
| `agent/pre-step` | waterfall | 无侵入透传（`return next()`），保留给未来的提示注入 |
| `tools/pre-execute` | waterfall | 工具审批门：`approval` 为 `never` 时直接 deny，不发弹窗 |

`session/event` 的确切形状（来自活体事件契约，不是推断）：

```ts
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
```

插件实际消费的四种 `event.type` 与字段：

| `event.type` | `event.data` 里插件读的字段 |
| --- | --- |
| `turn/start` | `turn` |
| `user/message` | `role`（须为 `'user'`）、`source.kind`（须为 `'user'`，注入的通知不算人说话）、`content` |
| `assistant/message` | `turn`、`message.content` 里 `type === 'text'` 的块 |
| `turn/end` | `turn`、`reason.kind` |

`TurnEndReason` 的取值域：`completed` / `aborted` / `blocked` / `error` / `max-tokens` / `interrupted` / `forked`。插件**只认 `completed`**——失败、中断、超限的轮次没有「AI 在等你定」可言，不产生待办。这条规则在 429 限流那次实测中被反向验证过：连续几轮 `reason.kind === 'error'` 时，板子确实一条没加。

The plugin consumes only four event types and treats only `reason.kind === 'completed'` as a turn that can leave a question hanging. That rule was confirmed in the field: during a 429 rate-limit burst, several turns ended with `kind: 'error'` and the board gained nothing.

## 4. 客户端 Slot：`shell.overlay`

活体拓扑：`shell.overlay` 是 **list** slot、**root** scope、`replaceRisk: none`，用途是「Frame-wide floating layer, above every column and outside their scroll containers」。插件以自己的 id 占一格：

```
registrant: dsh-todo-board, id: todo-board, order: 40, active: true
```

注册参数 `{ id, order?, label? }`。**`id` 必须是自有 id**：复用内置 id 会顶替那个格子，只有新 id 才是「在旁边加一格」。

`standardProps` 里与本插件相关的是 `useSessions` 与 `useWorkspaceAccess`——面板用它读会话列表和工作区归属。

## 5. 客户端服务：2 个

| 服务 | 用途 | 关键方法 |
| --- | --- | --- |
| `sessions` | 卡片上的 `↩` 跳回：`sessions.using(sessionId, { source: 'controllerOperation' }, ref => ref.ready.session.loadThrough(seq))` | `using` |
| `uiWorkspace` | 跳回时先 `openSession(target)` 把那个会话切到前台 | `openSession` |

两者都在 `exports.inject = ['slots']` **之外**、在点击时用 `ctx.get` 惰性取。把它们写进 `inject` 会让任一服务缺失时整个面板加载失败——为了一个按钮赔掉整个面板不值得。

## 6. `useSessions` 快照形状

插件依赖的字段（`@deepseek-ai/dsh-api-session-controller` 的 `SessionManager.buildListSnapshot()` 实际返回）：

```
{ ids, byId, phase, error, projectionsBySession }
```

**没有 `current` 键。** 早期版本读 `s.current` 永远拿到 `undefined`，于是「当前会话」判定恒为假——这是本项目踩过的一个真实 bug，写在这里防止回退。

## 7. 升级时先看这三条 / What to check before upgrading

1. **`SESSION_FORMAT_VERSION` 是否还是 4。** 变了就是破坏性升级，`source` 的形状要先跟。
2. **`session/event` 的四种 `type` 与 `TurnEndReason` 是否还在。** 少了 `turn/end` 整个自动捕获静默失效——不报错，只是永远不记录。
3. **`shell.overlay` 的 `kind` / `scope` 是否还是 `list` / `root`。** 变了面板会消失，但插件本身还在跑（路由仍可访问），属于「看着像没装」。

前两条的失效模式都是**静默的**：不抛异常、不写错误日志，只是功能不再发生。所以升级后不要只看「有没有报错」，要按下面复测。

Both failure modes above are silent: no exception, no error log, the feature simply stops happening. Verify by behavior, not by the absence of exceptions.

---

## 8. 复测清单 / Re-verification

```bash
# 1. 服务与事件目录（只读，不改运行时）
#    宿主侧：Service.listService / Event.listEvents / Config.listConfigs
#    客户端侧：Slots.listSubTree({ root: 'shell.overlay' })

# 2. 会话格式常量
grep -r "SESSION_FORMAT_VERSION = " <app.asar 解包目录>/@deepseek-ai/dsh-session/lib/index.js

# 3. 插件自检（18 项特征标记）
node check-installed.mjs

# 4. 全量回归
node test-semantics.mjs   # 240 项中文语义
node test-edge.mjs        # 38 项边界
node test-plugin.mjs      # 94 项端到端
node test-client.mjs      # 31 项客户端渲染
```

四条全绿 + 面板能开 + 卡片能跳回，才算这个版本在目标 DSH 上可用。

All four green, the panel opens, and a card's jump button returns to the origin turn — that is the bar for "works on this DSH version".

---

## 附：本报告覆盖不到的

- **面板的视觉表现**依赖 `@deepseek-ai/dsh-client-ui-*` 的 CSS 变量与 token 名，属于「能用但可能不好看」的一类，不在本报告范围内。
- **模型行为**（`autoJudge` 的判定质量）取决于所用模型，与 DSH 版本无关。
- **多实例并发**：本报告只覆盖单宿主进程。多个 DSH 实例共享同一 `board.json` 时的并发写没有做跨进程锁，属于已知限制。
