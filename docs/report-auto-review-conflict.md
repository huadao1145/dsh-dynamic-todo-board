# 自动审查与审批策略的冲突机理 / Why `auto` stalls the board

一句话：**「自动审查」不是本插件的功能，是 DSH 自带的 `auto` 权限预设；它挂在工具调用链最前面，先于本插件的审批门运行，所以本插件对 `done` 的免审豁免救不了你。**

Short version: the review gate is not ours — it is DSH's `auto` permission preset, and it runs *before* this plugin's approval gate. Our `done` exemption cannot reach past it.

---

## 1. 两道闸的先后顺序

工具调用进入执行前，会经过一条 `tools/pre-execute` 瀑布（waterfall）。本插件与自动审查都注册在这条链上，但**注册位置不同**：

| 顺序 | 谁 | 注册方式 | 源码 |
| --- | --- | --- | --- |
| ① 先跑 | DSH 自动审查 | `ctx.on("tools/pre-execute", …, { prepend: true })` | `@deepseek-ai/dsh-experimental-auto-review/lib/index.js:565`、`:598` |
| ② 后跑 | 本插件的审批门 | 普通 `ctx.on("tools/pre-execute", …)` | `lib/index.js`（`APPROVAL_FREE_ACTIONS` 在 `:4125`） |

`prepend: true` 决定了一切：无论本插件把自己的门放得多早，审查都在它之前。

```js
// dsh-experimental-auto-review/lib/index.js:565-598
yield ctx.on("tools/pre-execute", async (exec, next) => {
  const agent = exec.agent;
  if (agent === void 0 || exec.parent === void 0 && exec.name === RUN_CODE_NAME) return next();
  if (permissionPresets.current(agent.session) !== AUTO_PRESET) return next();   // :568 只在 auto 预设下生效
  …
  if (decision.decision === "deny" && ctx.approval.overrideOf(agent.session) === "never")
    return denied(exec, decision.reason);                                        // :589 never ⇒ 最终拒绝，不弹窗
  const downstream = await next();
  if (decision.decision === "allow" || downstream.kind !== "allow") return downstream;
  return askUser(exec, decision.reason);                                         // :593 ask ⇒ 交给人决定
}, { prepend: true });
```

三个关键判断：

- **`:568`** —— 审查只在预设恰好是 `auto` 时介入。其它预设直接 `next()`，一道题都不会多问。
- **`:589`** —— 审查判「拒绝」且审批策略是 `never` 时，**直接落定**，不弹窗、不再给机会。
- **`:593`** —— 审批策略是 `ask` 时，审查的拒绝会变成一个弹窗交给人。也就是说 `ask` 下审查只是「替你选择要不要问人」，不是「替人拒绝」。

`run_code` 的**外层**传输被显式跳过（`:567`），但它内部的每次子调用各自过一道审查——注释原文：*"Every native call and every started PTC inner call is reviewed once before its body; the outer `run_code` transport is deliberately excluded."*

## 2. 四个预设的真实组合

来自 `@deepseek-ai/dsh-permission-presets/lib/index.js`（`AUTO_PRESET_SPEC` 在 `:59-62`，默认预设表在 `:140-158`）：

| 预设 | sandbox | approval | 自动审查介入 | 写板子要确认吗 |
| --- | --- | --- | --- | --- |
| `read-only` | `read-only` | （不写入） | 否 | 写不了 |
| `workspace-write` | `workspace-write` | `ask` | **否** | `done` 不用；`add`/`update` 等每次问一次 |
| `danger-full-access` | `danger-full-access` | `never` | **否** | 全不用 |
| `auto` | **`danger-full-access`** | **`ask`** | **是**（每次工具调用） | 每次先过 LLM 审查，判险即停 |

```js
// dsh-permission-presets/lib/index.js:59-62
const AUTO_PRESET_SPEC = {
	sandbox: "danger-full-access",
	approval: "ask"
};
```

注意 `auto` 的 sandbox 是 **danger-full-access**：它给了模型全盘写权限，用「每次调用前过一遍 LLM 审查」来代替人审。这不是「更安全的 workspace-write」，而是「用审查换掉弹窗」的另一条路。

文档注释还写明了一条边界：*"a stored Auto identity also matches `never`, which a delegated child pins so its reviewer denials stay final."* —— 子代理会把 `auto` 钉成 `never`，此时审查拒绝就是终局。**这也是为什么 `auto` + `never` 是能同时出现的**（`permission-presets/lib/index.js:307`：`if (state.preset === "auto" && … && approval === "never") return AUTO_PRESET;`）。

**所以「既自动审查又完全放行」确实没有现成档位。** `auto` 的 approval 固定是 `ask`；要 `never`，就得让某处把策略改成 `never`，此时审查拒绝变成终局——正是本报告要解释的那个故障。

## 3. 症状长什么样

在 `auto` 预设下让模型写板子，可能看到：

1. 模型调用 `todo_board`，返回 `Auto review rejected tool "todo_board"; its body was not executed`，错误体里 `name: "AutoReviewDeniedError"`、`code: "AUTO_REVIEW_DENIED"`（`denied()` 在 `:522`）。
2. 审查本身失败（模型超时、返回不合规 JSON）时，是另一组标识：`AutoReviewFailedError` / `AUTO_REVIEW_FAILED`（`failed()` 在 `:545` 起）。**这两种要分开看**：失败不等于危险，只是没判出来。
3. 如果这轮是无人值守的续跑队列，会话就**停在这一步**——不是崩溃，是「那条链断了」。人回来只看到一句拒绝，看不出为什么要问。

`done` 之所以也中招：`APPROVAL_FREE_ACTIONS = ['list', 'done', 'reopen', 'note']`（`lib/index.js:4125`）只豁免**本插件自己的**审批门。审查在 `:565` 已经跑完了，`next()` 才轮到 `:4125`。顺序反了，豁免就是空的。

## 4. 为什么本插件不能自己绕过去

插件是可以再挂一个 `prepend: true` 抢到审查前面的——但那等于**替用户关掉安全审查**。审查存在的前提是「用户选了 `auto` 这个预设」，插件无权在一个用户显式选择的预设下把审查短路。所以这里选择**如实暴露冲突**，而不是偷偷加一条更靠前的门。

## 5. 三条出路

| 选择 | 做法 | 代价 |
| --- | --- | --- |
| **要无人值守、不怕给权限** | 预设改 `danger-full-access` | 模型拿到全盘写权限；没有审查 |
| **要无人值守、又不想给满权限** | 预设改 `workspace-write` | 板子不在工作区内，`add`/`update` 每次要确认；`done` 不受影响 |
| **要审查** | 保持 `auto`，人守着 | 每次写板子都可能被拦，需要人点 |

推荐：**日常用 `workspace-write`**。它让插件的审批门按设计工作（`done` 免审、写操作问一次），而审查完全不介入。只有在明确接受「全盘写权限」时才用 `danger-full-access`。

> README 里「`workspace-write` 是唯一『审查不介入、写板子又能用』的档位」这句话，准确的含义是**在不让模型拿到全盘写权限的前提下**。`danger-full-access` 同样没有审查、也能写板子，但它把整个文件系统都交出去了——那不是「能用」，那是「换了一个更大的代价」。

## 6. 复现与确认

```bash
# 1. 看当前预设与审批策略
#    GUI：设置 → 权限；或看会话日志里的 permission/policy 事件

# 2. 复现：预设设为 auto，让模型执行一次写操作
#    期望看到 AutoReviewDeniedError / AUTO_REVIEW_DENIED 或一次弹窗

# 3. 对照：预设改 workspace-write，重复同一动作
#    期望：done 直接成功；add/update 弹一次确认

# 4. 源码复核
grep -n 'prepend: true' <asar>/dsh-experimental-auto-review/lib/index.js
grep -n 'AUTO_PRESET_SPEC' <asar>/dsh-permission-presets/lib/index.js
```

## 7. 本报告覆盖不到的

- 审查模型的具体判据（`REVIEW_POLICY` 全文在 `dsh-experimental-auto-review/lib/index.js:93` 起）属于策略文档，会随版本演进；本报告只解释**链路顺序**，不评价判得准不准。
- `auto` 预设被移除或改名（它带 `experimental-` 前缀）时，第 1 节的引用行号会失效，但「审查 prepend 在插件门之前」这个结构性事实只要该机制存在就成立。
