# pi-session-titler 设计文档

> 状态：已实现（v0.1.0）· 2026-09-19 修订：吸收设计审核意见（会话状态键控化、模型默认值简化、失败分类细化、CJK 显示宽度）
> 参考：codex `codex-rs/tui/src/app/thread_title.rs` 的自动命名实现（分析见本文末尾附录）

## 1. 目标

- 新会话发出第一条用户消息后，自动生成简短的会话显示名（`pi.setSessionName()`）
- 生成的名字出现在 `/resume`、`pi -r` 选择器和 footer 中，替代默认的"首条消息截断"
- **手动命名永远优先**，自动生成绝不覆盖任何已存在的名字
- 生成过程零感知：不阻塞主任务、不污染会话上下文、失败静默

## 2. 已确认的 pi 扩展 API 能力

| 能力 | API | 说明 |
|---|---|---|
| 触发事件 | `pi.on("before_agent_start")` | `event.prompt` 即用户提交的完整 prompt，先于 agent 循环 |
| 会话切换感知 | `pi.on("session_start")` | `event.reason`：`startup/new/resume/fork/reload`，**仅用于内存回收**（见 3.2） |
| 手动命名感知 | ~~`pi.on("session_info_changed")`~~ | **最终未采用**：自己的 `setSessionName()` 同样触发该事件，无法区分来源；手动优先由写入前复查保证 |
| **旁路 LLM 调用** | `ctx.modelRegistry.complete(model, context, options?)` | 一次性补全，返回 `Promise<AssistantMessage>`；auth 由 registry 解析；**完全在 agent 循环之外，不写入会话历史** —— 等价于 codex 的隐藏临时线程 |
| 读/写名字 | `pi.getSessionName()` / `pi.setSessionName(name)` | |
| 文本提取 | `contentText(message.content)` | pi-ai 导出的工具函数 |
| 模型信息 | `ctx.model` / `ctx.modelRegistry` | 当前模型（即默认标题模型）+ complete 入口 |
| 用户开关 | `pi.registerFlag()` | 命令行 flag 覆盖默认配置 |

### 2.1 假设验证状态（实现第一天冒烟确认）

| # | 假设 | 状态 | 若不成立的后果 |
|---|---|---|---|
| A1 | `getSessionName()` 对未命名会话返回**空**（"首条消息截断"是展示期回退，不持久化进 session 记录） | **已证实**（session-manager.js:860-871：反向找最近 `session_info` 条目，无则 `undefined`；`appendSessionInfo` 全库仅 `setSessionName()` 一个调用点，无任何自动写入） | 地基假设成立 |
| A2 | `event.prompt` 是原始用户输入（slash command 展开前/后的语义待确认） | **已证实**（agent-session.js:915）：传入的是 `expandedText`——slash 命令/prompt template **展开后**的文本，与写入会话的用户消息同一变量；首条消息若为 `/cmd`，标题素材是模板展开内容，无阻断，960B 截断兑底 | 已关闭 |
| A3 | `modelRegistry.complete()` 不写入会话历史/上下文 | 已验证（源码） | 需更换隔离方案 |
| A4 | forced toolChoice + constrainedSampling 可透传（9 个 adapter 均有某种支持） | 已验证（源码） | A 路整体降级为纯 B 路 |
| A5 | `before_agent_start` handler 若返回未决 Promise 会被 pi await | 已确认 | —— 故 handler 必须同步返回，LLM 调用 fire-and-forget + 顶层 `.catch` |

Day-1 冒烟方式：临时挂 debug 日志，观察新会话启动时与 resume 未命名会话时 `getSessionName()` 的返回值；或直接用 `fauxProvider` 走通触发流程。

## 3. 行为设计

### 3.1 触发流程

```
用户提交 prompt
  └─ before_agent_start（handler 同步返回；LLM 调用 fire-and-forget + 顶层 .catch，超时 AbortSignal.timeout(30s)）
       ├─ sid = ctx.sessionManager.getSessionId()      ← 闭包捕获，永不重置（会话身份的唯一载体）
       ├─ st = state.ensure(sid)                        ← Map<sessionId, SessionState> 的 entry 引用，同样闭包捕获
       ├─ 守卫：getSessionName() 非空？          是 → 跳过
       ├─ 守卫：st.pending？                     是 → 跳过
       ├─ 守卫：st.invalidAttempts ≥ 2？         是 → 跳过
       ├─ token = ++st.genToken；st.pending = true
       └─ generateTitle(ctx, prompt, sid, st, token)
            ├─ 路由：st.noStructured ? 直走 B : 先 A
            ├─ A：complete(submit_title 工具 + forced toolChoice + constrainedSampling)
            │    ├─ 成功 → toolCalls[0].arguments.title → normalizeTitle
            │    ├─ 结构化类失败（无 toolCall / schema 不符 / 拒绝 toolChoice）→ 走 B
            │    │    B：纯文本 complete → contentText → normalizeTitle
            │    └─ 传输类失败（网络 / 超时 / 5xx / 429）→ 不走 B（同模型同通道必败），按下方分类静默
            ├─ 失败分类（按 error.status，无法识别的按瞬时处理）：
            │    · 归一化后为空 / HTTP 4xx（非 429）   → 确定性：st.invalidAttempts++（4xx 多为 --title-model 配错）
            │    · 无 toolCall / 拒绝 toolChoice        → 确定性 + 置 st.noStructured = true，同会话后续直走 B
            │    · 网络 / 超时 / 5xx / 429 / 未识别错误 → 瞬时：不计数，下一条消息自然重试
            ├─ 成功 → 写入前三重校验，任一不过即丢弃：
            │    ① getSessionId() === sid     （闭包身份：会话已切走则丢弃）
            │    ② st.genToken === token      （本 entry 的 pending 仍属于本次请求）
            │    ③ getSessionName() 为空      （手动命名优先）
            │    全过 → setSessionName(title)
            └─ finally：if (st.genToken === token) st.pending = false    ← 只清自己的 pending
```

要点（与 codex 一致）：

1. **第一条消息即触发**，不等任务完成——标题在主任务执行期间并行生成
2. `before_agent_start` 的 handler **同步返回**，绝不 await LLM 调用（该事件会阻塞 agent 启动）；fire-and-forget 的 Promise 必须有顶层 `.catch`，避免未处理拒绝
3. 失败分类 + 短路：**确定性失败**（归一化为空 / 拒绝 toolChoice / HTTP 4xx 非 429）计入 2 次上限，其中 A 结构化失败额外置 `noStructured`，同会话后续直走 B 不再重试结构化；**瞬时失败**（网络/超时/5xx/429）不计数，下一条消息自然重试（fail-fast，浪费可忽略）
4. resume 旧会话：已有名字 → 不触发；无名字的旧会话 → 下一条消息触发（依赖假设 A1，见 2.1；与 codex 行为相同）

### 3.2 状态与竞态防护

```
手动命名（/name、--name、resume picker 改名） > 自动生成 > pi 内置的首条消息回退
```

状态设计（修订核心——**正确性绝不依赖可重置的共享标量**）：

```typescript
type SessionState = { pending: boolean; genToken: number; invalidAttempts: number; noStructured: boolean };
const state = new Map<string, SessionState>();   // key: sessionId
```

- **身份闭包化（P0）**：sessionId 与 entry 引用在触发时捕获进闭包，永不重置、完成时绝不通过模块变量重查。此前的方案把 `capturedSessionId` 放在 `session_start` 可重置的模块状态里，"切走 → 新会话触发覆盖 → 旧请求完成时比对到新值"会把 A 的标题写进 B——身份必须是不可变的每请求局部值
- **状态键控化**：pending / 计数 / noStructured 全部按 sessionId 隔离在各自 entry 内；A 会话请求的 `finally` 物理上不可能清掉 B 会话的 pending（不同 entry 对象）
- **token 防陈旧**：同 entry 内用单调递增 token 标识"当前持有 pending 的请求"；只有 token 匹配者能写名字、能清 pending
- **session_start 仅做内存回收**：`state.clear()`。正确性不依赖它——在途请求通过闭包持有 entry 引用与 sid，清 Map 不影响其校验能力（推论：生成期间切走又切回原会话，结果仍会正确写入，见 §5）
- **写入前复查**：`complete()` 返回后、`setSessionName()` 前再次 `getSessionName()`，非空则丢弃（手动命名优先）
- **pending 去重 + 30s 超时**防挂死

已知可接受残留（均在写入端复查兜底之内）：

- (a) 复查③与 `setSessionName()` 落地之间有毫秒级 TOCTOU 窗口，与 codex 同级，接受
- (b) 极窄窗口内（resume 回同一会话后立刻发新消息）可能出现一次重复生成；两次请求都过三重校验时，先写者胜、后到者被③丢弃——最多浪费一次调用，不可能写错
- (c) `noStructured` 在 `state.clear()` 后丢失（切走又切回原会话）：会再试一次 A 才重新置位，浪费一次结构化调用后即恢复，接受

注：`genToken` 在当前流程下恒为 1（同 entry 内 `pending=false` 才允许新触发，不存在"新请求顶替在途旧请求"的路径），属防御性冗余，为未来重试/并发路径预留。`invalidAttempts` 按"一次 `generateTitle` 尝试"计，A→B 级联双失败最多计 1。

注：不设 `manualNamed` 标记——自己的 `setSessionName()` 同样触发 `session_info_changed`，无法区分来源，且写入前复查已覆盖该场景。

### 3.3 结构化输出：分层方案（A 主 B 兜底）

**研究结论**（已验证 pi-ai 源码）：`ctx.modelRegistry.complete()` 支持工具调用并透传 provider 级选项，`Tool` 上有 `constrainedSampling: {type:"json_schema", strict:"prefer"}`，映射到各 provider 原生结构化输出（OpenAI strict schema / Anthropic tool use / Google responseSchema 等，覆盖全部 9 个 adapter）。所有 adapter 均支持某种 forced toolChoice。

```
方案 A（主）：submit_title 工具 + constrainedSampling(prefer) + forced toolChoice
           → AssistantMessage.toolCalls[0].arguments.title（provider 原生保证的结构化结果）
方案 B（兜底）：仅当 A 死于结构化类失败（无 toolCall / schema 不符 / provider 拒绝 toolChoice）时，
           退回纯文本生成 + normalizeTitle。
           传输类失败（网络/超时/5xx/429）不触发 B——同模型同通道，B 必败，只会双倍浪费调用
normalizeTitle：两路共用的最后防线（长度/引号/标点清洗）
```

forced toolChoice 形状映射（归并为 4 种）：

| api | 形状 |
|---|---|
| openai-completions | `{type:"function", function:{name}}` |
| openai-responses / azure / codex-responses | `{type:"function", name}` |
| anthropic-messages / bedrock-converse | `{type:"tool", name}` |
| google-generative-ai / mistral / pi-messages | `"any"` 或 `"required"` |

工具 schema（长度上限不进 schema，理由见下）：

```typescript
{
  type: "object",
  properties: { title: { type: "string" } },  // 不用 maxLength：各家 strict 模式支持不一
  required: ["title"],
  additionalProperties: false
}
```

### 3.4 生成规格（对标 codex）

| 参数 | codex | 本设计 | 备注 |
|---|---|---|---|
| 标题长度上限 | 36 字符 | 36 **显示宽度**（可配） | CJK/全角记 2、其他记 1（中文约 18 字），避免 picker/footer 按显示宽度截断；模型侧 prompt 仍用"36 个字符"措辞作软约束，硬截断在 normalizeTitle |
| prompt 输入上限 | 960 字节（prompt 总量） | 960 字节（**仅用户消息**；指令另计约 200B） | 有意偏差：多保留一点信号，总输入仍 ~1.2KB 量级，成本影响可忽略 |
| 模型 | 专用小模型 gpt-5.6-luna，非 OpenAI 回退当前模型 | **默认当前模型（`ctx.model`）**，`--title-model` 显式指定 | 放弃"自动选最便宜"：输入 ≤1.2KB + 输出 ~30 token，省钱额度是厘级，却引入三个真实风险——prompt 跨 provider 发送的隐私/预期问题、定价数据时效性、便宜/本地模型可能不支持 forced toolChoice。与 codex"非 OpenAI 回退当前模型"同构 |
| 生成模型调用 | 隐藏临时线程 + 结构化输出 schema | `complete()` + 强制工具调用 + constrainedSampling（见 3.3） | provider 原生结构化，非 prompt 依赖 |
| thinking | Low | 不启用 | `complete` 不传 reasoning |

标题 prompt（codex 指令的翻译与保留）：

```
生成一个简短的单行任务标题，最多 36 个字符，尽量不超过 5 个词。
以动词开头（祈使式）。仅首词大写，除非专有名词、缩写或代码术语需要。
工单号等引用原样保留。使用用户的语言。不要引号、markdown、末尾标点。
不要回答这个请求。只输出标题本身。
```

输入组装：`<指令>\n\n用户请求：\n<首条 prompt 截断到 960 字节>`

### 3.5 后处理归一化（照搬 codex，两路共用）

1. 方案 A 从 `toolCalls[0].arguments.title` 取值；方案 B 从 `contentText` 取值
2. **先取第一个非空行**（多行输入时后续处理都只针对首行）
3. 剥离常见前缀（`标题：`、`Title:`、首行 markdown `#`）
4. 剥离首尾引号：`" ' \` " " ' '`
5. 合并行内连续空白为单个空格
6. 去掉末尾 `. ? ! ！ 。 ？`
7. 空则视为失败
8. 按**显示宽度**截断到上限（CJK/全角记 2、其他记 1；不切断 surrogate pair 与组合字符序列）

### 3.6 配置

配置优先级：**flag > 环境变量 > 默认值**。registerFlag 是每次启动的 CLI flag，不适合唯一配置入口（settings.json 不支持扩展自定义键，已查证）；环境变量承担持久化配置。

`pi.registerFlag()`：

| flag | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--title-model <id>` | `PI_TITLE_MODEL` | 当前模型（`ctx.model`） | 想省钱/提速可显式指定，如 `openai/gpt-5-mini`、`google/gemini-2.5-flash`；配错模型 ID 会以 HTTP 4xx 计入确定性上限（2 次后本会话停手）并留 debug 日志 |
| `--title-max-chars <n>` | `PI_TITLE_MAX_CHARS` | 36 | 标题长度上限，**显示宽度**计（CJK 记 2） |
| `--title-off` | `PI_TITLE_OFF=1` | - | 完全关闭自动命名（临时关闭也可用 `pi config` 禁用扩展） |

## 4. 文件结构

```
pi-session-titler/
├─ package.json          # name: "pi-session-titler" + "pi-package" keyword + pi manifest；peerDeps: @earendil-works/*
├─ LICENSE               # MIT
├─ .github/workflows/ci.yml   # vitest run + tsc --noEmit
├─ src/
│  ├─ auto-session-name.ts   # 扩展入口（事件接线 + 核心异步流程）
│  ├─ title.ts               # 纯函数：buildTitlePrompt / normalizeTitle / displayWidth / truncateByWidth / toolChoiceFor
│  └─ constants.ts           # TITLE_MAX_CHARS / PROMPT_MAX_BYTES / MAX_INVALID_ATTEMPTS / TITLE_INSTRUCTIONS
├─ tests/
│  └─ title.test.ts
├─ extensions/
│  └─ auto-session-name.ts   # re-export src 入口（pi 包约定的资源目录）
└─ README.md
```

实现要点：

```typescript
// 1. 纯函数层 100% 可单测，不 import pi 运行时
// 2. 状态：Map<sessionId, {pending, genToken, invalidAttempts, noStructured}>
//    请求身份（sid / entry 引用 / token）一律闭包捕获，绝不通过可重置的模块变量做校验
// 3. 事件接线：before_agent_start（同步 handler + fire-and-forget 顶层 .catch）
//             / session_start（仅 state.clear()，正确性不依赖）
// 4. 核心异步：generateTitle(ctx, prompt, sid, st, token) —— A→B → 归一化 → 三重校验 → setSessionName
```

## 5. 边界情况清单

| 场景 | 行为 |
|---|---|
| 生成期间用户 `/new`、`/resume` 切走会话 | 校验①丢弃结果；若之后**切回原会话**且仍未命名，结果照常写入（标题本就属于该会话，正确行为而非泄漏） |
| 生成挂死（网络黑洞） | 30s 超时中止，finally 只清自己的 pending，不影响其他会话的后续尝试 |
| 用户在生成完成前手动 `/name` | 校验③拦截，手动名保留 |
| 生成期间用户又发消息 | pending 守卫跳过，不重复生成 |
| 模型输出多行/带 markdown | 归一化清洗；清洗后为空视为确定性失败 |
| `--name` 启动的会话 | `getSessionName()` 非空，永不触发 |
| `/new`、`/resume`、`/fork` | `session_start` 清空 Map（仅内存回收，正确性不依赖） |
| ephemeral 模式（`--no-session`） | 照常工作（内存态），无持久化意义但无害 |
| 无网络 / HTTP 5xx / 429 / 超时 | 瞬时类不计上限，下一条消息自然重试 |
| `--title-model` 配错（HTTP 4xx 非 429） | 计入确定性上限，2 次后本会话停手；debug 日志提示检查模型 ID |
| 中文会话 | prompt 明确"使用用户的语言"；长度按显示宽度计（CJK 记 2） |
| `--title-model` 未设置 | 始终用当前会话模型，**绝不跨 provider 发送 prompt** |

## 6. 开源工程化

- 仓库：`~/opensource/pi-session-titler`（npm 撞名已解决：pi-auto-session-name / pi-session-title / pi-autoname / pi-title 均被占用，选定 **pi-session-titler**）；MIT LICENSE；.gitignore
- CI（GitHub Actions）：`vitest run` + `tsc --noEmit`
- README：安装（`pi install`）、配置（flag/环境变量表）、卸载、隐私说明（默认使用当前会话的模型与 provider，仅 `--title-model` 显式指定时才会调用其他模型）、安全提示（扩展全权限运行的官方警告）
- npm 包名：**pi-session-titler**（无 scope，已确认可注册）

## 7. 测试计划

- 单测（vitest）：
  - `normalizeTitle` 全部分支（引号/弯引号/前缀剥离/多行取首行/末尾标点/**显示宽度截断**：中文、emoji surrogate pair）
  - `buildTitlePrompt` 字节截断边界（含中文多字节）
  - forced toolChoice 形状映射表
  - 失败分类：4xx 计入 / 5xx·429·超时不计入 / `noStructured` 置位后同会话直走 B
- **竞态单测**（fake timers + mock `sessionManager`，不只在手测覆盖）：
  - 生成中切走 → 结果丢弃
  - 切走又切回原会话 → 结果仍正确写入
  - A 会话在途时 B 会话触发 → 互不污染（含 A 的 `finally` 不清 B 的 pending）
- 集成测试（可选）：pi-ai 导出 `fauxProvider`/`fauxText`，可注入 registry 做无 API key 的端到端验证（兼作 2.1 假设的冒烟）
- 手测场景：新会话首条消息 → footer 与 `/resume` 出现标题；生成前手动 `/name`；生成中 `/new` 切走验证不串名；`--title-model` 覆盖；`--title-model` 配错验证静默止损；断网静默；resume 未命名旧会话

## 附录：codex 实现要点备忘

- 触发：UserMessage 完成事件 + `thread_name().is_none()`，pending map 去重
- 隔离：`ThreadSource::Feature("thread_title")` 隐藏临时线程，不碰主上下文
- 模型：专用小模型 `gpt-5.6-luna` + reasoning Low，非 OpenAI 回退当前模型
- 约束：JSON Schema `{title: 1~36}`、prompt 总量 960B、重命名建议场景取最近 8 条消息
- 竞态：手动改名取消 pending（CancellationToken）+ 写入前重读线程确认无名
- 兜底（导入外部会话）：首条用户消息剥控制标签取首行截 120 字符，不调 LLM
