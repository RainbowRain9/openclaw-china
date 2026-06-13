# QQ Bot 升级设计文档：@openclaw-china/qqbot 对齐上游 v1.7.2

| 字段 | 值 |
|---|---|
| 当前版本 | `@openclaw-china/qqbot` `2026.3.9-1`（plugin.json `0.1.0`，血缘 ≈ 上游 v1.5.7 时代 + fork 自研 China 特性） |
| 目标参考 | `@tencent-connect/openclaw-qqbot` `v1.7.2`（release tag `v1.7.1`，2026-04 发布） |
| 文档日期 | 2026-06-13 |
| 状态 | 草案（Draft）— 待实现评审 |
| 升级策略 | **能力移植（Capability Port）**，非文件 rebase（见 §2） |
| 关键路径 | **Config 存储键 `channels["qqbot-china"]` 保留 + 读侧兼容层**（见 §7、C1） |

> 本文档基于对 fork（`/home/rainbow/Code/openclaw-china/extensions/qqbot`）与上游（`tencent-connect/openclaw-qqbot` v1.7.2）源码的逐文件比对。12 个子系统由专项 agent 深化并**逐条对照真实代码核验**（cite file:line），5 条最高风险声明经独立对抗性验证（见 §7.1）。`proactive-refindex-queue` 子系统（§4.10）由独立核验补全。

---

## 0. 文档目的与范围

### 0.1 目的

将 China 本地化 fork `@openclaw-china/qqbot` 升级，使其纳入上游 `@tencent-connect/openclaw-qqbot` v1.6.0 → v1.7.2 期间新增的核心能力，同时**完整保留** fork 已有的 China 本地化交付特性。本文档提供：

1. 两侧逐子系统的实现差异（§3、§4）。
2. 升级策略与架构约束（§2）。
3. 优先级积压与工作量估算（§5）。
4. 四阶段实施计划与依赖（§6）。
5. 风险登记册与对抗性验证结论（§7）。
6. 必须保留特性总表（§8）、配置字段映射（§9）、实施前置验证清单（§10）、文件清单（§11）、测试策略（§12）。

### 0.2 范围

**范围内**：把上游 v1.7.2 的能力（斜杠命令、命令审批、Webhook transport、大文件分片上传、SSRF 守卫、per-group 精调、provider STT/TTS、多账户健壮性增强、跨设备引用回退、热升级等）以**能力移植**方式落地到 fork。

**范围外**（显式排除）：
- **不做文件级 rebase**：上游是自包含守护插件（`preload.cjs` + `gateway.ts` 自管一切），fork 是结构化渠道扩展 + 跨渠道共享包（§2），两者架构不兼容，按文件覆盖会摧毁共享基础设施与 China 打包。
- **不改 fork 的渠道契约**：`qqbotPlugin`（`gateway.startAccount`/`config.*`/`outbound`/`messaging`/`security`/`setup`/`onboarding`）保持不变，上游能力映射进这些契约。
- **不动其它渠道**：所有对共享能力的改动（如 `packages/shared/src/policy/group-policy.ts`）须评估对 dingtalk/feishu/wecom/wecom-app/wecom-kf/wechat-mp 的连锁影响。

---

## 1. 执行摘要 (TL;DR)

1. **版本差距**：fork 停留在上游 **≈v1.5.7 血缘** + 自研 China 特性；上游已到 v1.7.2。逐子系统比对识别出约 **138 项 gap**，归并为 §5 的 P0/P1/P2 积压项。

2. **fork 是「China 交付体验领先、平台能力落后」的混合体**：在 C2C markdown 传输、可配置 typing 心跳、`replyFinalOnly`、流式 `InputNotify`、`displayAliases`/known-targets 显示名、Tencent Flash ASR 等**本地化交付**上领先上游；在 SSRF 防护、大文件上传、per-group 精调、Webhook、命令审批、provider STT/TTS、`/bot-*` 运维命令、跨重启 RESUME 等上严重落后。

3. **三大致命缺口**：(a) **安全**——inbound 媒体 URL 无 SSRF 守卫（真实暴露面）；(b) **核心能力**——大文件 chunked 上传、per-group 精细控制、Webhook、exec 审批、TTS、provider STT 全缺；(c) **可运维性**——无 `/bot-*` 命令、无跨重启 RESUME、无后台 token 刷新、无 in-process 升级。

4. **升级策略 = 能力移植，非 rebase**（§2）。关键约束：上游自包含模块（media-send / audio-convert / image-server / reply-dispatcher / message-queue / gateway）**不能整体复制**——它们与 fork 的共享包（`@openclaw-china/shared`，跨 7 渠道）和 host-runtime 分发委托重复或冲突，必须择优移植并改指向 fork 契约/shared。

5. **单点最高风险 = Config 存储键**（§7、C1 已确认）：fork 读 `channels["qqbot-china"]`，上游读 `channels.qqbot`。若直接采纳上游 config 解析，**所有现有用户配置静默变孤儿**。Phase 1 第一件事锁定：保留 `qqbot-china` 为权威 key + 读侧兼容层，其后每个移植点统一指向它。

6. **对抗性验证结论**（§7.1）：C1（config 键）/ C2（historyLimit 死配置）/ C3（requireMention 仅 flat）/ C4（STT 格式 SILK↔WAV 不兼容）**全部 confirmed**；C5（approval SDK）**partially**——`createOperatorApprovalsGatewayClient` 在 fork bundled openclaw 中**未确认可用**，approval 落地前必须实测。

7. **四阶段**（§6）：Phase 1 基础设施（config/manifest/SSRF/session/token）→ Phase 2 高价值（per-group 精调/chunked 上传/slash 只读命令/RequestContext）→ Phase 3 高级（STT-TTS/approval/webhook/skills）→ Phase 4 打磨（hot-upgrade/streaming 健壮性/deliver-debounce）。

---

## 2. 架构背景与升级策略

### 2.1 两侧架构本质差异

| 维度 | Fork（@openclaw-china/qqbot） | 上游（@tencent-connect/openclaw-qqbot） |
|---|---|---|
| 形态 | **结构化渠道扩展**，实现宿主渠道插件契约 | **自包含守护插件** |
| 入口 | `index.ts` default export `plugin`，`register(api){ api.registerChannel({plugin: qqbotPlugin}) }` | `preload.cjs` bootstrap → 自启 `gateway.ts` |
| 连接管理 | `qqbotPlugin.gateway.startAccount/stopAccount`（framework 按账户回调）+ `monitor.ts` 持有 `activeConnections` Map | `gateway.ts` 自管单/多账户 WS/Webhook 生命周期 |
| 回复分发 | **外包给 host runtime**：`runtime.ts` 调 `channel.reply.dispatchReplyWithDispatcher` 等 | 自带 `reply-dispatcher.ts` + `message-queue.ts` + `deliver-debounce.ts` |
| 配置/账户管理 | `qqbotPlugin.config.{listAccountIds,resolveAccount,...}` + `security.collectWarnings` + `onboarding` adapter | 自解析 `openclaw.json`，自管 |
| 媒体/ASR/Policy | **跨渠道共享**：`@openclaw-china/shared`（media/asr/policy/cron/cli/logger），7 个渠道共用 | 自包含（`utils/media-send.ts`、`audio-convert.ts`、`image-server.ts` 等） |
| 打包 | triple-key（`openclaw`/`moltbot`/`clawdbot`）+ tsup + `2026.x.x-N` 日期 semver + monorepo release | 单 `openclaw` block + tsc + npm publish |
| config key | `channels["qqbot-china"]`（`QQBOT_CONFIG_CHANNEL_ID`） | `channels.qqbot` |

### 2.2 为什么是「能力移植」而非「rebase」

1. **共享基础设施冲突**：上游 `utils/media-send.ts`、`audio-convert.ts`、`image-server.ts`、`ssrf-guard.ts` 等是自包含实现；fork 已有 `packages/shared` 提供跨渠道 media/asr/policy。直接复制上游文件会在 qqbot 内部产生**第二套** media/asr 实现，与共享包行为分裂、维护双轨。
2. **分发架构倒置**：上游 `reply-dispatcher.ts` + `message-queue.ts` + `gateway.ts` 编排整个入站生命周期；fork 刻意把这些外包给 host runtime（`runtime.ts:56-99`）。整体移植会与 host dispatch **双重排队/双重分发**，顺序错乱。
3. **渠道契约依赖**：framework 通过 `qqbotPlugin.gateway.startAccount` 驱动连接、`qqbotPlugin.config.*` 驱动账户管理、`qqbotPlugin.security.collectWarnings` 驱动安全审计。上游没有这套契约——它的能力必须**映射进这些 hook**，而非绕过。

**结论**：每个上游能力按「提取核心逻辑 → 适配 fork 契约/shared → 保留 fork 同领域特性」的方式逐项落地。

### 2.3 上游能力 → fork 契约的映射面

上游自管的能力在 fork 中落到以下契约点（移植时挂载于此，不要另起炉灶）：

| 上游模块 | fork 落点 |
|---|---|
| `gateway.ts`（WS 生命周期/close-code/RESUME） | `qqbotPlugin.gateway.startAccount` + `monitor.ts`（`scheduleReconnect`、`activeConnections`） |
| `transport/webhook-*` | `gateway.startAccount` 内新增 transport 分支（需 shared 暴露 webhook-ingress，见 §10） |
| `api.ts` token cache / 后台刷新 | `client.ts`（`tokenCacheMap`，已 per-appId）+ `monitor.ts` READY 钩子 |
| `reply-dispatcher.ts`（token 重试/媒体路由） | `outbound.ts`（`sendText`/`sendMedia`）包 `sendWithTokenRetry`；媒体路由复用 fork 既有 |
| `chunked-upload.ts` / `upload-cache.ts` / `media-send.ts` | `outbound.ts` `sendMedia` → `chunkedUploadAndSend`；SSRF 接入 `packages/shared` 下载入口 |
| `audio-convert.ts` / `stt.ts` / TTS | `packages/shared/asr`（Tencent Flash 以 `provider:"tencent-flash"` 接入）+ 新增 provider STT/TTS |
| `group-history.ts` / `message-gating.ts` | `bot.ts`（`shouldHandleMessage`、`buildInboundContext`）+ 扩展 `packages/shared/policy/group-policy.ts` |
| `session-store.ts` | `monitor.ts`（WebSocket Resume） |
| `slash-commands.ts` / `update-checker.ts` | `bot.ts` `handleQQBotDispatch` 顶部接入（**在 fork abort 之前**） |
| `approval-handler.ts` / `admin-resolver.ts` | `qqbotPlugin.security` + INTERACTION_CREATE 事件分支 + `message-gating` |

---

## 3. 两侧差异总览

| # | 子系统 | Fork 现状 | 上游现状 | gap | fork独有 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|---|
| 4.1 | Config/Types/Manifest | Zod schema + `channels["qqbot-china"]` + Tencent ASR + inline JSON Schema（三处手抄） | 无 Zod + `channels.qqbot` + provider STT + 空 schema + `preferOver`/`capabilities` | 18 | 14 | **P0** | 16-24h |
| 4.2 | Transport/Connection | 仅 WebSocket，内存 session，固定 backoff，无 webhook | WS + Webhook 双 transport，磁盘 session + 跨重启 RESUME，close-code 感知重连，后台 token 刷新 | 16 | 8 | P1 | 16-24h |
| 4.3 | Slash 命令/运维 | 仅本地化 abort 触发词；无 `/bot-*`、无 update-checker、无 bin | 9 个 `/bot-*` + update-checker + startup-greeting + credential-backup + CLI | 10 | 3 | P1 | 3-5d |
| 4.4 | Approval 审批 | **完全缺失**；硬编码 `CommandAuthorized:true` | approval-handler + inline-keyboard + admin-resolver + message-gating 三层 gate | 9 | 6 | P1 | 3-4d |
| 4.5 | 媒体/大文件 | 单次 base64 上传，无 SSRF 守卫，无 chunked，无 media tag | chunked 分片上传 + SSRF guard + image-server + `<qqmedia>` + upload-cache + 错误码映射 | 10 | 7 | **P0** | 3-4d |
| 4.6 | Voice STT/TTS | 仅 Tencent Flash ASR（直传 SILK），无 TTS，硬依赖 ffmpeg-static | provider STT（OpenAI 兼容）+ 完整 TTS + 887 行 audio-convert.ts（WASM 回退） | 11 | 4 | P1 | 3-5d |
| 4.7 | 群聊精调 | account 级 flat policy，`historyLimit` 是**死配置**，SDK `checkGroupPolicy` 委托 | per-group 引擎：4 层优先级链 + group-history LRU + 三层 gates + SDK adapter | 13 | 3 | **P0** | 3-5d |
| 4.8 | Multi-account | 已有 per-appId token cache Map + activeConnections + 单 flight | 同上 + 后台主动刷新 + AsyncLocalStorage RequestContext + richer ResolvedAccount | 6 | 4 | P1 | 12-20h |
| 4.9 | Streaming/Typing/Markdown | **可配置性更强**：typing 模式/间隔、C2C md 三模式、replyFinalOnly、长任务提醒 | 控制器更健壮：phase 状态机 + mutex flush + raw-text 边界 + 内联 media 流式 | 10 | 9 | P1 | 12-24h |
| 4.10 | 主动消息/引用索引/队列 | `KnownQQBotTarget` 统一 store，host-runtime 委托 dispatch，无 401 重试，缓存未命中丢弃引用上下文 | known-users + 自有 queue/dispatcher/debounce/session-store + 跨设备 quote 回退 + 401 重试 | 8 | 6 | P1 | 28-40h |
| 4.11 | Skills/Tools | 0 tool，1 skill（contact-send + Python 脚本） | 2 tool（channel_api/remind）+ 4 skill | 7 | 5 | P1 | 16-28h |
| 4.12 | 升级基础设施 | 无 in-process 升级；china-setup 向导 + monorepo release | 完整 hot-upgrade 栈：`/bot-upgrade` + 脚本 + preload + postinstall + CLI | 14 | 7 | P1 | 24-40h |

> 详细差距清单、保留清单、实施方案与测试见各子系统 §4.x。

---

## 4. 子系统详细设计

本节为 12 个子系统的逐项深化设计，均经源码逐条核验（每条结论 cite file:line）。每节固定包含六个子节：**现状对比**（fork file:line vs 上游）/ **差距清单** / **必须保留**（China-fork 特性）/ **实施方案**（文件级 create/modify + fork→上游映射 + 集成点）/ **测试计划** / **风险与注意事项**。

### 4.0 核验说明与勘误

12 个子系统均经独立 agent 对照真实代码核验（`verified=true`）。以下为核验中对先前一轮分析的**关键修正**（已在对应 §4.x 正文内体现，此处汇总供快速核对）：

**§4.1 Config / Types / Plugin Manifest**
- Prior claim 'manifest capabilities block {proactiveMessaging:true, cronJobs:true} — fork lacks capabilities' is technically true at the manifest level but imprecise: the fork DOES have a capabilities block, just on the ChannelPlugin object (channel.ts:71-81: {chatTypes:['direct','group','channel'], media:true, edit:false, reply:true, polls:false, activeSend:true, blockStreaming:false}) — it is a DIFFERENT capability shape. Upstream manifest capabilities (openclaw.plugin.json:8-11) are a separate manifest-level field {proactiveMessaging, cronJobs} that the fork's manifest genuinely lacks entirely.
- Prior claim implied fork capabilities has 'edit/polls/activeSend flags' as divergent — but fork channel.ts:71-81 also includes reactions:false and threads:false (same as upstream), the fork's chatTypes additionally includes 'channel' which upstream channel.ts:71 omits (upstream is ['direct','group'] only). The divergence is chatTypes scope + blockStreaming value, not just the extra flags.
- Prior claim '4 named skill bundles (qqbot-channel, qqbot-remind, qqbot-media, qqbot-upgrade) — fork has 1 (./skills/qqbot-contact-send)' is confirmed but should note the fork's skills entry is './skills' (a directory glob) in openclaw.plugin.json:7 vs upstream's explicit array of 4 named dirs (openclaw.plugin.json:7) — they are different manifest shapes, not just a count diff.
- Prior 'emptyPluginConfigSchema / SDK-driven config typing — fork uses hand-maintained inline JSON Schema' is confirmed, but should note the inline schema exists in THREE places in the fork: index.ts:34-147 (default-export plugin), channel.ts:134-249 (qqbotPlugin.configSchema.schema), AND openclaw.plugin.json:8-131. These three copies are NOT auto-synced — that is itself a maintainability hazard the port must address, not merely a choice.

**§4.2 Transport & Connection**
- Prior finding: 'session-store.ts (pure fs, no SDK deps) ... lowest-risk pieces to port.' — Imprecise. session-store.ts imports getQQBotDataDir from ./utils/platform.js (session-store.ts:28, platform.ts:63), NOT pure fs. But this is a trivial 1-function dependency (path.join(home, '.openclaw','qqbot',...)) that the fork already replicates inline in ref-index-store.ts:34 (join(homedir(),'.openclaw','qqbot','data','ref-index.jsonl')). So the claim is directionally correct (portable, no SDK contract deps) but session-store is NOT zero-dependency; the platform helper must be re-inlined or a fork-local getDataDir() added.
- Prior finding listed webhook-transport.ts as depending on 'plugin-sdk webhook-ingress (registerWebhookTargetWithPluginRoute, withResolvedWebhookRequestPipeline...)'. Verified correct AND more severe than stated: the fork has NO webhook-ingress module anywhere — @openclaw-china/shared exposes no registerWebhookTarget/withResolvedWebhookRequestPipeline/createFixedWindowRateLimiter/createWebhookInFlightLimiter. The fork's only HTTP-route mechanism is MoltbotPluginApi.registerHttpRoute/registerHttpHandler (declared in wechat-mp/src/types.ts:612-615, used in wechat-mp/src/webhook.ts:278). Upstream's entire webhook-transport.ts rate-limiter/in-flight-limiter pipeline (webhook-transport.ts:100-114) must be reimplemented on the fork's simpler registerHttpRoute contract — it cannot be imported.
- Prior finding: 'fork's monitor.ts already implements in-memory RESUME'. Verified precise: monitor.ts:273-274 sends op:6 RESUME when nextConn.sessionId && lastSeq exist, but these are in-memory (monitor.ts:90-91 ActiveConnection fields) and cleared on finish() (monitor.ts:182-183) — so RESUME works ONLY across in-process reconnects (op:7/close), NOT across process restarts. Correctly characterized.
- Prior finding implied fork intents are 'GUILD_MESSAGES(1<<30)'. Verified: monitor.ts:36-42 names it GUILD_MESSAGES = 1<<30 but the value 1<<30 is actually PUBLIC_GUILD_MESSAGES per QQ spec (upstream gateway.ts:344 names it correctly as PUBLIC_GUILD_MESSAGES). Same numeric, just mislabeled in the fork. No behavioral impact.
- Prior finding: 'op:9 (invalid session — clears session + token cache)'. Verified precise: monitor.ts:290-298 clears sessionId+lastSeq AND calls clearTokenCache(appId) (monitor.ts:293) then scheduleReconnect. Upstream gateway.ts:2126-2141 instead reads the boolean d payload (canResume), only clears when !canResume, calls clearSession(accountId), sets shouldRefreshToken=true (token refreshed on next connect, not immediately), and scheduleReconnect(3000) with an explicit 3s delay. So fork eagerly clears token cache while upstream defers — a real behavioral divergence, not just an omission.
- Prior finding: 'fork backoff array [1,2,5,10,20,30]s'. Verified exact: monitor.ts:44 RECONNECT_DELAYS_MS = [1000,2000,5000,10000,20000,30000]. Upstream gateway.ts:356 RECONNECT_DELAYS = [1000,2000,5000,10000,30000,60000] — note 5th/6th entries differ (fork 20s/30s vs upstream 30s/60s). The prior note conflated them.

**§4.3 Slash Command System & Operational Tooling**
- Prior finding claimed the fork has NO startup-greeting.ts / credential-backup.ts files. Verified TRUE: ls of /home/rainbow/Code/openclaw-china/extensions/qqbot/src shows neither file, and channel.ts imports (lines 1-26) contain no such imports. (The earlier grep that surfaced `channel.ts:15: import { saveCredentialBackup }` was run against UPSTREAM's channel.ts in the tmp dir, not the fork's — a path-confusion false positive.) The original localState/notes were correct; flagging this because it is the easiest claim to mis-verify.
- Prior finding implied bot-streaming/bot-group-allways write to a generic `runtime.config.loadConfig()/writeConfigFile()`. Verified the API name but NOT its existence in the fork: the fork's PluginRuntime interface (src/runtime.ts:9-117) has NO `config` field at all — it only exposes channel.{routing,session,reply,text} and system.enqueueSystemEvent. So these config-mutation commands CANNOT work without first extending PluginRuntime with a config-write surface; this is a hard Phase-2 prerequisite, not a passthrough.
- Prior finding listed `defaultRequireMention` and `groups.*.requireMention` priority chain as upstream features to port. Verified the fork's schema is FLAT: config.ts:83 has `requireMention` (account-level only), there is NO `defaultRequireMention` key and NO `groups` map anywhere in fork src or packages/shared/src (grep returned only group-policy.ts using `requireMention` as a runtime boolean param, not a config key). So bot-group-allways must be adapted to the fork's flat `requireMention` field (or the fork schema extended) — the upstream priority chain 'groups.* > defaultRequireMention > true' does not exist to hook into.
- Prior finding stated bot-clear-storage targets `~/.openclaw/media/qqbot/downloads/{appId}/`. Verified upstream slash-commands.ts:1799 indeed uses that per-appId path. But the fork's media dir convention is DIFFERENT: config.ts:111 `DEFAULT_INBOUND_MEDIA_DIR = ~/.openclaw/media/qqbot/inbound` (flat, account-scoped via resolveInboundMediaDir, NOT per-appId). Porting bot-clear-storage verbatim would scan a non-existent path; it must read the fork's resolveInboundMediaDir()/keepDays instead.
- Prior finding grouped `/bot-approve` urgent fast-path with `/stop`. Verified gateway.ts:586 `URGENT_COMMANDS = ['/stop','/approve']`, but bot-approve's handler (slash-commands.ts:2049-2155) is the REAL command logic; the urgent fast-path only matters for breaking out of a blocking approval wait. In the fork there is NO approval-wait concept at all (no approval-handler.ts, no gateway-runtime loader), so the /approve urgent entry is meaningless until approval infra is ported — should be deferred with /bot-approve, not added to the abort fast-path in Phase 1.

**§4.4 Command-Execution Approval**
- prior-diffs implied /approve is a slash-command; actually /approve is NOT a registerCommand in slash-commands.ts — grep for name:"approve" returns nothing. /approve is only listed in gateway.ts:586 URGENT_COMMANDS=["/stop","/approve"] and handed to the framework's message queue via executeImmediate (gateway.ts:598-606). Only /bot-approve is a registerCommand (slash-commands.ts:2038).
- prior-diffs said fork treats /stop as a 'fast-abort text command' via checkDmPolicy path; precise location: fork's abort is isQQBotFastAbortCommandText (bot.ts:428-444) checked inside dispatchToAgent (bot.ts:2984), NOT a message-queue urgent-command concept. The fork has no message queue / no URGENT_COMMANDS array — that concept is upstream-only (gateway.ts:586).
- prior-diffs listed admin-resolver.ts 'auto-detect admin from first known c2c user' as missing; confirmed correct, but note admin-resolver depends on upstream's known-users.ts (listKnownUsers) and startup-greeting.ts (getStartupGreetingPlan/markStartupGreetingSent/markStartupGreetingFailed) — neither exists in the fork. The fork has no known-users or startup-greeting modules at all, so admin-resolver cannot be ported without those two dependencies first.
- prior-diffs listed channel.ts hooks as 'approvals/execApprovals'; precise: upstream declares BOTH flat `execApprovals` (channel.ts:467, for 3.28 framework) AND nested `auth`+`approvals` (channel.ts:491-514, for 3.31+ framework), plus outbound.shouldSuppressLocalPayloadPrompt (channel.ts:294). All three locations must be ported, not just one.
- prior-diffs said fork's gateway is in client.ts; incorrect — there is no gateway logic in fork src/client.ts (grep for INTERACTION/dispatch/ws returned nothing). The fork's gateway/WS inbound path is monitor.ts (case 0 dispatch at monitor.ts:299-325) and the lifecycle entrypoint is qqbotPlugin.gateway.startAccount (channel.ts:367) which calls monitorQQBotProvider. INTERACTION_CREATE must be wired in monitor.ts, not client.ts.

**§4.5 ## Outbound Media Send, Large-File Chunked Upload, Inbound Attachments**
- Prior claim that upstream sendPhoto uses a 'Base64 rich-media API send (sendC2CImageMessage/sendGroupImageMessage)' for the local-image path is imprecise: sendPhoto's local and data-URL paths both funnel into chunkedUploadAndSend (outbound.ts:362-385), NOT a base64 image API. sendC2CImageMessage (api.ts:1103) exists but is used by outbound-deliver.ts sendPlainReply/sendMarkdownReply for markdown-image rendering, not by sendPhoto.
- Prior claim 'concurrency ... capped at 10' is correct but the DEFAULT (when API omits concurrency) is 1, not 10: chunked-upload.ts:54 DEFAULT_CONCURRENT_PARTS=1, capped at MAX_CONCURRENT_PARTS=10 at :141-144. The phrasing 'concurrency control (cap 10)' understates that the actual concurrency is usually 1 unless the server returns more.
- Prior claim attributes voice transcoding to 'send.ts convertAudioToSilk (ffmpeg-static + silk-wasm)' which is correct for the fork; but upstream's voice transcode is convertSilkToWav in utils/audio-convert.ts used for INBOUND (inbound-attachments.ts:285), while outbound SILK encoding in upstream sendVoice is in sendVoiceFromLocal (outbound.ts:438-479) and is a separate code path. The two are not the same module — do not reuse upstream's audio-convert.ts for fork outbound encoding.
- Prior claim 'file_info dedup cache ... 500-entry LRU' is slightly imprecise: upload-cache.ts is NOT a true LRU — it does lazy expiry eviction then on overflow deletes 'earliest half' by Map insertion order (upload-cache.ts:84-99). Map insertion order != LRU recency. Call it an insertion-order eviction, not LRU.
- Prior claim that media-tags.ts has '~40 misspelled tag aliases' is roughly right but the canonical list is in media-tags.ts:13-55 (TAG_ALIASES) — exactly 30 aliases plus 5 VALID_TAGS; counting combined ALL_TAG_NAMES it is 35 names, not 40. The count '40' should read '35 (30 aliases + 5 canonical)'.

**§4.6 Voice STT/ASR + TTS + Audio Conversion — capability port**
- Prior claim: upstream STT 'requires a WAV file'. Imprecise. transcribeAudio() (src/stt.ts:58-86) accepts ANY audio file path and sets MIME by extension (.wav→audio/wav, .mp3→audio/mpeg, .ogg→audio/ogg, else octet-stream). The WAV requirement is enforced upstream in inbound-attachments.ts:285 convertSilkToWav BEFORE calling transcribeAudio, because the OpenAI endpoint expects a decodable container — not because transcribeAudio rejects non-WAV. This matters for the port: a Tencent provider route can hand raw SILK bytes directly to Tencent without any local conversion, while an OpenAI route must still convert to WAV first.
- Prior claim implied upstream has 'sendVoice transcodeEnabled / chunked-upload-with-transcode path in outbound.ts' as a standalone subsystem. Verified it lives in upstream outbound.ts:411-479 (sendVoice/sendVoiceFromLocal with shouldTranscodeVoice gate + audioFileToSilkFile). But the FORK does NOT have a chunked-upload path — the fork uses uploadC2CMedia/uploadGroupMedia + sendC2CMediaMessage/sendGroupMediaMessage (client.ts:446-556) with MediaFileType.VOICE. So 'porting chunked upload' is NOT in scope for this subsystem; only the transcode-decision + audioFileToSilkFile conversion is relevant, adapted to the fork's existing media-upload primitives.
- Prior claim listed 'waitForFile() polling for async TTS output'. Verified at audio-convert.ts:618-684. Clarification: it is only needed when TTS writes to a path asynchronously (textToSilk writes synchronously via fs.writeFileSync at audio-convert.ts:427, so waitForFile is NOT exercised by textToSilk itself — it is used in upstream outbound.ts:447 sendVoiceFromLocal). For the fork port it is a defensive add for the send path, not a TTS-internal requirement.
- Prior claim: fork '[[tts:...]] tag parsing ... never synthesizes speech'. Accurate, but understates that the fork parses and STRIPS these tags (bot.ts:1481-1482 DIRECTIVE_TAG_RE + VOICE_EMOTION_TAG_RE in sanitizeQQBotOutboundText) purely for text cleanup — they currently produce no side effect at all, so there is no existing TTS behavior to preserve/migrate beyond the regex itself.

**§4.7 Per-group requireMention / toolPolicy / prompt / historyLimit port from upstream v1.7.2**
- Prior finding said upstream `historyLimit` default is 50 — VERIFIED accurate (config.ts:82 DEFAULT_GROUP_HISTORY_LIMIT=50), but note the JSDoc on GroupConfig.historyLimit in types.ts:59 says 'default 20'; the code default (50) wins. Fork's account-level historyLimit default is 10 (config.ts:86). Both values differ and neither matches.
- Prior finding implied upstream group gating reads `event.mentions`/`event.refMsgIdx` off the raw event. True for upstream, but CRITICAL gap not flagged: the FORK's parseGroupMessage (bot.ts:1096-1118) HARDCODES mentionedBot:true and DISCARDS the raw mentions[] array and message_type. So ignoreOtherMentions/hasAnyMention/implicit-mention cannot work in the fork until parseGroupMessage is extended to capture mentions[] + refMsgIdx + message_type into QQInboundMessage (types.ts:46-62 has none of these fields). This is a larger prerequisite than the prior diff suggested.
- Prior finding said fork's `groups` SDK adapter is 'absent' — correct, but additionally the fork does NOT ship an openclaw-plugin-sdk.d.ts (no plugin-sdk type declarations in extensions/qqbot/src) and imports everything from @openclaw-china/shared, which has NO ChannelGroupAdapter/GroupToolPolicyConfig types (verified: grep of packages/shared/src returns nothing). So the fork's core SDK may not even consume a `groups` adapter yet — adapter registration is only useful if the openclaw core that the fork runs against supports it. Must verify core support before relying on it; otherwise resolveToolPolicy must be applied in-channel via dispatchToAgent.
- Prior finding listed `resolveMentionPatterns` as a gap (correct) but did not note it depends on reading cfg.agents.list[].groupChat.mentionPatterns — an agent-scoped config outside the qqbot channel config. Porting it couples the qqbot extension to the global agent config shape; document this dependency.

**§4.8 Multi-Account**
- Prior claim that upstream api.ts background refresh lives at '~L1175-1275' is correct but should be cited as src/api.ts:1187-1272 (backgroundRefreshControllers Map at 1187, startBackgroundTokenRefresh 1189-1248, stopBackgroundTokenRefresh 1254-1267, isBackgroundTokenRefreshRunning 1269-1272).
- Prior claim that gateway.ts calls stopBackgroundTokenRefresh 'on close' is imprecise: it is called in the abort-signal cleanup handler (gateway.ts:700, stopBackgroundTokenRefresh(account.appId)) and in the webhook-transport teardown (gateway.ts:1971, stopBackgroundTokenRefresh() no-arg). The WS ws.on('close') handler at gateway.ts:2148 does NOT directly stop background refresh; it calls cleanup() + scheduleReconnect(), and the next connect() re-calls startBackgroundTokenRefresh at gateway.ts:1994 (idempotent — startBackgroundTokenRefresh bails if appId already running, api.ts:1194). For the fork, the stop call must therefore go in monitor.ts's finish() (the per-account teardown, monitor.ts:176-193), not in the socket-close reconnect path.
- Prior claim 'getTokenStatus(appId) (api.ts L256)' — correct: src/api.ts:256-267. The fork's client.ts has no equivalent; confirmed absent via grep.
- Prior claim lists upstream richer ResolvedQQBotAccount fields including clientSecret/secretSource/clientSecretFile/systemPrompt/imageServerBaseUrl/userAgentSuffix/name/config — verified at upstream src/types.ts:19-33 and src/config.ts:283-295. The fork's ResolvedQQBotAccount (fork src/types.ts:17-27) only carries accountId/enabled/configured/appId/streaming/markdownSupport/c2cMarkdown*/typingHeartbeatMode; note it does NOT expose clientSecret (fork passes appId+clientSecret via resolveQQBotCredentials at config.ts:295-302 instead).
- Prior claim about fork known-targets being scoped by 'accountId+kind+target' is correct (proactive.ts:17-26), and is functionally equivalent to upstream known-users.ts makeUserKey 'accountId:type:openid(:groupOpenid)' (known-users.ts:130-136) — so the two are sibling features, not duplicates; the fork's is already account-scoped. No port needed.

**§4.9 Streaming, Typing Indicator, Markdown Delivery**
- Prior called upstream's controller class `QQBotStreamingController` ('~333-line QQBotStreamingController'). Actual class name in upstream src/streaming.ts:235 is `StreamingController` (fork's is `QQBotStreamingController` at src/streaming.ts:33). The 333-line figure is the FORK's controller length, not upstream's; upstream StreamingController spans streaming.ts:235-980 (~745 lines) inside a 1078-line file. The class-name divergence is itself part of the port risk (same role, different identifiers).
- Prior implied upstream and fork share 'overlapping constructor shapes'. They do NOT overlap usefully: fork constructor takes a flat QQBotStreamingControllerParams (streaming.ts:17-28: appId/clientSecret/openid/messageId/eventId/onFirstChunk), upstream takes a StreamingControllerDeps object (streaming.ts:195-218: account/userId/replyToMsgId/eventId/mediaContext). A drop-in is not possible; the deps must be adapted to the fork's contract layer (outbound/client).
- Prior listed the WS gateway heartbeat under 'monitor.ts (multi-account)' for the fork only and noted upstream folds it into gateway.ts; precise upstream location is gateway.ts:2052-2056 (op:1 send on Hello interval) and gateway.ts:2116 (op:11 ACK), vs fork monitor.ts:218-227 (startHeartbeat) and monitor.ts:280-283 (case 11 ACK). Both implement the same QQ WS heartbeat; this is NOT a port target — keep fork's multi-account monitor.ts unchanged.

**§4.10 主动消息 / 引用索引 / 队列与会话**

**§4.11 Skills & Tools**
- Prior finding: upstream imports getAccessToken/API_BASE from './api.js' and claims the fork lacks them — WRONG. The fork already exports getAccessToken(appId, clientSecret, options?) from extensions/qqbot/src/client.ts:130-172 with an appId-keyed token cache (tokenCacheMap) and a QQBot bearer header (Authorization: QQBot {token}); API_BASE = 'https://api.sgroup.qq.com' at extensions/qqbot/src/client.ts:3. It is consumed in send.ts:6/162, monitor.ts:14/269/338, outbound.ts:16. Porting channel.ts should reuse fork client.ts, not upstream api.ts.
- Prior finding: upstream's registerChannelTool/registerRemindTool are called from index.ts:17-18 against OpenClawPluginApi.registerTool — TRUE for upstream, but the prior note 'Tool registration is additive and won't conflict with the fork's registerChannel-only index.ts' understates the blocker. The fork's plugin API type MoltbotPluginApi (extensions/qqbot/index.ts:11-15) declares ONLY `registerChannel` and `runtime`; there is NO registerTool anywhere in the entire openclaw-china repo (verified: grep across extensions/ and packages/shared/src finds zero matches, including sibling extension wecom-kf which uses the identical registerChannel-only MoltbotPluginApi). So upstream's `api.registerTool(...)` cannot be called verbatim in the fork — a tool-registration surface must be added (to MoltbotPluginApi and the ChannelPlugin contract) or an equivalent path found before qqbot_channel_api/qqbot_remind can register.
- Prior finding: 'qqbot_remind wraps cron job creation ... auto-resolving target/accountId from request context (request-context.ts)' — accurate, but the fork's gap is bigger than stated: the fork has NO AsyncLocalStorage request-context anywhere (grep for AsyncLocalStorage/runWithRequestContext/getRequestTarget/getRequestAccountId in extensions/qqbot/src returns zero). The per-request target+accountId DO exist locally inside the inbound dispatch (monitor.ts:316-323 calls handleQQBotDispatch with cfg+accountId; bot.ts:1249-1282 builds target user:/group:/channel: from inbound) but are never propagated to a tool-callable scope. Porting remind.ts therefore requires creating request-context AND wiring it around the inbound dispatch, not just copying remind.ts.
- Prior finding: 'qqbot-media defines the <qqmedia> tag ... fork can only inline-render markdown images and auto-send local paths via autoSendLocalPathMedia.' Directionally correct, but imprecise about the fork's actual media pipeline: the fork imports detectMediaType/extractMediaFromText/isLocalReference/stripTitleFromUrl from @openclaw-china/shared (bot.ts:17-24) and the shared media-parser.ts (packages/shared/src/media/media-parser.ts) parses MEDIA: lines, markdown images, html <img>, and bare paths — NOT qqmedia/qqimg tags. So <qqmedia> support means adding upstream utils/media-tags.ts normalize into the fork's extractQQBotReplyMedia (bot.ts:1392) BEFORE delegating to shared extractMediaFromText; the shared parser cannot be made to emit qqmedia semantics without upstream's fuzzy tag normalizer.
- Prior finding: qqbot-upgrade skill 'runs the official npm upgrade script' — TRUE (skills/qqbot-upgrade/SKILL.md:24 pipes curl ... scripts/upgrade-via-npm.sh | bash from tencent-connect/openclaw-qqbot main). But this is NOT portable to the China fork verbatim: the fork (@openclaw-china/qqbot) has its OWN npm scope, China setup CLI (registerChinaSetupCli from @openclaw-china/shared, index.ts:9/150) and install-hint path. The upstream upgrade skill would either need its script URL retargeted to the China fork's upgrade path or be dropped. This is a preserve/duplicate conflict, not a clean port.
- Prior finding: upstream index.ts is the registration entry — the prior note cites 'index.ts:17-18' correctly, but the persisted upstream repo's src/index.ts does not exist (only src/transport/index.ts); the real entry is the repo-root index.ts (openclaw-qqbot-upstream/index.ts:14-19), which calls registerChannel + registerChannelTool(api) + registerRemindTool(api). Fork equivalent is extensions/qqbot/index.ts:149-157 register(api).

**§4.12 Upgrade Infrastructure & China-Specific Packaging/Integration**
- PRIOR CLAIM ('Multi-app support: fork writes to .openclaw/.clawdbot/.moltbot') is IMPRECISE. The fork's package.json files carry three manifest blocks (openclaw/moltbot/clawdbot keys at packages/channels/package.json:30-53 and extensions/qqbot/package.json:12-74), but the actual install/setup code only touches ~/.openclaw. china-setup.ts:75-76 hardcodes OPENCLAW_HOME=join(homedir(),'.openclaw'); DEFAULT_PLUGIN_PATH and LEGACY_PLUGIN_PATH are both under .openclaw. There is NO code writing to .clawdbot or .moltbot config dirs. The CLI-name list ['openclaw','clawdbot','moltbot'] exists only in the UPSTREAM scripts/link-sdk-core.cjs:9 and postinstall-link-sdk.js, not in any fork file. Corrected truth: fork is .openclaw-only at runtime; multi-app manifests are declarative-only.
- PRIOR CLAIM (gapsInLocal) lists 'No bin/ CLI (upstream ships bin/qqbot-cli.js)'. Correct: upstream bin/qqbot-cli.js exists (7308 bytes) registered as openclaw-qqbot + qqbot bins (package.json:9-12). Fork equivalent is NOT a per-plugin bin but the standalone @openclaw-china/setup package bin openclaw-china-setup (packages/setup/package.json:6-7, src/cli.ts) which does npm-pack of @openclaw-china/channels + openclaw plugins install + openclaw china setup. Different mechanism — the fork's CLI installs the channels meta-package, not qqbot alone.
- PRIOR CLAIM said china-setup wizard 'writes channel credentials into openclaw.json via runtime.config.writeConfigFile'. Verified: china-setup.ts uses an api.config.writeConfigFile hook (line ~238: `typeof config.writeConfigFile !== 'function'` guard, getWriteConfig at ~241). The channel key it writes is `qqbot-china` (china-setup.ts:82 QQBOT_CHANNEL_ID='qqbot-china'), which matches QQBOT_CONFIG_CHANNEL_ID in extensions/qqbot/src/config.ts:6. Confirmed precise.
- PRIOR CLAIM grouped 'skills/qqbot-upgrade skill' as missing in fork. Verified fork extensions/qqbot/skills exists but is a different skill set (manifest.skills.test.ts present); upstream skills/qqbot-upgrade/SKILL.md points to raw.githubusercontent.com/tencent-connect/openclaw-qqbot/main/scripts/upgrade-via-npm.sh — porting this skill verbatim would invoke the WRONG (upstream) package. Must be retargeted to the fork repo + package.


## 4.1 Config / Types / Plugin Manifest

### 现状对比

**Fork 现状（@openclaw-china/qqbot 2026.3.9-1）**

- 配置存储键为 `channels["qqbot-china"]`，常量 `QQBOT_CONFIG_CHANNEL_ID = "qqbot-china"`（`src/config.ts:6`），`QQBOT_CONFIG_PREFIX = "channels.qqbot-china"`（`config.ts:7`），reload 前缀数组 `QQBOT_CONFIG_PREFIXES = ["channels.qqbot-china"]`（`config.ts:8`，被 `channel.ts:251` 的 `reload.configPrefixes` 引用）。
- 配置用 **Zod** 校验：`QQBotAccountSchema`（`config.ts:55-99`）+ `QQBotConfigSchema`（`config.ts:103-106`，`extend` 账户 schema 增加 `defaultAccount`/`accounts`），`preprocess` 把 `appId` 等做 trim+coerce（`config.ts:16-19`）。
- Fork 独有账户字段：`displayAliases`（`config.ts:61`）、`asr.{enabled,appId,secretId,secretKey}`（`config.ts:62-69`，Tencent Cloud ASR）、`c2cMarkdownDeliveryMode/c2cMarkdownChunkStrategy/c2cMarkdownSafeChunkByteLimit`（`config.ts:71-73`）、`typingHeartbeatMode/typingHeartbeatIntervalMs/typingInputSeconds`（`config.ts:74-80`）、`historyLimit/textChunkLimit/replyFinalOnly/longTaskNoticeDelayMs/maxFileSizeMB/mediaTimeoutMs/autoSendLocalPathMedia`（`config.ts:86-92`）、`inboundMedia.{dir,keepDays}`（`config.ts:93-98`）。
- 多账户合并 `mergeQQBotAccountConfig`（`config.ts:270-285`）：base 展开 + account 覆盖，`displayAliases` 做跨层级 merge（`config.ts:274-283`）；`listQQBotAccountIds`/`resolveDefaultQQBotAccountId`/`resolveAccountConfig` 全部走 `resolveQQBotChannelConfig(cfg)`（`config.ts:199-201`，即读 `cfg.channels["qqbot-china"]`）。
- 凭证：`resolveQQBotCredentials`（`config.ts:295-302`）只读 `appId`/`clientSecret` 两个字段；`resolveQQBotASRCredentials`（`config.ts:304-318`）读 `asr.enabled`+三件套。**无** `clientSecretFile`、**无** `QQBOT_CLIENT_SECRET`/`QQBOT_APP_ID` 环境变量回退。
- `types.ts`：`ResolvedQQBotAccount`（`types.ts:17-27`）只暴露 `accountId/enabled/configured/appId/streaming/markdownSupport/c2cMarkdown*`，**不含** 原始 `config` 透传字段（对比上游）。`QQInboundMessage`/`InboundContext`/`QQBotSendResult`/`QQChatType="direct"|"group"|"channel"`（`types.ts:29-89`）。
- `index.ts`：内联 JSON Schema（`index.ts:34-147`，account + accounts 两套字段各写一遍），`register()` 调 `registerChinaSetupCli(api, {channels:[QQBOT_CONFIG_CHANNEL_ID]})` + `showChinaInstallHint(api)`（`index.ts:149-157`），`peerDependencies.moltbot`（`package.json:104-106`）。
- `channel.ts` 的 `qqbotPlugin.configSchema.schema`（`channel.ts:134-249`）**第三份**手抄 JSON Schema。
- `openclaw.plugin.json`：`id:"qqbot"`、`channels:["qqbot"]`、`version:"0.1.0"`、`skills:["./skills"]`、`uiHints`（`appId/clientSecret/asr.*` 的 label/sensitive，行 132-138）、configSchema（行 8-131，第三份手抄）。`package.json` 三键打包：`openclaw`/`moltbot`/`clawdbot`（`package.json:12-74`），`npmSpec:"@openclaw-china/qqbot"`。

**上游现状（@tencent-connect/openclaw-qqbot 1.7.2）**

- 配置存储键为 `channels.qqbot`（`src/config.ts:185,199,220,243`，`resolveUserAgentSuffix`/`listQQBotAccountIds`/`resolveDefaultQQBotAccountId`/`resolveQQBotAccount` 均 `cfg.channels?.qqbot`），类型 `QQBotChannelConfig extends QQBotAccountConfig`（`config.ts:71-75`）。
- **无 Zod**，配置走 `OpenClawConfig`（`openclaw/plugin-sdk`），`channels.qqbot` 当 `unknown` 在运行时 cast（`config.ts:1-2`）。`emptyPluginConfigSchema()`（`index.ts:13`）。
- 上游 `QQBotAccountConfig`（`types.ts:74-152`）独有字段：`clientSecretFile`（行 79）、`transport:"websocket"|"webhook"`（行 83）+`webhook.{path}`（行 85）、`groups:Record<groupOpenid, GroupConfig{requireMention,ignoreOtherMentions,toolPolicy,name,prompt,historyLimit}>`（行 91）、`systemPrompt`（行 93）、`imageServerBaseUrl`（行 95）、`voiceDirectUploadFormats`(deprecated)（行 102）+`audioFormatPolicy.{sttDirectFormats,uploadDirectFormats,transcodeEnabled}`（行 107）、`urlDirectUpload`（行 113）、`upgradeUrl/upgradeMode("doc"|"hot-reload")/upgradePkg`（行 118-131）、`defaultRequireMention`（行 137）、`deliverDebounce.{enabled,windowMs,maxWaitMs,separator}`（行 142）。
- 上游 `ResolvedQQBotAccount`（`types.ts:19-35`）**透传** `config: QQBotAccountConfig`，并含 `secretSource`/`systemPrompt`/`imageServerBaseUrl`/`userAgentSuffix`。
- `resolveQQBotAccount`（`config.ts:238-296`）支持 `clientSecret`/`clientSecretFile`/`QQBOT_CLIENT_SECRET` env 三级回退，`QQBOT_APP_ID` env 回退（`config.ts:267-281`）。
- `stt.ts`（上游）：provider-based `resolveSTTConfig`（`stt.ts:26-56`）读 `channels.qqbot.stt.{provider,baseUrl,apiKey,model}` → fallback `tools.media.audio.models[0]` → `models.providers.[provider]`，`transcribeAudio` 走 OpenAI 兼容 `/audio/transcriptions`（`stt.ts:58-86`）。
- `channel.ts` 上游：`capabilities:{chatTypes:["direct","group"], media:true, reactions:false, threads:false, blockStreaming:true}`（`channel.ts:70-79`）；`groups` 适配器 `resolveRequireMention/resolveToolPolicy/resolveGroupIntroHint`（`channel.ts:88-118`），`resolveToolPolicy` 把 `"full"|"restricted"|"none"` 映射成 `{allow:[],deny:["*"]}`（`channel.ts:92-99`）；`mentions.stripMentions`（`channel.ts:121-127`）。
- `openclaw.plugin.json` 上游：`id:"openclaw-qqbot"`、`channels:["qqbot"]`、`extensions:["./preload.cjs"]`、`skills` 列 4 个具名目录、`capabilities:{proactiveMessaging:true,cronJobs:true}`、`channelConfigs.qqbot.preferOver:["qqbot"]`、`configSchema` 空（行 12-15）。

### 差距清单

上游有、fork 缺（需 port 进 fork 的 config/types/manifest，注意 fork 用 Zod + 手抄 JSON Schema 三处）：

1. `clientSecretFile` 字段 + `QQBOT_CLIENT_SECRET`/`QQBOT_APP_ID` env 回退（上游 `config.ts:267-281`、`types.ts:79`）— fork 仅有 `clientSecret`。
2. `transport:"websocket"|"webhook"` + `webhook.{path}`（`types.ts:83-85`）— fork 是 websocket-only。
3. `groups: Record<groupOpenid, GroupConfig>` 含通配 `"*"`（`types.ts:44-60,91`、`config.ts:128-145`）— fork 仅有扁平 `groupPolicy`/`groupAllowFrom`。
4. `defaultRequireMention`（账户级，`types.ts:137`、`config.ts:135`）— fork 仅有扁平 `requireMention`。
5. `deliverDebounce.{enabled,windowMs,maxWaitMs,separator}`（`types.ts:157-178`）— fork 完全缺失。
6. `audioFormatPolicy.{sttDirectFormats,uploadDirectFormats,transcodeEnabled}` + deprecated `voiceDirectUploadFormats`（`types.ts:99-203`、上游 `outbound.ts:1028-1030` 消费）— fork 无音频格式策略。
7. `urlDirectUpload`（`types.ts:113`）— fork 无公网 URL 直传开关。
8. `systemPrompt` + `imageServerBaseUrl`（`types.ts:93-95`、`config.ts:290-291`）— fork 无账户级这两个字段。
9. `/bot-upgrade` 三件套 `upgradeUrl/upgradeMode("doc"|"hot-reload")/upgradePkg`（`types.ts:118-131`、上游 `slash-commands.ts:1176-1348` 消费）— fork 无热升级子系统。
10. `userAgentSuffix`（通道级，`config.ts:71-75,184-187`）— fork 无。
11. Provider-based STT `stt.{provider,baseUrl,apiKey,model}` + `tools.media.audio.models[0]` fallback（`stt.ts:26-56`）— fork 仅 `asr.{appId,secretId,secretKey}`（Tencent）。
12. `mentionPatterns` 解析（agent 级 > global，`config.ts:16-33`）— fork 无。
13. Manifest `capabilities:{proactiveMessaging:true,cronJobs:true}`（上游 `openclaw.plugin.json:8-11`）— fork manifest 无此字段。
14. Manifest `channelConfigs.qqbot.preferOver:["qqbot"]`（上游 `openclaw.plugin.json:17-21`）— fork manifest 无 channelConfigs。
15. Manifest `extensions:["./preload.cjs"]` preload 钩子（上游 `openclaw.plugin.json:6`、`preload.cjs`）— fork 无 preload。
16. 4 个具名 skill bundle（`qqbot-channel/qqbot-remind/qqbot-media/qqbot-upgrade`）— fork 仅 `./skills/qqbot-contact-send`。
17. ChannelPlugin `groups` 适配器（`resolveRequireMention/resolveToolPolicy/resolveGroupIntroHint`，上游 `channel.ts:88-118`）— fork `channel.ts` 无 groups 适配器。
18. `mentions.stripMentions` 适配器（上游 `channel.ts:121-127`）— fork `channel.ts` 用 `messaging.*` 但无 `mentions` 契约。

### 必须保留

China-fork 在本子系统下**不可丢失**的特性（port 时必须 additive，不可被上游覆盖）：

- 配置键 `channels["qqbot-china"]`（`QQBOT_CONFIG_CHANNEL_ID`，`config.ts:6`）及其在 `resolveQQBotChannelConfig`/`withQQBotChannelConfig`/`channel.ts` reload/security/onboarding/bot.ts 的全部引用 —— 这是 China 专属路由，**不可改**为 `channels.qqbot`，否则所有现存 fork 用户配置会孤立。
- Zod schema（`QQBotAccountSchema`/`QQBotConfigSchema`，`config.ts:55-106`）—— fork 依赖 schema 驱动的 UI/校验，上游 `emptyPluginConfigSchema()` 会丢掉这层。
- `asr.{enabled,appId,secretId,secretKey}` + `resolveQQBotASRCredentials`（`config.ts:62-69,304-318`）—— Tencent Cloud ASR，China 本地化，**与上游 OpenAI 兼容 stt 并存**。
- `displayAliases` map 及跨层级 merge（`config.ts:61,115-130,274-283`）—— fork 特有。
- `c2cMarkdownDeliveryMode/c2cMarkdownChunkStrategy/c2cMarkdownSafeChunkByteLimit`（`config.ts:27-39,71-73`）—— fork C2C markdown 投递策略。
- `typingHeartbeatMode/typingHeartbeatIntervalMs/typingInputSeconds`（`config.ts:41-50,74-80`）—— fork 打字心跳。
- `historyLimit/textChunkLimit/replyFinalOnly/longTaskNoticeDelayMs/maxFileSizeMB/mediaTimeoutMs/autoSendLocalPathMedia/inboundMedia.{dir,keepDays}`（`config.ts:86-98`）—— fork 媒体/分块策略。
- `registerChinaSetupCli` + `showChinaInstallHint`（`index.ts:9,150-151`，来自 `@openclaw-china/shared`）—— China 安装向导。
- `uiHints`（`openclaw.plugin.json:132-138`）—— label/sensitive 标记。
- 三键打包 `openclaw`/`moltbot`/`clawdbot`（`package.json:12-74`）+ `peerDependencies.moltbot`（`package.json:104`）—— fork 多宿主兼容。
- `qqbotPlugin.messaging.{normalizeTarget,targetResolver,formatTargetDisplay}`（`channel.ts:84-131`）—— fork 自有目标地址规范化契约（含 `channel:` 前缀，fork `chatTypes` 含 `"channel"`）。
- `ResolvedQQBotAccount` 的 fork 字段集（`c2cMarkdown*`/`typingHeartbeat*`，`types.ts:17-27`）—— 不可被上游 `config` 透传结构无声覆盖（需 additive 合并）。

### 实施方案

总原则：**上游 config/types/manifest 全部以「additive merge 进 fork 的 Zod + 手抄 schema」方式 port，不替换 fork 的配置键、不引入 `emptyPluginConfigSchema()`、不复制 `channels.qqbot`**。所有上游新字段挂到 fork 既有的 `channels["qqbot-china"]` 路径下。

**1. `src/config.ts`（modify）—— Zod schema 扩展**

- 在 `QQBotAccountSchema`（`config.ts:55-99`）**additive 追加**上游字段（保留 fork 全部现有字段）：
  - `clientSecretFile: optionalCoercedString`
  - `transport: z.enum(["websocket","webhook"]).optional().default("websocket")`
  - `webhook: z.object({ path: z.string().optional() }).optional()`
  - `groups: z.record(z.object({ requireMention: z.boolean().optional(), ignoreOtherMentions: z.boolean().optional(), toolPolicy: z.enum(["full","restricted","none"]).optional(), name: z.string().optional(), prompt: z.string().optional(), historyLimit: z.number().int().min(0).optional() })).optional()`
  - `defaultRequireMention: z.boolean().optional().default(true)`
  - `systemPrompt: z.string().optional()`、`imageServerBaseUrl: optionalCoercedString`、`userAgentSuffix: optionalCoercedString`
  - `deliverDebounce: z.object({ enabled: z.boolean().optional().default(true), windowMs: z.number().int().positive().optional().default(1500), maxWaitMs: z.number().int().positive().optional().default(8000), separator: z.string().optional() }).optional()`
  - `audioFormatPolicy: z.object({ sttDirectFormats: z.array(z.string()).optional(), uploadDirectFormats: z.array(z.string()).optional(), transcodeEnabled: z.boolean().optional().default(true) }).optional()`
  - `voiceDirectUploadFormats: z.array(z.string()).optional()`（deprecated 兼容）
  - `urlDirectUpload: z.boolean().optional().default(true)`
  - `upgradeUrl: z.string().optional()`、`upgradeMode: z.enum(["doc","hot-reload"]).optional().default("doc")`（**fork 默认 `doc` 安全模式**，上游默认 `hot-reload`）、`upgradePkg: z.string().optional()`
  - `stt: z.object({ provider: z.string().optional(), baseUrl: optionalCoercedString, apiKey: optionalCoercedString, model: z.string().optional(), enabled: z.boolean().optional() }).optional()`（保留 `asr` 不动，实现 asr 先于 stt）
- 新增 resolve 辅助函数（port 自上游 `config.ts`，全部走 fork `mergeQQBotAccountConfig` 而非上游 `resolveQQBotAccount`）：
  - `resolveClientSecret(merged)`：`clientSecret` → `clientSecretFile`（运行时 readFileSync）→ env `QQBOT_CLIENT_SECRET`（仅 default account）→ undefined。改造 `resolveQQBotCredentials`（`config.ts:295-302`）调用之。
  - `resolveGroupConfig(cfg, accountId, groupOpenid)`：port 上游 `config.ts:128-145`，读 `merged.groups`，优先级 `groups[groupOpenid] > groups["*"] > defaultRequireMention > 硬编码`。
  - `resolveRequireMention/resolveToolPolicy/resolveGroupName/resolveHistoryLimit/resolveGroupPrompt/resolveGroupIntroHint`：port 上游 `config.ts:148-179`，全部基于 `resolveGroupConfig`。
  - `resolveSTTConfig(merged, fullCfg)`：port 上游 `stt.ts:26-56` 的两级回退（`channels["qqbot-china"].stt` → `tools.media.audio.models[0]` → `models.providers.[provider]`），**键名改为读 `qqbot-china`**。
  - `resolveMentionPatterns(fullCfg, agentId)`：port 上游 `config.ts:16-33`（agent 级 > global）。
  - `resolveUserAgentSuffix(merged)`、`resolveUpgradeConfig(merged)`。
- 关键：所有新 resolve 函数的入参用 fork 的 `QQBotAccountConfig`（已 merge）而非上游的 `OpenClawConfig`，避免引入对 `openclaw/plugin-sdk` `OpenClawConfig` 的依赖。

**2. `src/types.ts`（modify）**

- `ResolvedQQBotAccount`（`types.ts:17-27`）additive 增加：`clientSecretFile?`、`transport?`、`secretSource?: "config"|"file"|"env"|"none"`、`systemPrompt?`、`imageServerBaseUrl?`、`userAgentSuffix?`、`config?: QQBotAccountConfig`（透传原始，供 outbound/gateway 读 `deliverDebounce`/`audioFormatPolicy`/`urlDirectUpload`）。**保留** fork 既有 `c2cMarkdown*`/`typingHeartbeat*` 字段。
- 新增 type 导出：`GroupConfig`、`ToolPolicy`、`TransportMode`、`WebhookTransportConfig`、`DeliverDebounceConfig`、`AudioFormatPolicy`（port 自上游 `types.ts:41-203`）。
- 保留 fork 独有：`QQInboundMessage`/`InboundContext`/`QQBotSendResult`/`QQChatType`（上游用 `C2CMessageEvent`/`GroupMessageEvent`，二者不互替，inbound 类型由各自 gateway 消费，无需统一）。

**3. `src/channel.ts`（modify）**

- `resolveQQBotAccount`（`channel.ts:41-62`）：补充新字段（`secretSource`/`systemPrompt`/`imageServerBaseUrl`/`userAgentSuffix`/`transport`/`config` 透传）。
- 新增 `groups` 适配器（port 上游 `channel.ts:88-118`）：`resolveRequireMention/resolveToolPolicy/resolveGroupIntroHint`，内部调 `src/config.ts` 新 resolve（注意 fork 的入参形状）。
- 新增 `mentions.stripMentions`（port 上游 `channel.ts:121-127`）—— 若 fork 的 inbound 结构不同，按 fork `QQInboundMessage` 调整。
- `capabilities`（`channel.ts:71-81`）：保留 fork `chatTypes:["direct","group","channel"]`（上游无 `"channel"`）；评估是否把 `blockStreaming` 改为 `true`（上游 `channel.ts:78`）—— 取决于 fork outbound 是否已支持块流式，**需与 streaming/outbound 子系统协调**，本子系统仅暴露开关。
- `qqbotPlugin.configSchema.schema`（`channel.ts:134-249`）+ `index.ts` 默认导出 `configSchema`（`index.ts:34-147`）+ `openclaw.plugin.json` configSchema：**三处手抄 JSON Schema 必须同步追加所有新字段的 JSON Schema 定义**。建议：抽取一个 `buildAccountJsonSchema()` 共享函数消除三份重复（可作为本子系统重构项）。

**4. `index.ts`（modify）**

- 保留 `registerChinaSetupCli`/`showChinaInstallHint`（`index.ts:9,150-151`），**不**替换为上游 `emptyPluginConfigSchema()`。
- 默认导出 `configSchema`（`index.ts:34-147`）同步新增字段（见上）。
- 若 port `/bot-upgrade`：新增 `registerUpgradeTool`（上游用 slash-commands 注册，fork 无 slash-commands 体系，需评估是否落进 fork 的 tool 注册路径或独立 slash handler —— 属 slash-commands 子系统范围，本子系统只负责 `upgradeUrl/upgradeMode/upgradePkg` schema）。

**5. `openclaw.plugin.json`（modify）**

- configSchema（行 8-131）同步新增字段（第三份手抄）。
- 新增 `capabilities:{proactiveMessaging:true, cronJobs:true}`（port 上游，前提是 fork 实际支持主动消息 + cron —— fork `proactive.ts` 已有 `sendProactiveQQBotMessage`，故 `proactiveMessaging:true` 安全）。
- 评估 `channelConfigs.qqbot.preferOver:["qqbot"]`：fork 的 `id` 已是 `"qqbot"`（`openclaw.plugin.json:2`），`preferOver:["qqbot"]` 会产生**自引用**（上游 `id` 是 `"openclaw-qqbot"`，preferOver `qqbot` 才有意义）。**fork 不应照搬**，若需覆盖语义需另设计（见风险）。
- `extensions:["./preload.cjs"]`：fork 当前无 preload（fork 用 `tsup` 产物 + `register()` 同步注册）。port preload 需新增 `preload.cjs` + `scripts/link-sdk-core.cjs`，属打包子系统决策，本子系统仅标注「manifest 需新增 extensions 项」。
- `skills`：fork 保留 `["./skills"]`（含 `qqbot-contact-send`），可追加上游 4 个 skill 目录（`qqbot-channel/qqbot-remind/qqbot-media/qqbot-upgrade`）—— 前提是 port 对应 skill 内容。

**6. `package.json`（modify）**

- 保留三键 `openclaw`/`moltbot`/`clawdbot`（`package.json:12-74`）+ `peerDependencies.moltbot`。
- 若 port preload，新增 `scripts/link-sdk-core.cjs` 相关字段。

### 测试计划

在 `src/config.test.ts`（现有 Zod 校验测试，`config.test.ts:14-50`）additive 追加：

1. **clientSecretFile 回退**：`resolveQQBotCredentials({appId, clientSecretFile})` 在无 `clientSecret` 时读文件返回 secret；mock fs 验证。
2. **QQBOT_CLIENT_SECRET env 回退**：设 env、清空 config 字段，default account 返回 env 值；非 default account 不读 env。
3. **groups 通配 + 具体**：`mergeQQBotAccountConfig` 含 `groups:{"*":{requireMention:false}, "G1":{requireMention:true}}`，`resolveGroupConfig("G1").requireMention===true`、`resolveGroupConfig("G2").requireMention===false`（通配）、`resolveGroupConfig("G3")` 无任何 group 时回落到 `defaultRequireMention`。
4. **defaultRequireMention 优先级**：`groups["*"]` 缺失时回落到 `defaultRequireMention`；`defaultRequireMention:false` + 无群配置 → `resolveRequireMention===false`。
5. **deliverDebounce 默认**：`QQBotConfigSchema.parse({})` → `deliverDebounce` undefined（fork 默认不开），显式 `{deliverDebounce:{enabled:true}}` → `windowMs===1500,maxWaitMs===8000`。
6. **audioFormatPolicy**：`transcodeEnabled` 默认 `true`；deprecated `voiceDirectUploadFormats` 与 `audioFormatPolicy.uploadDirectFormats` 共存时 resolve 优先 policy（与上游 `outbound.ts:1028` 行为一致）。
7. **urlDirectUpload 默认 true**；transport 默认 `"websocket"`，`webhook:{path:"/x"}` 透传。
8. **upgradeMode 默认 fork 是 `doc`**（安全模式，与上游 `hot-reload` 相反）—— 锁定此差异防回归。
9. **STT 两级回退**：`resolveSTTConfig` 在有 `stt.{baseUrl,apiKey}` 时返回；缺 stt 时回退 `tools.media.audio.models[0]`；都缺返回 null。键名读 `qqbot-china`。
10. **asr 优先于 stt**：同时配 `asr.{enabled:true,...}` 与 `stt`，`resolveQQBotASRCredentials` 返回 Tencent 凭证、`resolveSTTConfig` 仍可返回（并存，由调用方决定优先级）。
11. **mentionPatterns**：agent 级覆盖 global；agent 缺失回落 global；都缺返回 `[]`。
12. **ResolvedQQBotAccount 透传 config**：`resolveQQBotAccount` 结果含 `config.deliverDebounce`/`config.audioFormatPolicy` 原始对象，供 outbound 读。
13. **三处 JSON Schema 一致性**：单元测试断言 `index.ts` default-export configSchema、`qqbotPlugin.configSchema.schema`、`openclaw.plugin.json` configSchema 三者 properties 键集相同（若做重构 `buildAccountJsonSchema`）。
14. **manifest capabilities**：`openclaw.plugin.json` 含 `capabilities.proactiveMessaging===true`。
15. **现有 fork 字段回归**：`c2cMarkdownDeliveryMode/typingHeartbeatMode/displayAliases` 默认值与跨层 merge 不受新字段影响（跑现有 `config.test.ts` 全绿）。

### 风险与注意事项

- **最高风险：配置键不可动**。`channels["qqbot-china"]` 是 fork 的命脉，`resolveQQBotChannelConfig`/`withQQBotChannelConfig`/`mergeQQBotAccountConfig`/`listQQBotAccountIds`/`channel.ts` reload-security-onboarding-setup/`bot.ts`/`onboarding.ts` 全部依赖此键（见 `config.ts:6,199-225`）。port 上游 config.ts 时**禁止**把 `cfg.channels?.qqbot` 直接搬入，所有新 resolve 函数必须基于 fork 的 `mergeQQBotAccountConfig(cfg, accountId)` 返回值，否则会孤立全部现存用户配置。
- **三份手抄 JSON Schema 漂移**：`index.ts:34-147`、`channel.ts:134-249`、`openclaw.plugin.json:8-131` 三处独立维护，新增字段需三处同步，极易遗漏。强烈建议本子系统顺带抽取 `buildAccountJsonSchema()` 共享，从 Zod schema 生成 JSON Schema（`zod-to-json-schema`）或集中常量。
- **`channelConfigs.qqbot.preferOver:["qqbot"]` 自引用陷阱**：上游 `id` 是 `openclaw-qqbot`、preferOver `qqbot` 用以覆盖旧插件；fork `id` 本身就是 `qqbot`，照搬会导致插件覆盖自身。**fork 不应 port 此字段**，或需将 `id` 改名（破坏兼容，不建议）。
- **upgradeMode 默认值分歧**：上游默认 `hot-reload`（执行 `npm install` 热升级，`slash-commands.ts:1208`），fork 应默认 `doc`（仅展示文档链接），避免 China 环境意外触发 npm 升级脚本。port 时必须改默认值，并在 schema + resolve 双处锁定。
- **STT/ASR 双轨并存**：fork `asr.*`（Tencent，已用于 `bot.ts:841`）与上游 `stt.*`（OpenAI 兼容）形状不兼容，需在调用方约定优先级（推荐 asr 优先，stt 兜底），二者 schema 各自独立，不可合并字段。
- **`ResolvedQQBotAccount.config` 透传**：上游透传原始 `config` 供 outbound/gateway 直接读 `deliverDebounce` 等（上游 `outbound.ts:1028`、`gateway.ts:1437`）。fork 现无此字段，新增后需确保 fork 的 outbound/gateway 消费方（`outbound.ts`/`bot.ts`）改为从 `account.config` 读取，而非重新 resolve。
- **`chatTypes` 分歧**：fork 含 `"channel"`（频道），上游仅 `["direct","group"]`。若 port 上游 `groups` 适配器，注意 fork 的群/频道分流逻辑不要被上游「群专用」适配器误伤。
- **preload 引入是跨子系统决策**：`extensions:["./preload.cjs"]` 牵涉打包（tsup → preload.cjs require dist）+ symlink 脚本，本子系统只负责 manifest 字段，实现由打包子系统承担。
- **`peerDependencies`**：fork peer `moltbot`（`package.json:104`），上游 peer `openclaw`。不可丢 `moltbot`（fork 多宿主兼容）。

## 4.2 Transport & Connection (WebSocket vs Webhook, RESUME, reconnect)

### 现状对比

**Fork 现状（WebSocket-only，无 Webhook）**

- 连接逻辑全部在 `extensions/qqbot/src/monitor.ts`，`monitorQQBotProvider`（monitor.ts:137）直接 `new WebSocket(gatewayUrl)`（monitor.ts:344），无任何 transport 模式分支。`channel.ts` 的 `gateway.startAccount`（channel.ts:367-413）仅透传调用 `monitorQQBotProvider`，`gateway.stopAccount`（channel.ts:414-416）调用 `stopQQBotMonitorForAccount`。
- 意图固定为 `GUILD_MESSAGES(1<<30) | DIRECT_MESSAGE(1<<12) | GROUP_AND_C2C(1<<25)`（monitor.ts:35-42，`DEFAULT_INTENTS`），**无 INTERACTION(1<<26)**，Identify 载荷 monitor.ts:229-240。
- 会话状态仅存内存：`ActiveConnection.sessionId`/`lastSeq`（monitor.ts:64-65），op:10 Hello 时若有 session 则发 op:6 RESUME（monitor.ts:273-274），op:0 READY 落 sessionId（monitor.ts:303），但 `finish()`（monitor.ts:176-193）清空一切且 `activeConnections.delete`，故进程重启后必走全量 Identify。
- 重连退化为固定数组 `[1000,2000,5000,10000,20000,30000]`（monitor.ts:44 `RECONNECT_DELAYS_MS`），`scheduleReconnect`（monitor.ts:205-216）**无上限**、无 close-code 分支；`ws.on("close")`（monitor.ts:369-375）对所有 code 一律 `scheduleReconnect("socket closed")`。
- op 码处理：op:7（monitor.ts:284-289）→ cleanup+reconnect；op:9（monitor.ts:290-298）→ 清 sessionId/lastSeq + `clearTokenCache`（client.ts:119）+ reconnect；op:11（monitor.ts:280-283）→ `setStatus({lastEventAt})`；op:0 READY/RESUMED（monitor.ts:299-314）。
- Token 仅惰性获取：`client.ts` 的 `getAccessToken`（client.ts:130-172）按 appId 缓存 + singleflight（tokenCacheMap/tokenPromiseMap），过期前 5 分钟视为有效（client.ts:139），**无后台刷新循环**。
- 事件分发：`monitor.ts` 对 op:0 非 READY/RESUMED 事件统一调 `handleQQBotDispatch`（monitor.ts:316-323），而 `bot.ts` 的 `resolveInbound`（bot.ts:1170-1183）只认 4 种消息事件（C2C_MESSAGE_CREATE/GROUP_AT_MESSAGE_CREATE/AT_MESSAGE_CREATE/DIRECT_MESSAGE_CREATE），其余返回 `null`（INTERACTION_CREATE、GROUP_ADD/DEL_ROBOT、GROUP_MSG_REJECT/RECEIVE 全被静默丢弃）。
- 无 `User-Agent` 头（`new WebSocket(gatewayUrl)` 无 options，monitor.ts:344），无 `process.uncaughtException` 守卫，无环境诊断。
- 数据目录约定：ref-index-store.ts:34 用 `join(homedir(),".openclaw","qqbot","data","ref-index.jsonl")`，无统一 `getQQBotDataDir` helper。

**上游现状（v1.7.2，双 transport + 硬化 WS）**

- 统一入口 `gateway.ts` 的 `startGateway`（gateway.ts:415），按 `account.config.transport ?? "websocket"` 分支（gateway.ts:531）。
- WebSocket 路径（gateway.ts:1976-2246）新增：`new WebSocket(url, { headers: { "User-Agent": getPluginUserAgent() } })`（gateway.ts:1983）；close-code 分支处理 4004（刷 token，gateway.ts:2169-2176）/4008（等 60s，gateway.ts:2180-2186）/4006|4007|4009（清 session 重 identify，gateway.ts:2190-2201）/4900-4913（内部错误，gateway.ts:2202-2209）/4914|4915（下架/封禁，halt，gateway.ts:2161-2166）；`MAX_RECONNECT_ATTEMPTS=100`（gateway.ts:358，在 scheduleReconnect 校验 gateway.ts:727）；快速断开检测（`MAX_QUICK_DISCONNECT_COUNT=3`/`QUICK_DISCONNECT_THRESHOLD=5000`，gateway.ts:359-360，检测 gateway.ts:2213-2233）；`RECONNECT_DELAYS=[1,2,5,10,30,60]s`（gateway.ts:356）；op:9 读取 `canResume` 布尔并设置 `shouldRefreshToken`（gateway.ts:2126-2141）。
- 会话持久化：`session-store.ts`（loadSession/saveSession/clearSession/updateLastSeq，节流写 `SAVE_THROTTLE_MS=1000`，5 分钟过期 `SESSION_EXPIRE_TIME`，appId 不匹配即失效），`startGateway` 启动即 `loadSession(accountId, appId)`（gateway.ts:555-560）恢复，READY/RESUMED 时 `saveSession`（gateway.ts:2069/2009-2017/2098-2106），每条带 s 的事件触发 `saveSession` 更新 lastSeq（gateway.ts:2005-2018）。会话目录经 `getQQBotDataDir("sessions")`（session-store.ts:31，platform.ts:63）。
- 后台 Token 刷新：`api.ts` 的 `startBackgroundTokenRefresh`（api.ts:1189-1248）/`stopBackgroundTokenRefresh`（api.ts:1254-1267），默认过期前 5 分钟刷新（refreshAheadMs=5*60*1000，api.ts:1200），带随机抖动与最小间隔。WS 连接成功（gateway.ts:1993-1996）与 webhook 启动（gateway.ts:1943-1945）时各启动一次，结束时 `stopBackgroundTokenRefresh`（gateway.ts:1971）。
- `process.on("uncaughtException", wsUncaughtHandler)`（gateway.ts:423-435）捕获 WS 握手 403 等「Unexpected server response」错误防进程崩溃；`runDiagnostics()`（gateway.ts:438-443）+ plugin-runtime 模块解析预检（gateway.ts:449+）。
- Webhook 路径（完整并行 transport）：`transport/webhook-transport.ts` 的 `startWebhookTransport`（webhook-transport.ts:267）经 plugin-sdk `registerWebhookTargetWithPluginRoute` 注册 HTTP 路由（webhook-transport.ts:278-299），共享 rate limiter（`createFixedWindowRateLimiter` 60s/600，webhook-transport.ts:102-106）+ in-flight limiter（`createWebhookInFlightLimiter` 每键 8，webhook-transport.ts:109-113）；`transport/webhook-verify.ts` 实现 Ed25519 验签（`verifyWebhookSignature` webhook-verify.ts:70，`deriveSeed` 把 secret 补齐到 32 字节做 Ed25519 seed，webhook-verify.ts:20-26，PKCS8 DER 前缀构造私钥 webhook-verify.ts:34-42）；op:13 回调校验（`signValidationResponse` 签 `event_ts+plain_token`，webhook-verify.ts:104-119；handler `handleValidation` webhook-transport.ts:221-254）；op:12 立即 ACK 后异步 dispatch（webhook-transport.ts:192-212）；WS 与 webhook 共用 `dispatchInboundEvent`（gateway.ts:1894-1937）。
- 意图 `FULL_INTENTS = PUBLIC_GUILD_MESSAGES|DIRECT_MESSAGE|GROUP_AND_C2C|INTERACTION`（gateway.ts:352），含 `INTERACTION_CREATE` 分发（gateway.ts:1928-1935）。

### 差距清单（上游有、fork 缺）

1. **Webhook transport 整体缺失** — 无 `transport` 配置字段（config.ts 全文无 transport/webhook），无 `transport/` 目录，无 `account.config.webhook.path`，用户只能 WebSocket 接收事件。
2. **Ed25519 验签缺失** — 无 `X-Signature-Ed25519`/`X-Signature-Timestamp` 处理，无 `deriveSeed`/PKCS8 密钥派生（webhook-verify.ts:20-45）。
3. **op:13 回调 URL 校验缺失**（`handleValidation`+`signValidationResponse`，webhook-transport.ts:221 / webhook-verify.ts:104）。
4. **op:12 HTTP 回调 ACK 缺失**（webhook-transport.ts:194）。
5. **会话持久化到磁盘缺失**（session-store.ts 全部）— fork 仅内存，跨进程重启无法 RESUME，必走全量 Identify（漏事件、重连慢）。
6. **跨重启 RESUME 缺失** — 上游 `startGateway` 启动即 `loadSession`（gateway.ts:555）并在 5 分钟窗口内、appId 匹配时恢复。
7. **close-code 感知重连缺失** — fork 对所有 close 一视同仁（monitor.ts:369-375）；上游区分 4004/4006/4007/4008/4009/4900-4913/4914/4915（gateway.ts:2148-2241）。
8. **后台 Token 刷新缺失**（`startBackgroundTokenRefresh`/`stopBackgroundTokenRefresh`，api.ts:1189/1254）— fork 仅惰性 `getAccessToken`（client.ts:130），WS/send 可能撞过期 token。
9. **重连上限缺失** — fork `scheduleReconnect` 无 `MAX_RECONNECT_ATTEMPTS`（monitor.ts:205-216），上游上限 100（gateway.ts:358/727）。
10. **WS 握手 User-Agent 头缺失**（`getPluginUserAgent`，api.ts:72；用在 gateway.ts:1983）。
11. **`process.uncaughtException` 守卫缺失**（gateway.ts:423-435）— fork 在 WS 握手 403 等非致命错误下可能崩进程。
12. **快速断开检测缺失**（`MAX_QUICK_DISCONNECT_COUNT=3`/`QUICK_DISCONNECT_THRESHOLD=5000`，gateway.ts:2213-2233）。
13. **环境诊断 + runtime 模块解析预检缺失**（`runDiagnostics`，gateway.ts:438）。
14. **INTERACTION 意图(1<<26) 缺失**（fork monitor.ts:35-42 vs 上游 gateway.ts:348/352）。
15. **INTERACTION_CREATE 事件处理缺失** — fork `resolveInbound`（bot.ts:1170-1183）对它返回 null（静默丢弃），按钮/审批回调、config-query/update（type 2001/2002）不可用；上游 `handleInteractionCreate`/`dispatchInboundEvent`（gateway.ts:1928-1935）+ `acknowledgeInteraction` API（api.ts，gateway.ts 中引用）。
16. **非消息生命周期事件丢弃** — GROUP_ADD_ROBOT/GROUP_DEL_ROBOT/GROUP_MSG_REJECT/GROUP_MSG_RECEIVE 在 fork `resolveInbound` 走 default→null；上游 `dispatchInboundEvent`（gateway.ts:1915-1927）记录 known-user 并日志。

### 必须保留（China-fork 本子系统必须存活的功能）

1. **多账户连接 Map** — monitor.ts:78 `activeConnections = new Map<string, ActiveConnection>()`，按 accountId 管理；`stopQQBotMonitorForAccount`（monitor.ts:407）/`stopAllQQBotMonitors`（monitor.ts:423）/`isQQBotMonitorActiveForAccount`（monitor.ts:440）/`getActiveAccountIds`（monitor.ts:455）。上游是 per-`startGateway` 调用管理，**不可替换为上游的单实例模型**。channel.ts 的 `gateway.startAccount({accountId})`/`stopAccount({accountId})` 契约（channel.ts:367/414）必须保留。
2. **op:11 → `setStatus({lastEventAt})`** — monitor.ts:280-283 让 OpenClaw 健康检查感知连接存活；上游 op:11 仅 debug 日志（gateway.ts:2116-2118）。保留 fork 的 setStatus 钩子。
3. **重入保护** — `isConnectionIdle`/`getOrCreateConnection`/重复 start 复用现有 promise（monitor.ts:72-75/144-160）。上游无此语义。
4. **China-specific 发送路径** — `client.ts` 的 `sendC2CStreamMessage`（client.ts:531，`/v2/users/{openid}/stream_messages` 带 input_mode/input_state/content_raw/stream_msg_id）、`sendC2CInputNotify`（client.ts:402，msg_type=6 input_notify 取 ref_idx）、`postPassiveMessage` 的 msg_seq 去重重试（client.ts:68-117，`isDuplicateMsgSeqError` err_code 40054005）。上游 stream 仅为 C2C 且无 InputNotify refIdx 流程；**移植网关时不得覆盖这些**。
5. **按 appId 隔离的 token 缓存** — client.ts:14 `tokenCacheMap`/`tokenPromiseMap`，多账户并发安全；后台刷新 port 必须复用此 Map，不可引入新的全局状态。
6. **c2cMarkdownDeliveryMode / c2cMarkdownChunkStrategy / splitQQBotMarkdownTransportMediaUrls**（channel.ts:59-60、bot.ts）— China 专属 markdown 投递策略，上游无。
7. **ChannelPlugin 契约** — channel.ts 的 `qqbotPlugin`（configSchema/config/gateway/setup/onboarding 等，channel.ts:64-419）与上游 `qqbotPlugin` 形状不同；transport 配置必须接入 fork 的 `configSchema`/`mergeQQBotAccountConfig` 而非上游的 `account.config.transport` 扁平访问。

### 实施方案

按风险从低到高分两阶段。阶段一（低风险，纯 fork 内部）硬化 WS；阶段二（大，需扩 contract）加 Webhook。

**通用前置：新增 `src/platform.ts`（create）** — 内联上游 `utils/platform.ts` 的 `getQQBotDataDir`（platform.ts:63），路径 `join(homedir(),".openclaw","qqbot",...subPaths)`（fork 已用同约定，ref-index-store.ts:34）。消除 session-store 对上游 `./utils/platform.js` 的依赖。

**P0-1 移植 `src/session-store.ts`（create，几乎照搬上游 session-store.ts 全文）**
- 改 import：`import { getQQBotDataDir } from "./platform.js"`（替换上游 `./utils/platform.js`）。
- 保留 `SessionState` 接口（sessionId/lastSeq/lastConnectedAt/intentLevelIndex/accountId/savedAt/appId）、`SESSION_EXPIRE_TIME=5min`、`SAVE_THROTTLE_MS=1000` 节流、`loadSession(accountId, expectedAppId)` 的 appId 不匹配失效与过期删除逻辑、`saveSession`/`clearSession`/`updateLastSeq`/`getAllSessions`/`cleanupExpiredSessions`。
- 日志改用 fork 的 `createLogger("qqbot:session")`（替换裸 `console.log`，session-store.ts:84/110/188 等）。

**P0-2 改造 `src/monitor.ts`（modify）— 接入持久化 + close-code 分支 + 上限 + 快速断开 + UA + 守卫**
- 在 `ActiveConnection` 增加 `quickDisconnectCount`/`lastConnectAt`/`shouldRefreshToken`（monitor.ts:60-70）。
- `connect()` 开头（monitor.ts:332）：
  - 启动前 `loadSession(accountId, qqCfg.appId)` 恢复 `conn.sessionId`/`conn.lastSeq`（对应 gateway.ts:555-560）。
  - `shouldRefreshToken` 为真时 `clearTokenCache(appId)`（对应 gateway.ts:762-766）。
- `new WebSocket(gatewayUrl)`（monitor.ts:344）→ `new WebSocket(gatewayUrl, { headers: { "User-Agent": getPluginUserAgent() } })`；`getPluginUserAgent` 在 `client.ts` 新增（见 P0-4）。
- READY/RESUMED 时 `saveSession(...)`（monitor.ts:301-313）；每条带 s 的事件 `saveSession` 更新 lastSeq（monitor.ts:259-261）。
- `scheduleReconnect`（monitor.ts:205-216）增加 `MAX_RECONNECT_ATTEMPTS=100` 早退、`customDelay` 参数、删除已有 timer。
- `ws.on("close")`（monitor.ts:369-375）改写为 close-code 分支：4914/4915 halt 不重连；4004 设 `shouldRefreshToken`；4008 等 RATE_LIMIT_DELAY(60s)；4006/4007/4009 + 4900-4913 清 `conn.sessionId`/`lastSeq` + `clearSession(accountId)`；快速断开（<5s）计数达 3 则等 60s；非 1000 且未 abort 则重连。**注意保留 fork 的 `cleanupSocket(nextConn, ws)` 幂等语义**（monitor.ts:119-135），上游 `cleanup()`（gateway.ts:710）与之等价但无 socket 身份校验——保留 fork 版本以防 stale-socket。
- op:9（monitor.ts:290-298）：读取 `payload.d as boolean`（canResume），仅 `!canResume` 时清 session 并 `clearSession` + 设 `shouldRefreshToken`；改用 `scheduleReconnect(3000)`（对应 gateway.ts:2126-2141）。**保留 fork 现有的 `clearTokenCache` 调用是可接受的**（fork 急清、上游延迟清，二者皆安全；为减少行为差异可改为 `shouldRefreshToken=true`）。
- `monitorQQBotProvider`（monitor.ts:137）开头安装 `process.on("uncaughtException", handler)`，abort/finish 时移除（对应 gateway.ts:423-435）。

**P0-3 `src/client.ts`（modify）— 新增后台 token 刷新 + UA**
- 新增 `startBackgroundTokenRefresh(appId, clientSecret, opts?)`/`stopBackgroundTokenRefresh(appId?)`（照搬 api.ts:1189-1267），复用现有 `tokenCacheMap`（client.ts:14）做刷新时机判断，用 `AbortController` Map 管理。`refreshAheadMs` 默认 5min（与 client.ts:139 现有 margin 一致）。
- 新增 `getPluginUserAgent()`（照搬 api.ts:60-83），从 package.json 读版本，runtime 注入 openclaw 版本。
- monitor.ts：WS `open`（monitor.ts:351-353）后 `startBackgroundTokenRefresh`；`finish()`（monitor.ts:176-193）里 `stopBackgroundTokenRefresh(appId)`。

**P0-4 意图 + 事件（modify monitor.ts:35-42 + bot.ts:1170-1183）**
- `DEFAULT_INTENTS` 加 `INTERACTION: 1<<26`（对应 gateway.ts:348/352）。
- `resolveInbound` 增加 `INTERACTION_CREATE`/`GROUP_ADD_ROBOT`/`GROUP_DEL_ROBOT`/`GROUP_MSG_REJECT`/`GROUP_MSG_RECEIVE` 分支（可先只记录日志/known-user，交互按钮处理留作后续子系统）。最低限度：不让 `handleQQBotDispatch` 因 `resolveInbound===null` 静默吞掉生命周期事件——加显式日志分支。

**P1-1 Webhook transport（create `src/transport/`，需先扩 contract）— 高风险**
- **前置：扩 `index.ts` 的 `MoltbotPluginApi`（index.ts:11-15）** 增加 `registerHttpRoute?: (params: {path:string; auth?:"gateway"|"plugin"; match?:"exact"|"prefix"; handler:(req,res)=>Promise<boolean>|boolean}) => void;` 与 `registerHttpHandler?`（照 wechat-mp/src/types.ts:590-619）。在 `register(api)`（index.ts:149-157）把 `api` 传入 runtime 供 webhook 取用（参考 wechat-mp 用法）。
- **`src/transport/webhook-verify.ts`（create，几乎照搬上游全文）**：纯 `node:crypto`，零 SDK 依赖，可直接移植（`deriveSeed`/`getKeyPair`/`ed25519Sign`/`verifyWebhookSignature`/`signValidationResponse`）。
- **`src/transport/webhook-transport.ts`（create，重写而非照搬）**：上游依赖 plugin-sdk 的 `withResolvedWebhookRequestPipeline`/`resolveWebhookTargetWithAuthOrRejectSync`/`createFixedWindowRateLimiter`/`createWebhookInFlightLimiter`/`readWebhookBodyOrReject`（webhook-transport.ts:28-37）+ `registerWebhookTargetWithPluginRoute`（webhook-transport.ts:278）。**fork 的 shared 包无这些**（已确认 shared/src 下无 webhook/ed25519/route registry）。故需：
  - 用 fork 的 `registerHttpRoute`（来自 MoltbotPluginApi）注册单路径 handler（仿 wechat-mp/src/webhook.ts:278-291 `registerWechatMpWebhookTarget` 的 per-path target map 模式）。
  - 自实现轻量 rate limiter（fixed-window per IP）与 in-flight guard（per IP 计数），或先用最小版（读 body、验签、ACK），限流留 P2。
  - handler 内：op:13→`signValidationResponse`（webhook-verify.ts）；op:0→验签（`verifyWebhookSignature` 用 raw body+timestamp）→立即回 op:12 ACK（`{op:12,d:0}`）→异步 `onEvent`。
- **接入 monitor.ts：** `monitorQQBotProvider`（monitor.ts:137）在 `qqCfg.transport === "webhook"` 时不建 WS，改为 `await startWebhookTransport({account, abortSignal, onEvent:(e)=>handleGatewayPayload-like(e), ...})`，复用现有 `handleQQBotDispatch`（monitor.ts:316）。需把 `handleGatewayPayload` 的 op:0 分支抽成可被 webhook 复用的 `dispatchDispatchEvent(eventType, data)`。
- **配置：** `config.ts`/`configSchema`（channel.ts:134-249）新增 `transport: {enum:["websocket","webhook"]}` 与 `webhook: { type:"object", properties:{ path:{type:"string"} } }`（顶层 + accounts 内各一份）。`mergeQQBotAccountConfig` 透传。`ResolvedQQBotAccount`（types.ts）增 `transport`/`webhookPath`。

### 测试计划

1. **session-store.test.ts（create）** — `saveSession` 后 `loadSession` 回环；`savedAt` 超 5min 返回 null 并删文件；appId 不匹配返回 null 并删文件；`sessionId`/`lastSeq` 缺失返回 null；节流：1s 内多次 save 只落盘最新（mock fs + 计时）；`clearSession` 删除并清 throttle timer；`cleanupExpiredSessions` 清理过期文件。
2. **monitor.test.ts（extend）** —
   - `loadSession` 命中时首条 op:10 发 op:6 RESUME（而非 op:2 Identify）；`loadSession` 返回 null 时发 op:2。
   - close 4004 后下次 connect 先 `clearTokenCache`（mock client.clearTokenCache）；close 4008 后等 ~60s 才 scheduleReconnect（用 fake timers）；close 4006/4007/4009 后 `conn.sessionId` 清空且 `clearSession` 被调；close 4914/4915 后**不**scheduleReconnect；close 4900-4913 清 session。
   - 连续 3 次 <5s 断开后 scheduleReconnect 用 RATE_LIMIT_DELAY；连续正常连接后 quickDisconnectCount 归零。
   - `scheduleReconnect` 在 `reconnectAttempt` 达 100 后停止（断言不再 setTimeout）。
   - READY 后 `saveSession` 被调且 `appId` 字段正确；op:9 `canResume=false` 时 `clearSession` 被调、`canResume=true` 时不清。
   - WS connect 携带 `User-Agent` 头（拦截 `new WebSocket` 调用断言 options.headers）。
   - `startBackgroundTokenRefresh` 在 WS open 后启动、finish/abort 后停止（mock startBackgroundTokenRefresh）。
   - abort 期间 `process.uncaughtException` handler 已 removeEventListener（用 spy）。
   - op:11 仍触发 `setStatus({lastEventAt})`（回归，保留 fork 行为）。
3. **client.test.ts（extend）** — `startBackgroundTokenRefresh` 在 token 距过期 <5min 时触发 `getAccessToken`（mock tokenCacheMap.expiresAt）；abort controller 取消后循环退出；并发同名 appId 只启一个 controller。
4. **webhook-verify.test.ts（create）** — `verifyWebhookSignature`：用已知 secret+body+timestamp 生成签名后验通过；篡改 body 验失败；篡改 timestamp 验失败；签名 hex 长度异常不抛异常返回 false。`signValidationResponse`：签名 `event_ts+plain_token`，可用同 secret 的 `verifyWebhookSignature` 思路交叉验证（用 ed25519Sign 签再验）。`deriveSeed`：<32 字符 secret 被重复补齐到 >=32 再截断。
5. **webhook-transport.test.ts（create，inject mock registerHttpRoute）** — 注册后对 handler 发 op:13 返回 200+`{plain_token,signature}`；发 op:0 带正确签名返回 200+`{op:12,d:0}` 且 `onEvent` 被异步调用；缺签名头返回 401；签名错误返回 401；body 非 JSON 返回 400；abortSignal abort 后 unregister 被调。
6. **channel.test.ts（extend）** — `configSchema` 接受 `transport:"webhook"`+`webhook.path`；`gateway.startAccount` 在 `transport:"webhook"` 时**不**创建 WebSocket（mock startWebhookTransport）。

### 风险与注意事项

- **Webhook 是最大风险块**：上游 webhook-transport.ts 强依赖 plugin-sdk webhook-ingress（webhook-transport.ts:28-37），fork 的 `@openclaw-china/shared` **完全没有**该模块（已 grep 确认）。必须基于 fork 既有的 `MoltbotPluginApi.registerHttpRoute`（wechat-mp/src/types.ts:615 的先例）重写，rate limiter/in-flight guard 需自实现或先做最小版。**建议 P1 阶段先落地 verify（纯 crypto、零依赖）+ 最小 handler，限流留 P2**。
- **上游 `account.config.transport` 扁平访问**（gateway.ts:531）与 fork 的 `ResolvedQQBotAccount`（types.ts，无 config 子对象）+ `mergeQQBotAccountConfig`（config.ts）形状不同；必须经 fork 的 config 合并层暴露 transport，不可直接抄 `account.config.webhook?.path`。
- **session-store 节流写入** 在高频 lastSeq 更新下可能堆积 pendingTimer；finish/abort 路径需保证 `clearSession` 或显式清 throttle timer，否则进程退出前有悬挂 timer（上游 `clearSession` 已清，session-store.ts:202-207，port 时保留）。
- **`process.uncaughtException` 是进程级全局监听**（gateway.ts:432）；多账户并发时每个 `startAccount` 都装一个 handler，必须严格在 finish/abort 时 `removeListener`，否则泄漏。fork 多账户模型下尤其要保证 handler 与 accountId 绑定。
- **close-code 分支改写** 必须保留 fork 的 `cleanupSocket(nextConn, ws)` socket 身份校验（monitor.ts:119-135）——上游 `cleanup()`（gateway.ts:710）不校验具体 socket 实例，fork 在 stale-socket 场景（重连后旧 socket 延迟 close）依赖该校验避免误清新连接。
- **op:9 语义差异**：fork 当前急清 token cache（monitor.ts:293），上游延迟到下次 connect（`shouldRefreshToken`，gateway.ts:2135）。统一为上游语义以减少抖动，但需测试确认不引入回退。
- **后台 token 刷新复用 fork 现有 `tokenCacheMap`**（client.ts:14）；不可新引入上游 api.ts 的 `tokenCacheMap`（api.ts:134）造成双份缓存。
- **INTERACTION 意图新增** 后，未配置/未审批交互权限的机器人 Identify 可能被 QQ 拒绝；需确认 QQ 平台对未授权 intent 的处理（上游「始终全量、不降级」gateway.ts:351-352 是其设计选择，fork 跟随时需验证）。

## 4.3 Slash Command System & Operational Tooling (/bot-*)

### 现状对比

#### Fork 现状（`@openclaw-china/qqbot` v2026.3.9-1）

- **完全不存在 `/bot-*` 指令子系统。** 对 `src/` 全量 grep `bot-ping|bot-version|bot-help|bot-upgrade|bot-logs|bot-approve|bot-clear-storage|bot-group-allways` 零命中；`src/` 中没有 `slash-commands.ts`、`update-checker.ts`、`startup-greeting.ts`、`credential-backup.ts`、`admin-resolver.ts`、`approval-handler.ts` 文件（见 `ls src/`）。
- **以 `/` 开头的消息直接透传给 OpenClaw 框架，不做插件级拦截。** `bot.ts:3237-3243` 仅判断 `isSlashCommand`（`CommandBody`/`RawBody` 以 `/` 开头）用于决定是否注入 quote 上下文（slash 消息不注入引用 body），但**不拦截、不直接回复**，仍走正常 dispatch → agent 流程。
- **Fork 拥有的是私聊 stop/abort 机制（必须保留）：**
  - `QQBOT_ABORT_TRIGGERS`（`bot.ts:114-157`）：含 40+ 多语言停止词（`停止`/`やめて`/`止めて`/`रुको`/`توقف`/`стоп`/`остановись`/`halt`/`anhalten` 等）。
  - `isQQBotAbortTrigger()`（`bot.ts:421`）+ `isQQBotFastAbortCommandText()`（`bot.ts:428-444`，识别 `/stop`、本地化停止词及标点变体）。
  - 拦截点 `handleQQBotDispatch()`（`bot.ts:3863`）→ `bot.ts:3962-3983`：命中后调用 `markSessionAbort(queueKey)` + `dropQueuedSessionDispatches(queueKey)`（丢弃该 queue-key 的排队消息），并 `runImmediateSessionDispatch` 立即执行；`dispatchToAgent()`（`bot.ts:2984`）以 `abortGeneration` 做 stale-reply 抑制（`bot.ts:2986-2990`）。语义**按 session/queue key 隔离**，不是上游的 per-peer。
  - 测试覆盖：`bot.stop-command.test.ts:82-96`（本地化识别）+ `:98+`（队列丢弃）。
- **无 `bin/` 目录、`package.json` 无 `bin` 字段**（grep 确认），无独立 CLI。
- **配置模型差异（关键）：** Fork 配置是**扁平 account 级**：`QQBotAccountSchema`（`config.ts:60` `streaming`、`:83` `requireMention`、`:93-98` `inboundMedia{dir,keepDays}`），**没有** `defaultRequireMention`、没有 `groups.{groupId}.requireMention` 优先级链、没有 `tools.exec.security/ask`。`packages/shared/src/policy/group-policy.ts:28/55/85` 把 `requireMention` 当运行时布尔入参使用，不是配置键。
- **Runtime API 差异（关键）：** Fork 的 `PluginRuntime`（`runtime.ts:9-117`）只暴露 `channel.{routing,session,reply,text}` 与 `system.enqueueSystemEvent`，**没有** `config.loadConfig()/writeConfigFile()`。上游所有 config-mutation 指令（bot-streaming/bot-approve/bot-group-allways）依赖的 `runtime.config`（slash-commands.ts:1970-1972、2116-2118、2335-2337）在 fork 中**根本不存在**。
- **媒体目录差异：** Fork `resolveInboundMediaDir()`（`config.ts:132`）默认 `~/.openclaw/media/qqbot/inbound`（扁平、account 级），上游 `bot-clear-storage`（slash-commands.ts:1799）扫描 `~/.openclaw/media/qqbot/downloads/{appId}/`（per-appId 子目录）。
- **发送原语：** Fork 用 `qqbotOutbound.sendText({cfg,to,text,replyToId,replyEventId,accountId})`（`outbound.ts:286-298`）+ `sendMedia`/`sendTyping`，按 `to` 字符串前缀（`group:`/`user:`/频道）路由；上游直接调用 `sendC2CMessage/sendGroupMessage/sendChannelMessage`（gateway.ts:657-664）按 `msg.type` 分支。

#### 上游现状（`@tencent-connect/openclaw-qqbot` v1.7.2）

- **`src/slash-commands.ts`（88KB，~2432 行）：** SlashCommand registry（`commands: Map`，slash-commands.ts:255，`registerCommand()` :257）注册 **9 个指令**：`bot-ping`(:267)、`bot-version`(:299)、`bot-help`(:330)、`bot-upgrade`(:1189)、`bot-logs`(:1637)、`bot-clear-storage`(:1775)、`bot-streaming`(:1925)、`bot-approve`(:2039)、`bot-group-allways`(:2288)。`matchSlashCommand()`（:2403-2426）解析 `/cmdname args`，支持 `?` 查用法，命中返回 `string|SlashCommandFileResult|SlashCommandDelegateResult|null`（类型 :226-239）。
- **预队列拦截：** gateway.ts:582-690 `trySlashCommandOrEnqueue()`：以 `/` 开头先判 `URGENT_COMMANDS=["/stop","/approve"]`（:586）走 `clearUserQueue(peerId)`+`executeImmediate`（:598-606），否则构造 `SlashCommandContext`（:612-627）调 `matchSlashCommand`（:630）；`null`→入队（:633），`delegatePrompt`→替换 `msg.content` 入队（:642），否则**直接调用 `sendC2CMessage/sendGroupMessage/sendChannelMessage` 回复**（:657-664）并可选发文件（:668-684）。
- **`update-checker.ts`（187 行）：** `triggerUpdateCheck()`(:97) 启动预热，`getUpdateInfo()`(:112) 实时查 npm registry，多源 fallback `npmjs.org→npmmirror.com`（:20-23），`buildUpdateInfo()`(:74) prerelease-aware（alpha 只跟 alpha 比），`checkVersionExists()`(:128)。**`PKG_NAME` 硬编码 `@tencent-connect/openclaw-qqbot`**（:17），`CURRENT_VERSION = getPackageVersion()`(:25)。
- **`startup-greeting.ts`（121 行）：** per-`accountId+appId` marker（`startup-marker-{accountId}-{appId}.json`，:17-19）+ legacy 全局 marker 迁移（:22,50-57）；`getStartupGreetingPlan()`(:79) 首启「灵魂已上线」/升级「已更新至 vX」/同版本不发/10min 失败冷却（:10,87-92）。
- **`credential-backup.ts`（73 行）：** `saveCredentialBackup()`(:37) 原子写（.tmp→rename，:47-49）appId/clientSecret 到 `~/.openclaw/qqbot/data/credential-backup.json`；`loadCredentialBackup()`(:59) 仅在 appId/secret 为空时恢复。**已在上游 channel.ts:15 导入**（在 `setup.applyAccountConfig`/`gateway.startAccount` 成功后 save，启动时 load）。
- **`bin/qqbot-cli.js`（244 行）：** `npx openclaw-qqbot upgrade|install`，`PLUGIN_IDS`(:39) 多旧 ID 清理（`qqbot/openclaw-qq/@sliverp/qqbot/...`），读旧 `channels.qqbot` 配置→删扩展目录→`plugins install openclaw-qqbot`→`channels add --token` 重配。
- **`approval-handler.ts`（18KB）：** `isApprovalFeatureAvailable()`(:480) 依赖 `loadGatewayRuntime()`(:25-71) 动态 `createRequire` 查找 `dist/plugin-sdk/gateway-runtime.js`（需 openclaw >= 3.22）。bot-approve(:2058) 不可用时**降级为 delegatePrompt** 委托 AI 跑 `openclaw config set tools.exec.security/ask`（:2067-2104）。
- **启动问候投递：** gateway.ts:36 导入 `sendStartupGreetings`（来自 `admin-resolver.ts`），:1961/:2086/:2094 在 READY/RESUMED 时机发送。
- **热更新（bot-upgrade，:1189-1635）：** `fireHotUpgrade()`(:757)、`findCli()`(:381, openclaw/clawdbot/moltbot 发现)、`getUpgradeScriptPath()`(:489)、`switchPluginSourceToNpm()`(:563)、`checkUpgradeCompatibility()`(:131, 最低框架 `2026.3.2`/仅 darwin+linux/:80/Node>=18)、远端+本地脚本下载、detached PowerShell/bash 重启脚本（:992/:1162）、`OPENCLAW_CONFIG_PATH` 临时配置副本（:812-848）。
- **富 UI 标签：** `<qqbot-cmd-input text="..." show="..."/>` / `<qqbot-cmd-enter>`，由 bot-help/bot-upgrade/bot-streaming/bot-approve/bot-group-allways 输出。

### 差距清单（上游有、Fork 缺）

1. **整个 SlashCommand registry + `matchSlashCommand()` + 预队列拦截点**：9 个 `/bot-*` 指令全部缺失；`SlashCommandContext`/`SlashCommandResult`/`SlashCommandFileResult`/`SlashCommandDelegateResult` 类型（slash-commands.ts:182-239）缺失。
2. **`/bot-approve` 运行时集成**：fork 无 `approval-handler.ts`、无 `isApprovalFeatureAvailable()`、无 `gateway-runtime` 动态加载器、无 `tools.exec.security/ask` 配置键——整个审批体系不存在。
3. **`update-checker.ts`**：fork 无 npm dist-tag 轮询、无 npmmirror.com 国内镜像 fallback、无 prerelease-aware 比较、无 `checkVersionExists()`。
4. **`startup-greeting.ts`**：fork 无 per-bot marker、无首启/升级问候、无 10min 失败冷却、无 legacy marker 迁移。
5. **`credential-backup.ts`**：fork 无原子 appId/secret 快照恢复机制。
6. **`bin/qqbot-cli.js`**：fork 无独立 `upgrade|install` CLI、无多 legacy plugin-ID 清理。
7. **`/bot-upgrade` 热更机械**：`fireHotUpgrade()`/`findCli()`/`getUpgradeScriptPath()`/`switchPluginSourceToNpm()`/`checkUpgradeCompatibility()`/detached 重启脚本/`OPENCLAW_CONFIG_PATH` 临时配置——全部缺失。
8. **config-mutation 运行时 API**：fork `PluginRuntime` 无 `config.loadConfig()/writeConfigFile()`（runtime.ts:9-117），bot-streaming/bot-approve/bot-group-allways 的 `runtime.config` 调用（slash-commands.ts:1970/2116/2335）无对应接口。
9. **`defaultRequireMention` + `groups.{groupId}.requireMention` 优先级链**：fork 只有扁平 `requireMention`（config.ts:83），bot-group-allways 上游语义（命名账户 `accounts.{id}.defaultRequireMention`，slash-commands.ts:2348-2356）无对应配置位。
10. **富 UI 标签** `<qqbot-cmd-input>`/`<qqbot-cmd-enter>`：fork markdown/transport 层不识别，会以原文显示。

### 必须保留（China-Fork 特性，移植中不得丢失）

1. **多语言本地化 abort 系统**：`QQBOT_ABORT_TRIGGERS`（bot.ts:114-157，40+ 词含 `停止/やめて/止めて/रुको/توقف/стоп/...`）与 `isQQBotFastAbortCommandText()`（bot.ts:428-444）。上游仅有 `/stop`、`/approve` 两个英文 urgent command，**无本地化词匹配**。
2. **per-queue-key 隔离的 abort 队列语义**：`markSessionDispatchAbort`+`dropQueuedSessionDispatches`+`abortGeneration` stale-reply 抑制（bot.ts:2984-2990/3962-3983），日志 `session fast-abort command dropped N queued messages`（bot.ts:3970）。上游用 `msgQueue.clearUserQueue(peerId)`（per-peer，gateway.ts:601）——**粒度不同**，不得用上游路径替换 fork 路径。
3. **`isSlashCommand` 不注入 quote body 的行为**（bot.ts:3237-3252）：fork 对 `/` 消息跳过 `buildQuotedAgentBody`，移植 matchSlashCommand 后该分支语义仍需保持（被 matchSlashCommand 直接回复的消息根本不进 dispatch，天然兼容；但未被插件识别的 `/` 消息仍走 dispatch，需保持不注入引用）。
4. **fork 的运行时环境（与指令共存于同一文件、但非指令流水线）**：streaming.ts（c2c markdown 分块、typing heartbeat）、displayAliases、known-targets、onboarding.ts 中国 onboarding 向导——不得在移植指令时被覆盖。
5. **媒体目录约定**：fork 用 `resolveInboundMediaDir()`（config.ts:132，默认 `~/.openclaw/media/qqbot/inbound`）+ `inboundMedia.keepDays`，bot-clear-storage 必须基于 fork 的目录与 keepDays，而非上游 `downloads/{appId}`。
6. **配置包名/版本来源**：`PKG_NAME` 必须是 `@openclaw-china/qqbot`、`getPackageVersion()` 必须匹配 fork 的 package.json `name`，否则版本检查查错包。

### 实施方案

采用**分阶段移植**（Phase 1 只读/无状态 → Phase 2 配置变更 → Phase 3 进程级热更），严格遵循 port-not-rebase：上游自包含模块需适配 fork 的 contracts（`qqbotOutbound.sendText` 发送原语、`PluginRuntime`、`handleQQBotDispatch` 分发路径、`config.ts` 扁平 schema、`packages/shared`）。

#### 共享依赖（先建）
- `src/utils/pkg-version.ts`（**create**）：从上游移植 `getPackageVersion()`，但**改包名匹配条件**为 `@openclaw-china/qqbot`（上游 utils/pkg-version.ts:31 硬编码 `@tencent-connect/openclaw-qqbot`）。fork 无 `utils/` 目录，需新建。
- `src/utils/platform.ts`（**create**）：移植 `getHomeDir()/getQQBotDataDir()/getQQBotMediaDir()`（上游同名），fork 已有 `homedir()` 直接拼接（config.ts:111），统一走 platform.ts 以复用于 credential-backup/startup-greeting。ffmpeg/silk-wasm 诊断可选移植。

#### Phase 1 — 只读/无状态指令（低风险）
- `src/update-checker.ts`（**create**）：移植上游整文件，**唯一改动** `PKG_NAME="@openclaw-china/qqbot"`（上游 :17）、`getPackageVersion` 指向 fork utils。npmmirror.com fallback 对国内网络正好需要，原样保留。
- `src/slash-commands.ts`（**create，拆分**）：上游 88KB 单文件过大，建议拆为 `src/slash-commands/` 目录（`registry.ts` 类型+registerCommand+matchSlashCommand、`commands/ping.ts`、`version.ts`、`help.ts`、`logs.ts`、`clear-storage.ts`），但为降低风险首版可整体移植后逐个裁剪。**Phase 1 仅启用**：bot-ping（:267，无依赖）、bot-version（:299，依赖 update-checker）、bot-help（:330）、bot-logs（:1637，本地 fs 只读）、bot-clear-storage（:1775，**改 `targetDir` 为 `resolveInboundMediaDir(qqCfg)`** 而非 `downloads/{appId}`）。
- **拦截点接入（关键改造）**：在 `handleQQBotDispatch()`（bot.ts:3863）**顶部、现有 abort 判断（bot.ts:3962）之前**插入 matchSlashCommand 预拦截：
  - 先判 `isQQBotFastAbortCommandText(content)`（保留 fork 路径，不进 matchSlashCommand）；
  - 否则若 `content.startsWith("/")`，构造 `SlashCommandContext` 并调 `matchSlashCommand()`；
  - `null` → 继续原 dispatch（保持 bot.ts:3237 quote 不注入逻辑）；`delegatePrompt` → 替换 `inbound.content` 后走 dispatch；`string`/`file` → 调 `qqbotOutbound.sendText({cfg:buildQQBotScopedConfig(qqCfg), to:resolveChatTargetTo, text, replyToId:inbound.messageId, accountId})` 直接回复（**用 fork 发送原语，不用上游 sendC2CMessage 分支**），file 结果额外调 `qqbotOutbound.sendMedia`。
- **SlashCommandContext 适配**：fork 的 inbound 已含 `c2cOpenid`/`groupOpenid`/`channelId`/`content`/`messageId`/`eventTimestamp`/`type`，可直接映射；`accountConfig` 用 `mergeQQBotAccountConfig(cfg,accountId)`；`queueSnapshot` 用 fork 的 `getSessionDispatchState(queueKey)` 构造（`totalPending`/`activeUsers` 等字段对齐）。
- **富 UI 标签处理**：Phase 1 在 outbound/markdown 层加透传过滤——若 fork 不渲染 `<qqbot-cmd-input>`，需在 `outbound.ts` 文本清理处剥离标签（避免原文泄漏）；或保留标签由 QQ 客户端忽略。建议先剥离，后续按需实现渲染。

#### Phase 2 — 配置变更指令（中风险，需扩展 runtime）
- **前置：扩展 `PluginRuntime`**（runtime.ts）增加可选 `config?: { loadConfig: ()=>Record<string,unknown>; writeConfigFile:(cfg)=>Promise<void> }`。fork 的 `channel.ts` 已通过 `setQQBotRuntime(ctx.runtime...)`（channel.ts:398）注入 runtime；需确认 host（openclaw-china）注入的 runtime 是否带 `config` 字段，若无则需在 host 侧补——这是**跨仓依赖点**，需在 host PR 中确认。
- **bot-streaming**：上游写 `channels.qqbot.accounts.{id}.streaming`/`qqbot.streaming`（slash-commands.ts:1985-1995），fork `streaming` 字段名一致（config.ts:60），路径匹配，移植后基本可用（前提：runtime.config 就绪）。失败降级的 delegatePrompt 提示用户手动 `config set`（:2014+）可保留。
- **bot-group-allways**：上游写 `defaultRequireMention`（:2348-2356），fork **无此键**。两个选项：(a) fork schema 增加 `defaultRequireMention` 别名映射到 `requireMention`；(b) 改指令写 fork 的 `requireMention`。**推荐 (b)**：把上游 `defaultRequireMention` 改写为 fork 的 `requireMention`（语义相反需取反：上游 on=requireMention:false，:2325），并裁掉上游 `groups.*.requireMention` 优先级链说明（fork 不支持，文案改为「仅 @ 时回复/自主发言」单层）。
- **bot-approve**：需先移植 `approval-handler.ts`（动态 gateway-runtime 加载器）+ 确认 openclaw-china host 提供 `gateway-runtime.js`。不可用时保留 delegatePrompt 降级路径（委托 AI 跑 `openclaw config set tools.exec.security/ask`）。

#### Phase 3 — 进程级热更（最高风险，建议延后）
- `src/credential-backup.ts`（**create**）：整文件移植（73 行，无外部依赖冲突），接入点参照上游：在 `channel.ts` `gateway.startAccount` 成功后 `saveCredentialBackup(accountId,appId,clientSecret)`、启动 `setup.applyAccountConfig` 时 `loadCredentialBackup()` 恢复空凭证。
- `src/startup-greeting.ts`（**create**）：整文件移植；投递路径**不能用**上游 `admin-resolver.sendStartupGreetings`（fork 无 admin-resolver），改为在 `gateway.startAccount` 内调 `getStartupGreetingPlan()`，命中则用 `qqbotOutbound.sendText` 向私聊发送。
- **bot-upgrade + bin/qqbot-cli.js**：`fireHotUpgrade()` 的 `findCli()` 默认查 `openclaw/clawdbot/moltbot`，需补 `moltbot`/openclaw-china 实际 CLI 名；`checkUpgradeCompatibility()` 最低框架版本（:78 `2026.3.2`）与平台白名单（:80 仅 darwin/linux，**Windows 被排除**）需按 fork 部署目标复核；`OPENCLAW_CONFIG_PATH` 临时配置副本逻辑（:812-848）需验证 fork host 的配置加载行为。CLI 的 `PLUGIN_IDS` 清理列表（:39）需追加 fork 历史包名（如 `@openclaw-china/qqbot`）。
- **`/bot-approve` 的 urgent 挂载**：仅在 Phase 2 审批体系落地后，才把 `/approve` 加入 fast-path（fork 当前 abort fast-path 只含本地化停止词，见「必须保留」#2）；Phase 1 不引入 `/approve` urgent。

### 测试计划

1. **`isQQBotFastAbortCommandText` 回归**（已有 bot.stop-command.test.ts:82-96）：移植 matchSlashCommand 后重跑，确认 `/stop`、`停止`、`Stop!`、`interrupt。` 仍触发 fork abort 路径（不进 matchSlashCommand），`/verbose on`/`/new`/`/bot-ping` 不被 abort。
2. **abort 与 slash 共存**：队列中已有排队任务时发 `/停止` → 丢弃该 queue-key 排队消息（stale-reply 抑制生效）；发 `/bot-ping` → 走 matchSlashCommand 直接回复、不影响排队任务。
3. **matchSlashCommand 优先级**：发 `/bot-version` → 直接回复版本+更新检查（不进 dispatch）；发 `/unknown` → 进 dispatch 走 agent（保持 bot.ts:3237 不注入 quote）。
4. **`delegatePrompt`**：mock 一个返回 delegate 的指令 → 确认 `inbound.content` 被替换后进 dispatch，agent 收到的是 prompt 而非原始 `/cmd`。
5. **`<qqbot-cmd-input>` 标签**：发 `/bot-help` → 确认回复中标签被剥离或正确渲染，不以 `<qqbot-cmd-input .../>` 原文显示。
6. **update-checker PKG_NAME**：mock npm registry，确认查询的是 `@openclaw-china/qqbot`（非 `@tencent-connect/...`）；npmmirror fallback 在 npmjs.org 超时时生效。
7. **bot-clear-storage 路径**：mock fs，确认扫描 `resolveInboundMediaDir()`（fork 目录）而非上游 `downloads/{appId}`；`--force` 删除前后文件数正确；非 `--force` 仅列出。
8. **bot-streaming 配置写入**（Phase 2）：mock `runtime.config.loadConfig/writeConfigFile`，确认写 `channels.qqbot.streaming`（默认账户）/ `accounts.{id}.streaming`（命名账户）；状态未变时短路返回。
9. **bot-group-allways 取反映射**：`on` → `requireMention=false`、`off` → `requireMention=true`（与 fork 扁平字段对齐），确认写入 `channels.qqbot.requireMention`。
10. **startup-greeting 冷却**：marker 同版本时不发；marker lastFailureVersion 命中且 <10min 时不重试；首启发「灵魂已上线」、版本变更发「已更新至 vX」。
11. **credential-backup 原子写**：模拟写中途异常，确认 `.tmp` 不残留、不损坏原文件；appId/secret 为空时不恢复。
12. **urgant command 边界**：确认 Phase 1 不把 `/approve` 加入 fork abort fast-path；只有本地化停止词进 abort。

### 风险与注意事项

1. **最大冲突区：`handleQQBotDispatch` 接入点。** matchSlashCommand 必须插在 fork abort（bot.ts:3962）之前，且 fork abort 用本地化词集（per-queue-key）而上游 urgent 用英文 per-peer——**不得用上游 `clearUserQueue(peerId)` 替换** `markSessionDispatchAbort/dropQueuedSessionDispatches`，否则丢失 stale-reply 抑制与多语言支持。
2. **`runtime.config` 跨仓依赖（Phase 2 阻塞点）。** fork `PluginRuntime` 无 config 字段；若 openclaw-china host 注入的 runtime 也不带，bot-streaming/bot-approve/bot-group-allways 的写入路径全部失效（只能走 delegatePrompt 降级）。需先在 host PR 确认 `config.loadConfig/writeConfigFile` 可用，否则 Phase 2 必须降级为「仅 delegatePrompt」实现。
3. **`bot-upgrade` 热更假设单 `openclaw`/`clawdbot`/`moltbot` 安装布局 + 写 `~/.openclaw/` 路径**（findCli :381、switchPluginSourceToNpm :563）。fork 的实际安装布局（openclaw-china）需实测；`checkUpgradeCompatibility` 白名单排除 Windows（:80），若 fork 有 Windows 用户需放宽。
4. **`update-checker`/`startup-greeting` 包名与版本源**：`PKG_NAME`、`getPackageVersion` 的包名匹配、startup-greeting `getPluginVersion()`（依赖 slash-commands.ts:2429）必须全部指向 `@openclaw-china/qqbot`，否则查错 npm 包 / marker 版本永不匹配 / 问候反复触发。
5. **`<qqbot-cmd-input>` 富标签渲染**：fork markdown 传输层（c2cMarkdownDeliveryMode/chunkStrategy，config.ts:71-73）若不识别标签会原文显示。Phase 1 应在 outbound 文本清理处剥离，避免指令帮助文案出现裸标签。
6. **`approval-handler` 动态加载 `gateway-runtime.js`**（approval-handler.ts:33）：需 openclaw-china 提供 `dist/plugin-sdk/gateway-runtime.js` 且 >=3.22；若 host 不提供，bot-approve 永远走 delegatePrompt 降级——可接受但需在文档标注。
7. **CLI `PLUGIN_IDS` 清理列表**（qqbot-cli.js:39）：fork 历史可能用过不同包名（`@openclaw-china/qqbot`），清理列表遗漏会导致旧扩展目录/配置残留、升级后双实例。

## 4.4 Command-Execution Approval (inline keyboard) & Message Gating

### 现状对比

**Fork 现状（@openclaw-china/qqbot 2026.3.9-1）— 完全没有审批子系统：**

- 入站信封在 `buildInboundContext` 中将 `CommandAuthorized: true` 硬编码（`src/bot.ts:2966`），即每条消息都被视为已授权，不存在 per-sender 命令授权概念。类型定义见 `src/types.ts:86`（`CommandAuthorized: boolean`）。
- 消息门控由两个独立函数完成，全部内联在 `src/bot.ts`：
  - `shouldHandleMessage`（`src/bot.ts:3829-3861`）：对 `direct` 调 `checkDmPolicy`，对 `group`/`channel` 调 `checkGroupPolicy`，返回布尔。这两个纯函数来自 shared 包 `packages/shared/src/policy/dm-policy.ts` 与 `group-policy.ts`。
  - 配置字段在 `src/config.ts:81-85`：`dmPolicy`（open|pairing|allowlist）、`groupPolicy`（open|allowlist|disabled）、`requireMention`、`allowFrom`、`groupAllowFrom`。
- 唯一的“紧急命令”是 `/stop`，由 `isQQBotFastAbortCommandText`（`src/bot.ts:428-444`，命中词表 `src/bot.ts:115-156`）在 `dispatchToAgent`（`src/bot.ts:2984`）内短路判定。**fork 没有 message queue、没有 slash-command 框架、没有 URGENT_COMMANDS 数组。**
- 入站分发链路：`monitorQQBotProvider` 在 `src/monitor.ts:299-325`（WS op=0）解析 `payload.t` → `handleQQBotDispatch({eventType,...})`（`src/bot.ts:3863`）→ `resolveInbound`（`src/bot.ts:1170-1178`）只 switch `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` / `AT_MESSAGE_CREATE` / `DIRECT_MESSAGE_CREATE` 四种事件，**没有 `INTERACTION_CREATE` case**。
- 生命周期入口：`qqbotPlugin.gateway.startAccount`（`src/channel.ts:367`）→ `monitorQQBotProvider`；`qqbotPlugin.gateway.stopAccount`（`src/channel.ts:414`）→ `stopQQBotMonitorForAccount`。channel plugin 形状在 `src/channel.ts:64`，只有 `capabilities` / `messaging` / `configSchema` / `setup` / `outbound`（`qqbotOutbound`，`src/channel.ts:364`）/ `gateway`，**没有 `approvals` / `execApprovals` / `auth` hook，没有 `isApprovalPayload`，没有 outbound suppression**。
- peerDependency 是 `moltbot >=0.1.0`（`package.json:105`），不是 `openclaw >=3.22`。fork 不打包 `openclaw` 运行时（`require.resolve('openclaw/plugin-sdk')` 在工作区内不可解析）。
- `src/types.ts` 没有 `InlineKeyboard` / `KeyboardButton` / `InteractionEvent` 等类型。

**上游现状（@tencent-connect/openclaw-qqbot v1.7.2）— 完整审批子系统：**

1. `src/approval-handler.ts`（506 行）：`QQBotApprovalHandler` 类。
   - `loadGatewayRuntime()`（`:25-71`）动态 `createRequire` 探测 `dist/plugin-sdk/gateway-runtime.js`，调用 `createOperatorApprovalsGatewayClient`（`:285-293`）开启一条**独立于主 gateway 的 WS 连接**，订阅 `exec.approval.requested` / `plugin.approval.requested` / `*.resolved`（`:366-376`）。
   - `buildApprovalKeyboard`（`:208-239`）构造三按钮 Inline Keyboard：`✅ 允许一次` / `⭐ 始终允许` / `❌ 拒绝`，button_data = `approve:<approvalId>:<decision>`，`action.type=1`（Callback）、`group_id="approval"`（互斥）、`click_limit=1`、`permission.type=2`。
   - `resolveTarget`（`:242-253`）从 `sessionKey`/`turnSourceTo` 正则 `qqbot:(c2c|direct|group):([A-F0-9]+)` 提取投递目标；`toShortId`（`:162`）取前 8 位。
   - `resolveApproval`（`:322-364`）支持完整 ID（`exec:uuid`/`plugin:uuid`）、纯 UUID、8 位 shortId 三种解析，调 RPC `exec.approval.resolve` / `plugin.approval.resolve`。
   - 模块级注册表：`registerApprovalHandler` / `getApprovalHandler` / `findApprovalHandlerForShortId`（`:488-505`），`isApprovalFeatureAvailable` / `setApprovalFeatureAvailable`（`:480-486`）功能门控。
2. `src/gateway.ts`：
   - `:563-573` 实例化 + 注册 handler，`.start()` 异步拉起。
   - `:586` `URGENT_COMMANDS = ["/stop", "/approve"]`：`/approve` 作为紧急命令经 `msgQueue.executeImmediate` 直交框架（`:598-606`）。
   - `:53-200` `handleInteractionCreate`：type=CONFIG_QUERY/CONFIG_UPDATE 走配置 ACK；普通按钮先 `acknowledgeInteraction`（`:180`）再用正则 `^approve:((?:(?:exec|plugin):)?[0-9a-f-]+):(allow-once|allow-always|deny)$`（`:187`）匹配 button_data，命中则 `handler.resolveApproval(approvalId, decision)`（`:195`）。
   - `:1928-1935` WS 主循环 `else if (t === "INTERACTION_CREATE")` 分发到 `handleInteractionCreate`。
3. `src/channel.ts`：声明两套 hook —— 扁平 `execApprovals`（`:467-483`，3.28 框架）和嵌套 `auth`+`approvals`（`:491-514`，3.31+ 框架），以及 `outbound.shouldSuppressLocalPayloadPrompt`（`:294`）。`isApprovalPayload`（`:20-36`）通过 `channelData.execApproval` 或英文审批文本正则识别。所有 `buildPendingPayload`/`buildResolvedPayload` 返回 `null`（`:481-482`、`:508-513`），即完全屏蔽框架 Forwarder 的纯文本通知，由 handler 自行投递。
4. `src/message-gating.ts`（190 行）：纯函数 `resolveGroupMessageGate`（`:129`）三层优先级模型：`ignoreOtherMentions`（drop_other_mention）→ `shouldBlock`（block_unauthorized_command）→ `mentionGating`（skip_no_mention / pass）。输入字段 `allowTextCommands` / `isControlCommand` / `commandAuthorized` / `ignoreOtherMentions` / `hasAnyMention`（`:41-56`）。
5. `src/admin-resolver.ts`（182 行）：`loadAdminOpenId`/`saveAdminOpenId`/`resolveAdminOpenId`（按 accountId+appId 持久化，含 legacy 迁移 `:53-75`），`sendStartupGreetings`（`:146`）。**依赖 `listKnownUsers`（known-users.ts）、`getStartupGreetingPlan`（startup-greeting.ts）、`sendProactiveC2CMessage`（api.ts）**。
6. `src/slash-commands.ts:2038-2113` `registerCommand({name:"bot-approve"})`：on/off/always/reset/status 写 `tools.exec.security`（deny|allowlist|full）与 `tools.exec.ask`（off|on-miss|always）；`isApprovalFeatureAvailable()` 不可用时回退 `delegatePrompt` CLI 指引；c2c-only（`:2051`）。
7. `src/api.ts:604-612` `acknowledgeInteraction`（PUT `/interactions/{id}`）、`:657-680` `buildMessageBody` 的 `keyboard` 字段、`:758/771` `sendC2CMessageWithInlineKeyboard`/`sendGroupMessageWithInlineKeyboard`。`src/types.ts:318-439` 定义 `InteractionEvent` / `KeyboardButton` / `KeyboardAction` / `InlineKeyboard` 等类型。

### 差距清单

上游拥有、fork 完全缺失的能力：

1. **审批 Handler 全缺**：`QQBotApprovalHandler`、exec/plugin 审批事件订阅、三按钮 Inline Keyboard（`buildApprovalKeyboard`/`KeyboardButton`/`group_id` 互斥/`click_limit=1`/`permission.type=2`）、approval-id 解析（前缀/纯 UUID/shortId）、accountId→handler 注册表（`registerApprovalHandler`/`getApprovalHandler`/`findApprovalHandlerForShortId`）。
2. **gateway-runtime 动态加载器全缺**：`loadGatewayRuntime`/`createOperatorApprovalsGatewayClient`、独立审批 WS 连接、`isApprovalFeatureAvailable`/`setApprovalFeatureAvailable` 功能门控（`/bot-approve` 依赖）。
3. **/bot-approve 命令全缺**：没有任何代码写 `tools.exec.security` / `tools.exec.ask`。**且 fork 没有 `slash-commands.ts` 的 `registerCommand` 框架**，`/bot-approve` 需先落地命令框架或改造成 fork 的 `/stop` 风格文本命令路径。
4. **/approve 紧急命令全缺**：fork 没有 `URGENT_COMMANDS` 概念（`isQQBotFastAbortCommandText` 只识别 `/stop`），`/approve` 无法走紧急路径交给框架。
5. **INTERACTION_CREATE 处理全缺**：`resolveInbound` switch（`src/bot.ts:1171`）无 `INTERACTION_CREATE` case；无 `acknowledgeInteraction`、无 button_data 正则分发、无点击回调 `resolveApproval`。
6. **channel.ts 审批 hook 全缺**：无 `execApprovals`（扁平）、无 `auth`+`approvals`（嵌套）、无 `outbound.shouldSuppressLocalPayloadPrompt`、无 `isApprovalPayload` —— 框架侧的本地审批提示无法被抑制，会与 Inline Keyboard 投递重复。
7. **message-gating.ts 统一门控全缺**：无 `resolveGroupMessageGate` 三层模型，无 `allowTextCommands`/`isControlCommand`/`commandAuthorized`/`ignoreOtherMentions` 字段。fork 硬编码 `CommandAuthorized:true` + 仅 `dmPolicy/groupPolicy/requireMention`。
8. **admin-resolver.ts 全缺**：无 per-accountId+appId admin-openid 持久化/迁移、无 `resolveAdminOpenId`（首个 c2c 用户自动锁定）、无 `sendStartupGreetings`。**且依赖链 `listKnownUsers`/`getStartupGreetingPlan` 在 fork 中也不存在**。
9. **api.ts inline-keyboard 发送器全缺**：无 `sendC2CMessageWithInlineKeyboard`/`sendGroupMessageWithInlineKeyboard`/`acknowledgeInteraction`、无 `InlineKeyboard`/`KeyboardButton`/`InteractionEvent` 类型。

### 必须保留

移植审批子系统时，以下 fork 既有能力**必须存活**（上游没有直接等价物或语义冲突）：

- **`dmPolicy`（open|pairing|allowlist）+ `allowFrom` + `checkDmPolicy`**（`src/config.ts:81,84`；shared `policy/dm-policy.ts`）—— fork 独有的 c2c 授权模型，上游 `message-gating.ts` 无对应。必须映射进新门控而非丢弃。
- **`groupPolicy`（open|allowlist|disabled）+ `groupAllowFrom` + `checkGroupPolicy`**（`src/config.ts:82,85`；shared `policy/group-policy.ts`）—— `disabled` / allowlist 语义上游 `resolveGroupMessageGate` 不具备。
- **`requireMention` 默认 true**（`src/config.ts:83`）与 `mentionedBot` 解析 —— 需并入上游 mention 门控层。
- **`/stop` 快速中止**（`isQQBotFastAbortCommandText`，`src/bot.ts:428-444`）—— fork 的 abort 入口，不能被 `/approve` 紧急路径覆盖。
- **channel id `qqbot-china` / `QQBOT_CHANNEL_ID`** 与包身份 `@openclaw-china/qqbot`（`package.json:2`）—— 不能被上游的 `qqbot` id 覆盖。
- **streaming / typingHeartbeat / c2cMarkdownDeliveryMode / c2cMarkdownChunkStrategy / replyFinalOnly / known-targets**（`src/config.ts:60-92`）—— China 专用投递特性，与审批子系统正交，移植不得触碰。
- **`moltbot` peerDependency 语义**（`package.json:104-111`）—— gateway-runtime 探测路径必须适配 moltbot 安装布局，不能假设 `openclaw` npm 包。

### 实施方案

按依赖顺序分 6 步（每步独立可测）。核心约束：**上游自包含模块必须适配 fork 的 contracts（`qqbotPlugin.gateway.startAccount` / `handleQQBotDispatch` / `qqbotOutbound`）与 shared infra（`policy/*`），不得原样复制成独立 daemon。**

**Step 1 — 类型 + api primitives（基础层，无外部依赖）。**
- 修改 `src/types.ts`：新增 `KeyboardButton` / `KeyboardAction` / `KeyboardPermission` / `KeyboardRenderData` / `KeyboardRow` / `InlineKeyboard` / `InteractionEvent` / `InteractionDataResolved`（照搬上游 `types.ts:318-439`，纯类型无运行时依赖）。
- 修改 `src/monitor.ts`（或新建 `src/api-extra.ts` 后 re-export）：新增 `acknowledgeInteraction(token, interactionId, code=0, data?)`、`sendC2CMessageWithInlineKeyboard(token, openid, content, keyboard, msgId?)`、`sendGroupMessageWithInlineKeyboard(...)`。这些复用 fork 现有的 token/getAccessToken（在 `src/client.ts`/`monitor.ts`）与 `apiRequest` 基建，参考上游 `api.ts:604-612`、`:758-780` + `buildMessageBody` 的 `keyboard` 字段（`:657-681`）。

**Step 2 — message-gating.ts（纯函数，零运行时依赖，可最先落地）。**
- 新建 `src/message-gating.ts`：直接移植上游 `resolveGroupMessageGate`（190 行），保留三层模型。
- 修改 `src/bot.ts:3829-3861` `shouldHandleMessage`：**不替换** `checkDmPolicy`/`checkGroupPolicy`（必须保留），而是在 group 分支**追加**一层 `resolveGroupMessageGate` 调用作为 mention/控制命令过滤。映射：fork `requireMention`→上游 `requireMention`；fork `mentionedBot`→`wasMentioned`；新增 `allowTextCommands`（fork 暂可恒 false 或挂新 config 字段）、`commandAuthorized`（来源见 Step 3 对 `CommandAuthorized` 的改造）、`isControlCommand`（识别 `/stop`/`/approve`/`/bot-approve`）、`ignoreOtherMentions`（新 config 字段，默认 false）。
- 冲突消解：`groupPolicy:disabled`/`allowlist` 仍由 `checkGroupPolicy` 处理（早于 `resolveGroupMessageGate`），二者串行而非互斥。

**Step 3 — CommandAuthorized 真实化（最小授权改造）。**
- 修改 `src/bot.ts:2966` `buildInboundContext`：将 `CommandAuthorized: true` 改为按发送者解析。引入 admin 概念：c2c 发送者若在 `allowFrom` 或为 resolved admin（Step 5）→ `true`；控制命令（`/stop`/`/approve`/`/bot-approve`）需 `commandAuthorized=true` 才执行，否则被 `resolveGroupMessageGate` 的 `block_unauthorized_command` 拦截。保留 `dmPolicy:allowlist` 作为另一条授权路径。

**Step 4 — INTERACTION_CREATE 接线（gateway 层）。**
- 修改 `src/bot.ts:1170` `resolveInbound`：新增 `case "INTERACTION_CREATE"`，解析 `InteractionEvent`（button_data、group_openid、user_openid）。注意 fork 的 `resolveInbound` 当前返回 `QQInboundMessage | null`，而 Interaction 结构不同——建议把 INTERACTION_CREATE 拆到 `handleQQBotDispatch` 内独立分支（`src/bot.ts:3863` 之后），不强行套 `QQInboundMessage`。
- 新建 `src/approval-interaction.ts`（或并入 `approval-handler.ts`）：实现 `handleApprovalInteraction(event, accountId)`：先 `acknowledgeInteraction`，再正则匹配 button_data（上游 `gateway.ts:187`），命中调 `handler.resolveApproval`。

**Step 5 — admin-resolver.ts（依赖 known-users + startup-greeting，fork 均无）。**
- 评估：admin-resolver 上游依赖 `listKnownUsers`（known-users.ts）、`getStartupGreetingPlan`（startup-greeting.ts）、`sendProactiveC2CMessage`（api.ts）。fork 三者皆无。
- **降级方案（推荐）**：fork 不引入完整 known-users 持久层；改为最小实现——`resolveAdminOpenId` 仅读 `allowFrom[0]`（fork 已有字段）或首个 c2c 发送者（运行期 in-memory 记录），写入 `loadAdminOpenId`/`saveAdminOpenId` 文件（路径仿上游 `data/admin-{accountId}-{appId}.json`，data dir 用 fork 的 `~/.openclaw/media/qqbot` 同级或 `inboundMedia.dir`）。`sendStartupGreetings` 暂可不移植（与审批核心无关），仅保留 admin 解析供 `CommandAuthorized` 使用。
- 新建 `src/admin-resolver.ts`（精简版，约 80 行）。

**Step 6 — approval-handler.ts + channel.ts hooks + /bot-approve（核心，最后做）。**
- 新建 `src/approval-handler.ts`：移植 `QQBotApprovalHandler`，但：
  - `loadGatewayRuntime` 探测路径需适配 moltbot 布局（fork `package.json` 无 `scripts/link-sdk-core.cjs`，策略 2 从 `process.argv[1]` 反推保留，策略 1 改为探测 `moltbot/dist/plugin-sdk/gateway-runtime.js`）。
  - 投递目标解析 `resolveTarget` 的正则 `qqbot:(c2c|direct|group):([A-F0-9]+)` 需确认与 fork 的 `from` 字段格式（`src/bot.ts:2943-2948` `${QQBOT_CHANNEL_ID}:group:${groupOpenid}`）一致——**风险点**：fork 用 `QQBOT_CHANNEL_ID`（qqbot-china）作前缀，而正则写死 `qqbot:`，需放宽为 `(?:qqbot|qqbot-china):`。
  - 在 `qqbotPlugin.gateway.startAccount`（`src/channel.ts:402` `monitorQQBotProvider` 调用前）实例化 + 注册 + `.start()`；在 `stopAccount`（`src/channel.ts:414`）`.stop()` + `unregisterApprovalHandler`。
- 修改 `src/channel.ts`：在 `qqbotPlugin` 对象追加 `execApprovals`（扁平）+ `auth`+`approvals`（嵌套）+ `outbound` 内 `shouldSuppressLocalPayloadPrompt`，照搬上游 `channel.ts:294,467-514`；新增 `isApprovalPayload`（上游 `channel.ts:20-36`）。注意 fork `outbound` 当前是 `qqbotOutbound`（`src/channel.ts:364`），需在 `qqbotOutbound`（`src/outbound.ts`）对象内追加 suppression 字段或在外层包裹。
- `/bot-approve`：fork 无 slash-command 框架。最小方案——在 `dispatchToAgent`（`src/bot.ts:2972`）前加 `/bot-approve` 文本命令分支（仿 `/stop` 的 `isQQBotFastAbortCommandText` 模式），通过 runtime 的 config API（`getQQBotRuntime()`）写 `tools.exec.security`/`tools.exec.ask`。`isApprovalFeatureAvailable()` 不可用时回退指引文本。

fork→upstream 映射见 `forkToUpstreamMap` 字段。

### 测试计划

- `message-gating.test.ts`：`resolveGroupMessageGate` 四个 action 全覆盖——drop_other_mention（`ignoreOtherMentions && hasAnyMention && !wasMentioned`）、block_unauthorized_command（`allowTextCommands && isControlCommand && !commandAuthorized`）、skip_no_mention（`requireMention && canDetectMention && !effectiveWasMentioned`）、pass；以及命令旁路 `shouldBypassMention` 六条件全满足时为 true。
- `approval-handler.test.ts`（mock gateway-runtime + QQ API）：(1) `exec.approval.requested` → 调用 `sendC2CMessageWithInlineKeyboard` 且 keyboard 含三按钮、button_data 格式 `approve:<id>:allow-once|allow-always|deny`；(2) `resolveApproval` 对完整 ID / 纯 UUID / 8 位 shortId 三种输入都能定位 pending 并发出 `exec.approval.resolve` RPC；(3) `turnSourceAccountId` 不匹配本账号时静默跳过；(4) `loadGatewayRuntime` 失败时 `start()` 不抛、`isApprovalFeatureAvailable()` 为 false。
- `approval-interaction.test.ts`：button_data 命中正则时 `acknowledgeInteraction` 被调且 `resolveApproval` 收到正确 (approvalId, decision)；非审批 button_data 不触发 resolve。
- `bot.approval-gating.test.ts`：`INTERACTION_CREATE` eventType 进入新分支而不被当作普通消息；`CommandAuthorized` 在 allowFrom/admin 时为 true、否则 false；`/stop` 仍优先于 `/approve` 紧急判定（保留 fork abort 语义）。
- `admin-resolver.test.ts`（fork 精简版）：`loadAdminOpenId`→`saveAdminOpenId` 往返；legacy 路径迁移到 accountId+appId 路径；`resolveAdminOpenId` 在无持久化时回退 `allowFrom[0]`。
- 回归：`bot.known-targets.test.ts` / `bot.streaming.test.ts` / `bot.c2c-markdown-transport.test.ts` 全绿（确保 Step 1-2 未触碰投递链）。

### 风险与注意事项

1. **gateway-runtime 可用性（最高风险）**：`createOperatorApprovalsGatewayClient` 与 `approval-runtime` 仅在 openclaw/moltbot ≥3.22 存在。fork 工作区 `require.resolve('openclaw/plugin-sdk')` 不可解析，peerDep 是 `moltbot>=0.1.0`。移植前**必须**确认目标宿主 moltbot 版本暴露该模块；否则审批功能只能静默降级（上游已用 `loadGatewayRuntime` try/catch + `isApprovalFeatureAvailable` 处理，移植时务必保留该降级路径，不可让插件启动失败）。
2. **`resolveTarget` 正则与 fork channel id 不匹配**：上游正则 `qqbot:(c2c|direct|group):` 写死 `qqbot`，fork 的 `from`/`sessionKey` 前缀是 `QQBOT_CHANNEL_ID`（qqbot-china，见 `src/bot.ts:2943-2948`）。若不放宽正则，所有审批请求都会因 `resolveTarget` 返回 null 被丢弃。**必须**改为 `(?:qqbot|qqbot-china):`。
3. **CommandAuthorized 改造回归面广**：`src/bot.ts:2966` 从 `true` 改为动态判定，会影响所有依赖“消息即授权”的下游（dispatch、reply、session 记录）。需逐路核查 `dispatchToAgent`（`:2972`）及 reply dispatcher（`:3685+`）是否假设授权。
4. **channel hook 框架版本差异**：上游同时声明扁平（3.28）与嵌套（3.31+）两套 hook，fork 宿主框架版本未知。需先探测 moltbot 期望的 hook 形状，否则 hook 不被调用、suppression 失效，导致框架仍发纯文本审批通知与 Inline Keyboard 重复。
5. **/bot-approve 缺命令框架**：fork 无 `registerCommand`，强行移植 slash-commands.ts 整套成本巨大。推荐用 `/stop` 风格文本命令最小实现，但这意味着 `/bot-approve` 无法享受上游的权限/usage/补全体系——可接受的 China 折中。
6. **独立审批 WS 连接的凭证与限频**：`QQBotApprovalHandler` 自开 WS 连接，会多占一个 QQ gateway 会话配额，且与主 `monitorQQBotProvider` 的 token 刷新各自独立——需确认 appId/clientSecret 在两连接并发取 token 时不冲突（fork 的 token cache 在 `src/client.ts`，需评估共享 vs 隔离）。
7. **admin-resolver 依赖缺失**：上游版依赖 known-users + startup-greeting，fork 无。精简版只覆盖审批所需的最小 admin 解析；若后续要完整 startup-greeting，需单独评估移植 known-users 持久层（不在本子系统范围）。

## 4.5 Outbound Media Send, Large-File Chunked Upload, Inbound Attachments

### 现状对比

#### Fork 现状（@openclaw-china/qqbot 2026.3.9-1）

出站媒体走 `qqbotOutbound.sendMedia`（`extensions/qqbot/src/outbound.ts:523-655`）→ `sendFileQQBot`（`extensions/qqbot/src/send.ts:144-246`）。上传是**单次 base64 上传**：

- HTTP URL 直接把原始 url 透传给 QQ 的 `/v2/users/{openid}/files` 或 `/v2/groups/{groupOpenid}/files`（`client.ts:446-502` 的 `uploadC2CMedia`/`uploadGroupMedia`，`srv_send_msg:false`，body 带 `url` 或 `file_data` base64），拿回 `file_info`，再走 `sendC2CMediaMessage`/`sendGroupMediaMessage`（`client.ts:504-581`，msg_type 7）发送。
- 本地文件经 shared 的 `readMedia`（`send.ts:189` `readMediaWithConfig`）读入内存并 `buffer.toString("base64")`（`send.ts:202`），默认 `maxFileSizeMB=100`、`mediaTimeoutMs=30000`（`config.ts:90-91`）。语音用 `convertAudioToSilk`（`send.ts:115-142`，ffmpeg-static 转 24kHz mono PCM + silk-wasm encode）。
- 完全没有 `qqmedia/qqimg/qqvoice/qqvideo/qqfile` 标签解析；媒体只能通过结构化的 `sendMedia(msgId/url)` 通道投递。
- 出站 URL 透传给 QQ API（由 QQ 服务端自行抓取），fork 侧**无 SSRF/DNS 过滤**。
- file 媒体类型会把 text 作为独立 follow-up 消息发送（`outbound.ts:163-165` `shouldSendTextAsFollowupForMedia` + `outbound.ts:620-635`）。
- C2C 媒体发送结果会缓存 `ref_idx`（`outbound.ts:237-271` `recordOutboundC2CRefIndex`，含 `buildOutboundAttachmentSummary`）。

入站附件（`bot.ts:822-928` `resolveInboundAttachmentsForAgent`）：图片用 shared `downloadToTempFile`（`bot.ts:854`）+ `finalizeInboundMediaFile`（`:861`）缓存到 `resolveInboundMediaDir`；语音用 shared `fetchMediaFromUrl`（`:886`）+ `transcribeTencentFlash`（`:890`，腾讯 Flash ASR，见 `packages/shared/src/asr/tencent-flash.ts`），错误经 `ASRError`（`:907`）。有 `scheduleTempCleanup`（`bot.ts:804`）与 `pruneInboundMediaDir`（`:3819`）的入站媒体保留/清理。shared 的 `downloadToTempFile`/`fetchMediaFromUrl`（`packages/shared/src/media/media-io.ts:377,448`）直接 `customFetch(url)`，**无 IP/DNS 校验**。

流式：`QQBotStreamingController`（`streaming.ts:33`）用 `sendC2CStreamMessage` + 500ms throttle/min 300ms flush（`streaming.ts:54-213`），但**完全不含任何媒体/标签处理**（grep 媒体相关为零）。

#### 上游现状（@tencent-connect/openclaw-qqbot v1.7.2）

出站按类型分函数 `sendPhoto`/`sendVoice`/`sendVideoMsg`/`sendDocument` + 自动路由 `sendMedia`（`outbound.ts:318,411,493,640`），全部汇入 `chunkedUploadAndSend`（`outbound.ts:521-627`）→ `chunkedUploadC2C`/`chunkedUploadGroup`（`utils/chunked-upload.ts:99,226`），实现完整大文件分片协议：

1. `computeFileHashes`（`chunked-upload.ts:442-483`）流式算 md5+sha1+md5_10m（前 `MD5_10M_SIZE=10002432` 字节）；
2. `c2cUploadPrepare`/`groupUploadPrepare`（`api.ts:884,949`）拿到 `upload_id`+`block_size`+`parts`(presigned COS URL)+`concurrency`+`retry_timeout`；
3. `runWithConcurrency`（`chunked-upload.ts:423-431`，batch 模式，默认 1 并发、上限 10）并行 `putToPresignedUrl`（`:355-417`，超时 300s、最多 2 次指数退避重试）+ `c2cUploadPartFinish`/`groupUploadPartFinish`（`api.ts:909,967`，带 `part_index/block_size/md5` + 业务码 40093001 持续重试）；
4. `c2cCompleteUpload`/`groupCompleteUpload`（`api.ts:921,987`，无条件重试）拿 `file_info`。

`UPLOAD_PREPARE_FALLBACK_CODE=40093002`（`api.ts:488`）命中时抛 `UploadDailyLimitExceededError`（`chunked-upload.ts:39-51`，携带 filePath/fileSize），`chunkedUploadAndSend` 据此产出稳定 `errorCode`（`OUTBOUND_ERROR_CODES.FILE_TOO_LARGE`/`UPLOAD_DAILY_LIMIT_EXCEEDED`，`outbound.ts:170-178,549-618`）与含主机路径的兜底文案。

HTTP/data-URL 源都先经 `image-server.ts:447 downloadFile`（SSRF 预检 `validateRemoteUrl` + Content-Length 预检 + 流式字节计数 + Content-Type→扩展名 + 原子 `.tmp` rename + 网络错误分类重试，`:47-84`）下载到 `~/.openclaw/media/qqbot/downloads/{appId}/{targetId}/` 再分片上传。

`media-tags.ts:157 normalizeMediaTags`（35 个标签名：5 canonical + 30 alias，自闭合属性语法 `file=/src=/path=/url=`、中文尖括号、闭合标签不匹配、八进制/双重编码路径修复）+ `media-send.ts`（`splitByMediaTags:260`/`parseMediaTagsToSendQueue:355`/`executeSendQueue:392`/`stripIncompleteMediaTag:515`）把 LLM 文本内嵌的 `<qqimg/qqvoice/qqvideo/qqfile/qqmedia>` 路由到对应 send 函数，并给流式做截断保护。`upload-cache.ts` 按 `md5(content):scope:targetId:fileType` 缓存 file_info（TTL 减 60s 安全余量，溢出删最早一半）。`ssrf-guard.ts` 拦 127/8、10/8、172.16/12、192.168/16、169.254/16、0.0.0.0、::1、fe80、fc/fd。

deliver 管线在 `outbound-deliver.ts`（`parseAndSendMediaTags:65` + `sendPlainReply:123`，markdown 图片抽取、Base64 富媒体 send、跨源去重、reply 限流 `checkMessageReplyLimit`/`recordMessageReply`，`outbound.ts:60-167`）。上游 `streaming.ts:21-22,561,699,723` 也接入了 `findFirstClosedMediaTag`/`stripIncompleteMediaTag`/`sendMediaQueue`。

### 差距清单

上游具备、fork 缺失：

1. **分片大文件上传**：`utils/chunked-upload.ts`（prepare→并行 presigned PUT→partFinish→complete + md5/sha1/md5_10m 哈希、并发控制、per-part MD5、退避重试、进度回调）+ `api.ts` 的 `c2cUploadPrepare`/`c2cUploadPartFinish`/`c2cCompleteUpload`/`groupUploadPrepare`/`groupUploadPartFinish`/`groupCompleteUpload`（`api.ts:884-991`）+ 类型 `UploadPrepareResponse`/`UploadPrepareHashes`/`MediaUploadResponse`/`UploadPart`（`api.ts:826-863`）。fork 只有单次 base64，接近 100MB 会爆且无 prepare/partFinish/complete 路径。
2. **SSRF 防护**：`utils/ssrf-guard.ts`（`isReservedAddr:31`/`validateRemoteUrl:61`）。fork 出站把 URL 直接交给 QQ（QQ 自抓取），入站 `downloadToTempFile`/`fetchMediaFromUrl` 无任何 IP/DNS 过滤——入站用户附件 URL 是真实 SSRF 暴露面。
3. **file_info 去重缓存**：`utils/upload-cache.ts`（`computeFileHash:30`/`getCachedFileInfo:50`/`setCachedFileInfo:75`）。fork 每次重传相同文件。
4. **统一 `<qqimg/qqvoice/qqvideo/qqfile/qqmedia>` 标签系统**：`utils/media-tags.ts` + `utils/media-send.ts`。fork 零标签解析，LLM 无法在文本内联媒体。
5. **强化远程下载**：`image-server.ts:447 downloadFile`（SSRF 预检、Content-Length 预检 + 流式字节计数、Content-Type→扩展名、原子 `.tmp` rename、网络错误分类 ETIMEDOUT/ECONNRESET/ENOTFOUND/EAI_AGAIN/UND_ERR_CONNECT_TIMEOUT 重试）。fork 的 shared 下载缺这些。
6. **稳定错误码 + 用户可读文案**：`OUTBOUND_ERROR_CODES`（`outbound.ts:170`）+ `resolveUserFacingMediaError`（`outbound.ts:196`）+ `UploadDailyLimitExceededError` + `UPLOAD_PREPARE_FALLBACK_CODE=40093002`。fork 只返回裸 error 字符串。
7. **按类型的结构化 send API**：`sendPhoto`/`sendVoice`/`sendVideoMsg`/`sendDocument`（显式 mimeType 覆盖、支持格式白名单如 `sendPhoto` 的 jpg/jpeg/png/gif/webp/bmp `outbound.ts:345-348`、voice 45s 竞态超时 `media-send.ts:447-457`）。fork 的 `sendFileQQBot` 是单条无差别路径。
8. **deliver 管线**：`outbound-deliver.ts`（`parseAndSendMediaTags`+`sendPlainReply`，markdown/plain 图片模式、markdown 裸 URL 抽取、tool-media 转发 + 跨源去重、`checkMessageReplyLimit` 4 次/1hr/message_id）。fork 无对应 deliver 模块（用 streaming 替代）。
9. **本地图片 HTTP server**：`image-server.ts`（端口 18765，`startImageServer:236`/`saveImage:295`/`ensureImageServer:398`，TTL 清理 + path-traversal 防护）。fork 依赖 QQ API 直接抓远程 URL。

### 必须保留（China-fork 独有，port 时不可丢）

- **流式消息投递**：`QQBotStreamingController` + `sendC2CStreamMessage` + 500ms throttle/min 300ms flush + msgSeq + sessionShouldFallbackToStatic（`streaming.ts:33-297`）。上游无 c2c streaming edit。
- **C2C typing 心跳**：`sendC2CInputNotify` 经 `sendTyping` 接入，含 `shouldRetryWithEventId`/`logEventIdFallback` 的 event_id fallback 重试（`outbound.ts:130-161,657-740`）。
- **C2C/群 markdown transport**：`markdownSupport`/`groupMarkdown` 开关（`outbound.ts:308-309`）与独立的 `markdown-images.ts`（`normalizeQQBotMarkdownImages:312`，进程内 PNG/JPEG/GIF/WebP 头尺寸解析、围栏代码块感知图片改写、`getQQBotHttpImageSize:268` Range fetch）。
- **displayAliases / known-targets 主动路由**（`proactive.ts`）+ onboarding/setup CLI + 出站 `recordOutboundC2CRefIndex` ref-index 缓存（`outbound.ts:237-271`，`ref-index-store.ts`）。
- **file-as-followup 行为**：media 类型为 file 时 text 作为独立 follow-up 消息（`outbound.ts:163-165,620-635`）。
- **入站 Tencent-Flash ASR**：`transcribeTencentFlash`/`resolveQQBotASRCredentials`/`ASRError`（`bot.ts:869-907`，`packages/shared/src/asr/`），与上游 provider-agnostic STT（`stt.ts transcribeAudio/resolveSTTConfig`）不同。
- **入站媒体保留/清理**：`resolveInboundMediaDir`/`resolveInboundMediaKeepDays`/`pruneInboundMediaDir`/`finalizeInboundMediaFile`/`scheduleTempCleanup`（`bot.ts:804,3095-3096,3819`）与 `ResolvedInboundAttachment`/`buildInboundContentWithAttachments` 文本块格式（`bot.ts:649-656,928-990`）。

### 实施方案

**port-not-rebase 原则**：上游 `outbound.ts`/`api.ts`/`outbound-deliver.ts` 是自包含 daemon 插件，把 URL 直传 + base64 上传 + 分片上传 + deliver 管线全揉在一个文件里。fork 是结构化 channel 扩展，出站必须经 `qqbotOutbound.sendMedia` 契约、入站必须用 shared `@openclaw-china/shared` 的 media/asr 模块。所以上游模块要**适配**而非原样拷贝。

#### 分阶段（与 prior 建议 P0→P2 一致，已按代码核实）

**P0(a) — SSRF 防护（入站，最低风险安全修复）**  ✅ 已落地（2026-06-13）
- 新建 `extensions/qqbot/src/utils/ssrf-guard.ts`：移植 `isReservedAddr`/`validateRemoteUrl`（上游 `ssrf-guard.ts:31,61`）。DNS 用 `node:dns/promises`。
- 但**不**在 fork 出站 URL 透传处加 SSRF——出站是 QQ 服务端抓取，加 SSRF 会改变行为（拦截 QQ 本会抓取的 URL）。仅在入站下载路径加。
- 入站：在 `bot.ts:854` `downloadToTempFile` 之前、`:886` `fetchMediaFromUrl` 之前调用 `validateRemoteUrl(att.url)`，失败则 warn 并跳过该附件（保留 fork 的 try/catch 降级）。**注意**：上游把 SSRF 做进 `downloadFile` 内部；fork 应尊重 shared 包边界，做在 fork 调用点而非改 shared（shared 供多 channel 共用，强行改 shared 会影响其它 channel）。
- **落地实况**：`ssrf-guard.ts` 逐字移植上游；`bot.ts` 在 image/voice 两个入站下载 try 块首行调 `validateRemoteUrl(att.url)`（抛错由既有 catch warn + 跳过），并 `export` 了 `resolveInboundAttachmentsForAgent` 供测试。出站 `send.ts` 未改（QQ 自抓取）。测试：`utils/ssrf-guard.test.ts`（10 用例，含 172.16 边界、DNS rebinding mock、DNS 失败非致命）+ `bot.inbound-ssrf.test.ts`（3 用例，部分 mock shared 下载函数，验证内网 IP URL 不触发下载）。套件 207/207、tsc、tsup 均绿。

**P0(b) — 分片大文件上传（headline 能力）**
- 新建 `extensions/qqbot/src/utils/chunked-upload.ts`：移植 `chunkedUploadC2C`/`chunkedUploadGroup`/`computeFileHashes`/`readFileChunk`/`putToPresignedUrl`/`runWithConcurrency` + `UploadDailyLimitExceededError` + `ChunkedUploadProgress`（上游 `chunked-upload.ts` 全文）。**改动点**：上游从 `../api.js` 拿 `getAccessToken`/`c2cUploadPrepare` 等；fork 改为从 `../client.js` 拿（见下）。
- 扩展 `extensions/qqbot/src/client.ts`：新增 `UploadPart`/`UploadPrepareResponse`/`UploadPrepareHashes`/`MediaUploadResponse` 类型 + `c2cUploadPrepare`/`c2cUploadPartFinish`/`c2cCompleteUpload`/`groupUploadPrepare`/`groupUploadPartFinish`/`groupCompleteUpload`（移植 `api.ts:826-991`，用 fork 的 `apiPost` 包装，`Authorization: QQBot ${accessToken}` 已有）。复用 fork 现有 `getAccessToken`（`client.ts:130`，多账户 tokenCacheMap）——上游 `getAccessToken(appId,clientSecret)` 与 fork 签名兼容。
- 新建 `extensions/qqbot/src/utils/file-utils.ts`：移植 `UPLOAD_SIZE_LIMITS`/`getMaxUploadSize`/`getFileTypeName`/`formatFileSize`/`fileExistsAsync`/`getFileSizeAsync`（上游 `file-utils.ts:9-115`）。注意上游 IMAGE=30MB/VIDEO=100MB/VOICE=20MB/FILE=100MB 与 fork 的单一 `maxFileSizeMB=100` 不同——port 后 fork 的 `cfg.maxFileSizeMB` 仍作总闸，但 `getMaxUploadSize(fileType)` 作 per-type 细分。
- 改 `extensions/qqbot/src/send.ts`：在 `sendFileQQBot`（`:144`）内，对**本地文件**且体积 > 阈值（或恒定）改走 `chunkedUploadC2C`/`chunkedUploadGroup`。保留 fork 的 SILK 转码（`convertAudioToSilk`，`:115`）作为 VOICE 的前置：转码后的 `.silk` 路径再分片上传。HTTP URL 仍先透传给 `uploadC2CMedia`（保留 fork 现有行为，避免 SSRF 行为变更），仅在 base64 上传失败或文件超限时 fallback 到「下载到本地 → 分片上传」。**必须保留** `refIdx` 提取（`send.ts:236-241`）与 `outbound.ts:636-644` 的 ref-index 缓存调用。
- 新建 `extensions/qqbot/src/utils/outbound-errors.ts`：移植 `OUTBOUND_ERROR_CODES`/`OutboundResult.errorCode/qqBizCode`/`resolveUserFacingMediaError`/`DEFAULT_MEDIA_SEND_ERROR`（上游 `outbound.ts:170-205`）。fork 的 `QQBotSendResult`（`types.ts`）扩展可选 `errorCode?: OutboundErrorCode`，`outbound.ts:651-653` 的 catch 把 `UploadDailyLimitExceededError`/`FILE_TOO_LARGE` 映射成可读文案。

**P1(a) — file_info 去重缓存**
- 新建 `extensions/qqbot/src/utils/upload-cache.ts`：原样移植（上游 `upload-cache.ts` 全文，纯内存、无外部依赖）。在 `send.ts` 的 `uploadQQBotFile`（`:60`）前后调用 `getCachedFileInfo`/`setCachedFileInfo`，key 用 `computeFileHash(buffer)`（base64 场景）或文件路径 hash。

**P1(b) — 媒体标签系统（纯文本变换，不依赖 deliver 重写）**
- 新建 `extensions/qqbot/src/utils/media-tags.ts`：移植 `normalizeMediaTags` + 别名表 + 自闭合/模糊正则（上游 `media-tags.ts` 全文）。`expandTilde`/`normalizePath` 用 fork 内部等价实现（fork 已有 path 处理）。
- 新建 `extensions/qqbot/src/utils/media-send.ts`：移植 `splitByMediaTags`/`parseMediaTagsToSendQueue`/`executeSendQueue`/`stripIncompleteMediaTag`/`hasMediaTags`（上游 `media-send.ts`）。**关键适配**：`executeSendQueue` 的 `onSendText` 回调 re-point 到 fork 的 `qqbotOutbound.sendText`（而非上游 sendText/流式）；媒体项 re-point 到 `qqbotOutbound.sendMedia`。这样新增的标签解析能力可被 fork 的 sendMedia/text 调用点消费，而**不必移植上游 outbound-deliver.ts**（见下）。
- **不**移植 `outbound-deliver.ts`（`parseAndSendMediaTags`/`sendPlainReply`）——它与 fork 的 streaming/typing/markdown-images/markdown transport 架构冲突。fork 改为：在 `outbound.ts sendText` 入口检测 `hasMediaTags(text)`，命中则 `parseMediaTagsToSendQueue` 后逐项调 `sendMedia`/`sendText`，跳过 streaming。这一步需在 streaming 启动前判断。

**P1(c) — 强化远程下载**（可选，与 SSRF 配合）
- fork 入站下载仍用 shared `downloadToTempFile`，但 fork 侧新建薄包装 `utils/download.ts` 复用上游 `downloadFile` 的重试/大小预检逻辑（`image-server.ts:447-517`），内部仍调 shared 下载 + fork SSRF。**不**整体移植 `image-server.ts` 的 HTTP server（依赖 daemon 生命周期）。

**P2 — 本地 image-server（推迟）**：`image-server.ts` 与 fork 的 streaming/daemon 生命周期耦合且 fork 依赖 QQ 自抓取 URL，暂不 port。

#### fork→upstream 映射

- `sendFileQQBot` (send.ts:144) base64 路径 → 上游 `chunkedUploadAndSend` (outbound.ts:521) + `chunkedUploadC2C/Group` (chunked-upload.ts:99/226)
- `uploadC2CMedia/uploadGroupMedia` (client.ts:446/475) 透传 url → 上游 `c2cUploadPrepare` (api.ts:884) prepare→partFinish→complete
- `convertAudioToSilk` (send.ts:115) → 上游 `sendVoiceFromLocal` (outbound.ts:438) 的 SILK 前置（注意上游入站 `convertSilkToWav` 是 utils/audio-convert.ts，方向相反，勿混用）
- `formatQQBotError/normalizeHttpErrorBody` (send.ts:248-277) → 上游 `OUTBOUND_ERROR_CODES`+`resolveUserFacingMediaError` (outbound.ts:170-205)
- fork 无 file_info 缓存 → 上游 `upload-cache.ts getCachedFileInfo/setCachedFileInfo`
- fork 无标签解析 → 上游 `media-tags.ts normalizeMediaTags` + `media-send.ts parseMediaTagsToSendQueue/executeSendQueue`
- fork 入站 `downloadToTempFile`/`fetchMediaFromUrl` (shared media-io.ts:448/377) 无校验 → 上游 `downloadFile`+`validateRemoteUrl` (image-server.ts:447/ssrf-guard.ts:61)
- fork `QQBotStreamingController` (streaming.ts:33) 无媒体 → 上游 `streaming.ts` 接入 `findFirstClosedMediaTag/stripIncompleteMediaTag/sendMediaQueue` (streaming.ts:21-22,561,699,723)

### 测试计划

1. **SSRF guard 单测**（`utils/ssrf-guard.test.ts`）：`isReservedAddr` 对 127.0.0.1/10.1.2.3/172.16.5.5/192.168.1.1/169.254.169.254/0.0.0.0/::1/fe80::1/fc00::/fd00:: 返回 true，对 8.8.8.8/114.114.114.114 返回 false；`validateRemoteUrl` 对内网 IP 直接 throw、对 file:/// 协议 throw、对公网域名解析到内网时 throw（mock dns.resolve）。
2. **入站 SSRF 集成**（扩展 `bot.ts` 测试）：附件 url 指向 `http://169.254.169.254/...` 时 `resolveInboundAttachmentsForAgent` 跳过下载且记录 warn，不发起 fetch。
3. **chunked-upload 哈希**（`utils/chunked-upload.test.ts`）：`computeFileHashes` 对 < 10002432 字节文件 md5_10m == md5；对 > 10002432 字节文件 md5_10m 仅前段；mock 文件验证 md5/sha1 hex。
4. **chunked-upload 协议**：mock `c2cUploadPrepare` 返回 3 parts + concurrency 2，断言 `putToPresignedUrl` 被调用 3 次（fetch mock）+ `c2cUploadPartFinish` 调用 3 次带正确 part_index/block_size/md5 + `c2cCompleteUpload` 返回 file_info；`UploadDailyLimitExceededError` 在 bizCode 40093002 时抛出。
5. **send.ts 分片路径**（扩展 `send.test.ts`）：本地大文件（>某阈值）走 chunked 上传而非 base64（断言 `uploadC2CMedia` 未被调用、`c2cUploadPrepare` 被调用）；VOICE 先 SILK 转码再分片；失败时错误文案含 `file_too_large`/`upload_daily_limit_exceeded`。
6. **upload-cache 去重**：同 buffer 连续两次上传，第二次命中 `getCachedFileInfo`、`uploadC2CMedia` 仅调用一次；TTL 到期后重新上传。
7. **media-tags 归一化**（`utils/media-tags.test.ts`）：`<qq_img>`/`<image>`/`<pic>`/自闭合 `<qqmedia file="x"/>`/中文尖括号 `＜qqimg＞x＜/qqimg＞`/闭合不匹配 `<qqimg>x</qqvoice>` 全部归一为 `<qqimg>x</qqimg>`；代码块内 `` ``` <qqimg>x</qqimg> ``` `` 不被替换。
8. **media-send 队列**（`utils/media-send.test.ts`）：`parseMediaTagsToSendQueue("A<qqimg>p1</qqimg>B<qqvoice>p2</qqvoice>C")` 产出 [text A, image p1, text B, voice p2, text C]；`stripIncompleteMediaTag("<qqimg>p" )` 截断为 "" + hasIncomplete=true。
9. **outbound 标签路由**（扩展 `outbound.test.ts`）：`sendMedia`/`sendText` 收到含 `<qqfile>` 的文本时，拆分后逐项投递（mock sendFileQQBot），且保留 fork 的 ref-index 缓存与 file-as-followup 行为。
10. **错误码映射**：mock chunked 上传抛 `UploadDailyLimitExceededError`，`sendMedia` 返回 `error` 含主机路径+大小且 `errorCode=upload_daily_limit_exceeded`。

### 风险与注意事项

- **最大风险：上传机制结构性分歧**。fork 的 base64 透传与上游的 prepare/partFinish/complete 是不同 API 面，不能渐进合并；必须整组 port（API 函数 + 类型 + 哈希 + file-utils + platform 辅助）。port `client.ts` 时注意 fork 已有 `apiPost`/`getAccessToken` 多账户缓存（`client.ts:130`），不要重复引入上游的 token 逻辑。
- **SSRF 仅用于入站**。出站 URL 透传给 QQ 是 by-design（QQ 自抓取），若在 `send.ts:165-173` HTTP 路径加 SSRF 会改变行为、拦截 QQ 本会成功抓取的 URL。prior 已正确指出此点。
- **deliver 管线冲突**。上游 `outbound-deliver.ts` 的 sendPlainReply/markdown 图片模式/`checkMessageReplyLimit` 与 fork 的 streaming + markdown-images + markdown transport 三套机制重叠且语义不同，**不可整体移植**。只复用 `media-tags.ts`(纯文本) + `media-send.ts` 的拆分/截断函数，`executeSendQueue.onSendText` re-point 到 fork `sendText`。
- **流式标签集成是空白**。fork `QQBotStreamingController` 完全无媒体处理；若要在流式中支持内联媒体标签，需参照上游 `streaming.ts:561,699,723` 接入 `findFirstClosedMediaTag`/`stripIncompleteMediaTag`，但 fork 流式是 c2c edit 模型（上游未必一致），集成前须先确定中断-恢复语义。建议 P1 阶段流式不接标签，仅静态 sendText/sendMedia 路径支持。
- **per-type 上传大小 vs cfg.maxFileSizeMB**。上游 IMAGE 30MB/VOICE 20MB 与 fork 统一 100MB 不同；port `getMaxUploadSize` 后 fork `cfg.maxFileSizeMB` 作总闸、`getMaxUploadSize(fileType)` 作 per-type 细分，避免回归（用户现有 100MB 图片会被新 30MB 限制拒绝）。可在 config 加 `uploadSizeOverrides` 开关让用户放宽。
- **SILK 编码方向**。上游 `convertSilkToWav`（utils/audio-convert.ts）是入站解码，fork `convertAudioToSilk`（send.ts:115）是出站编码，方向相反，不可互换。
- **shared 包边界**。SSRF/下载增强做在 fork 侧或 fork utils，不要改 `packages/shared/src/media/media-io.ts`（多 channel 共用，改动影响面大）。
- **upload-cache 非真正 LRU**。上游 `upload-cache.ts` 用 Map 插入序删除「最早一半」，非 LRU recency；port 时保留语义，文档与命名勿称 LRU。

## 4.6 Voice STT/ASR + TTS + Audio Conversion

### 现状对比

**Fork 现状（结构化 channel extension，复用 shared 基础设施）：**

- STT 仅支持腾讯云 Flash ASR（极速版录音文件识别），且逻辑横跨两层：
  - shared 层 `packages/shared/src/asr/tencent-flash.ts:73-165` —— `transcribeTencentFlash({ audio: Buffer, config })`，HMAC-SHA1 签名 POST `asr.cloud.tencent.com/asr/flash/v1/{appId}`，`engine_type` 默认 `16k_zh`、`voice_format` 默认 `silk`，body 为 raw `application/octet-stream`，腾讯侧原生解码 SILK。
  - shared 层 `packages/shared/src/asr/errors.ts:1-62` —— 完整 `ASRError` 分类（`ASRTimeoutError`/`ASRAuthError`/`ASRRequestError`/`ASRResponseParseError`/`ASRServiceError`/`ASREmptyResultError`，含 `kind/provider/retryable`）。
  - 插件层 `extensions/qqbot/src/bot.ts:876-916` `resolveInboundAttachmentsForAgent()`：对 `isVoiceAttachment()` 的附件直接 `fetchMediaFromUrl(att.url)` 拿 `Buffer` → `transcribeTencentFlash()`，**不做 SILK→WAV 本地转换**。语音附件不落盘、不转换，raw SILK 直送腾讯。
- 配置 `extensions/qqbot/src/config.ts:62-69`（`QQBotAccountSchema.asr = { enabled, appId, secretId, secretKey }`）+ `config.ts:304-318` `resolveQQBotASRCredentials()`；JSON Schema 在 `channel.ts:149-158` 与 `204-213`（顶层 + accounts.*）。
- **无 TTS 合成**。`extensions/qqbot/src/bot.ts:1427-1432` 仅有 `DIRECTIVE_TAG_RE` / `VOICE_EMOTION_TAG_RE` / `TTS_LIKE_RAW_TEXT_RE` 正则，在 `sanitizeQQBotOutboundText()`（bot.ts:1469-1490）里把 `[[tts:text]]`/`[[/tts:text]]`/`[[audio_as_voice]]`/`[[reply_to_current]]` 及情感 tag **剥离**（无副作用，纯文本清理）。`shouldSuppressQQBotTextWhenMediaPresent()`（bot.ts:1502-1509）用 `TTS_LIKE_RAW_TEXT_RE` 判定“当媒体存在时压掉这段文本”。
- 出站语音只有“已有本地音频文件→SILK”这一条硬路径：`extensions/qqbot/src/send.ts:115-142` `convertAudioToSilk()` **硬依赖 `ffmpeg-static`**（缺失即 `throw new Error("ffmpeg-static not found")`，send.ts:117-119），用 `execFileSync` 转出 PCM s16le 24kHz 单声道，再 `silk-wasm.encode`。send.ts:177-187 对 `MediaFileType.VOICE` 的本地文件走此路径，失败回退到 `readMedia` 原始上传。
- ASR 失败 UX：`bot.ts:816-820` `buildVoiceASRFallbackReply()` + `VOICE_ASR_FALLBACK_TEXT`（“当前语音功能未启动或识别失败，请稍后重试。”），`bot.ts:3117-3134` 在有语音附件但无 transcript 时下发这段中文兜底（含截断的 `asrErrorMessage`，上限 500 字）。
- 附件类型 `extensions/qqbot/src/types.ts` `QQInboundAttachment = { url, filename?, contentType?, size? }` —— **没有** `voice_wav_url` / `asr_refer_text` 字段。
- ref-index 已经支持 `transcriptSource?: "stt"|"asr"|"tts"|"fallback"`（`ref-index-store.ts:12`，bot.ts:1005 写 `"asr"`，outbound.ts:231 写 `"tts"`）。

**上游现状（自包含 daemon plugin，逻辑全部在插件内）：**

- STT `src/stt.ts:26-86`：`resolveSTTConfig()` 两级回退 —— 1) `channels.qqbot.stt { provider, model, baseUrl, apiKey, enabled }`（`provider` 默认 `"openai"`，从 `models.providers[provider]` 继承 `baseUrl/apiKey`，`model` 默认 `whisper-1`）；2) 回退 `tools.media.audio.models[0]`；3) 任何 OpenAI 兼容 `/audio/transcriptions` multipart 端点。**注意**：`transcribeAudio(audioPath)`（stt.ts:58-86）按扩展名设 MIME，并不强制 WAV；WAV 强制来自 `inbound-attachments.ts:285` 的 `convertSilkToWav` 预处理。
- TTS `src/utils/audio-convert.ts:210-430`：`resolveTTSConfig()` 两级回退（1) `channels.qqbot.tts` → 2) `messages.tts` 且 `auto !== "disabled"`，见 audio-convert.ts:248-271），支持 Azure `authStyle:"api-key"` + `queryParams`（如 `api-version`）+ `speed`；`textToSpeechPCM()`（audio-convert.ts:296-399）先 PCM（最高质量、免二次转码）失败回退 mp3，mp3 再 ffmpeg→PCM 或 WASM `mpg123-decoder` 解码；`textToSilk()`（audio-convert.ts:417-430）链式 TTS→PCM→`silk-wasm.encode`→写 `.silk` 文件 + 返回 base64/duration。
- 音频转换 `src/utils/audio-convert.ts`（887 行）：silk-wasm 动态 `import()`（audio-convert.ts:10-26，缺失则降级）、`isSilk`/`isSilkFile` 魔数检测、`stripAmrHeader`（去除 `#!AMR\n` 6 字节头，audio-convert.ts:83-89）、`convertSilkToWav`（audio-convert.ts:98-138，24kHz decode→`pcmToWav`）、`pcmToSilk`（audio-convert.ts:401-415）、`audioFileToSilkBase64`（audio-convert.ts:450-545）/`audioFileToSilkFile`（audio-convert.ts:555-602）多层 fallback：QQ 原生 WAV/MP3/SILK 直传 → ffmpeg（`detectFfmpeg` 跨平台，platform.ts:242）→ WASM `mpg123-decoder` MP3 fallback → `parseWavFallback` 手工 WAV 解析（audio-convert.ts:822-886）→ `.pcm` 透传。`shouldTranscodeVoice()`（audio-convert.ts:194-206）MIME+扩展名双重判定。`waitForFile()`（audio-convert.ts:618-684）轮询。
- 入站 `src/inbound-attachments.ts:83-321` 三阶段并行：并行下载 → `processVoiceAttachment()` 优先用 `voice_wav_url`（直下 WAV 跳过 SILK→WAV，inbound-attachments.ts:112-129/261-262）否则 `convertSilkToWav()` → `transcribeAudio()`，全程 `asr_refer_text` 兜底（STT 未配置/空/失败时回退，inbound-attachments.ts:272-320）。`formatVoiceText()`（inbound-attachments.ts:238-243）输出 `[语音消息] ...`。
- 出站 TTS 接线 `src/reply-dispatcher.ts:205-237` `handleAudioPayload()`：`resolveTTSConfig()` → `textToSilk()` → `sendC2CVoiceMessage`/`sendGroupVoiceMessage`（api.ts:1135/1144）。出站语音转码 `src/outbound.ts:411-479` `sendVoice()`：`shouldTranscodeVoice()` 判定 → `audioFileToSilkFile()`，受 `audioFormatPolicy.transcodeEnabled`（types.ts:183-203）控制，`@deprecated voiceDirectUploadFormats`（types.ts:99-102）兼容。

### 差距清单

上游有而 fork 缺失的具体能力（字段/命令/文件名）：

1. **Provider/model 化 STT**：`channels.qqbot.stt.{provider,model,baseUrl,apiKey,enabled}` + `tools.media.audio.models[0]` 回退 + `models.providers[provider]` 继承 —— fork 硬编码腾讯 Flash ASR。
2. **OpenAI 兼容 STT 端点**（`/audio/transcriptions` multipart/form-data，`file`+`model`）—— fork 用腾讯 HMAC 签名 octet-stream。
3. **完整 TTS 合成管线**：`resolveTTSConfig`、`textToSpeechPCM`（PCM→mp3、Azure `authStyle:"api-key"`/`queryParams`/`speed`）、`textToSilk` —— fork **零 TTS 合成**，只有 `[[tts:]]` tag 剥离正则。
4. **reply-dispatcher `handleAudioPayload`**：把 TTS 输出真正发成语音消息（`silkPath`/`silkBase64`/`duration`）—— fork 的 `[[tts:]]` 不产生任何音频。
5. **不硬依赖 ffmpeg 的多层音频 fallback**：silk-wasm 动态 import + `isSilk` 魔数、`stripAmrHeader`、`convertSilkToWav`、WAV/MP3/SILK 直传短路、`mpg123-decoder` WASM MP3 fallback、`parseWavFallback` 手工 WAV、`.pcm` 透传 —— fork 的 send.ts:115-142 硬依赖 `ffmpeg-static`，缺失即抛错。
6. **入站三阶段并行管线 + `convertSilkToWav` 预处理** —— fork 把 raw SILK 直送腾讯（这对腾讯 OK，但切到 OpenAI 路径会断）。
7. **`voice_wav_url` 附件字段**（直下 WAV 跳过转换）和 **`asr_refer_text` 兜底**（QQ 事件内置识别文本）—— fork 的 `QQInboundAttachment` 无此两字段。
8. **`AudioFormatPolicy` 配置**（`sttDirectFormats`/`uploadDirectFormats`/`transcodeEnabled`，types.ts:183-203）+ `@deprecated voiceDirectUploadFormats` 兼容（types.ts:99-102）—— fork 无。
9. **`shouldTranscodeVoice()` MIME+扩展名双重判定**、`audioFileToSilkFile`（供分片上传）。
10. **`waitForFile()` 轮询**（出站 TTS 异步文件就绪）。

### 必须保留

China-fork 在本子系统必须存活的能力：

- **腾讯云 Flash ASR 直连**（`packages/shared/src/asr/tencent-flash.ts` + `errors.ts`）：`transcribeTencentFlash` 的 HMAC-SHA1 签名、`asr.{appId,secretId,secretKey}` 配置、`engine_type`/`voice_format` 参数、`ASRError` 分类树（含 `kind/provider/retryable`）—— 作为 China 专属 STT provider 保留，**不能被 OpenAI provider 替换/覆盖**。这是国内网络下唯一可用的低延迟 ASR。
- **raw-buffer 直送路径**：腾讯 provider 接收 `Buffer`（SILK 原样），不做本地 SILK→WAV 转换 —— 这是腾讯原生 SILK 解码器的前提，与上游 OpenAI 路径（必须 WAV）本质不同。
- `resolveQQBotASRCredentials()`（config.ts:304-318）与 `asr.{enabled,appId,secretId,secretKey}` schema（config.ts:62-69 / channel.ts:149-158,204-213）—— 作为 provider 路由的一路输入保留，需新增向后兼容 reader。
- `buildVoiceASRFallbackReply()` + `VOICE_ASR_FALLBACK_TEXT` + `asrErrorMessage` 截断（bot.ts:816-820,662-664,3117-3134）—— 中文兜底回复 UX，上游用 `[语音消息...]` 占位符，行为不同，**不能被 wholesale 采用 inbound-attachments.ts 时丢掉**。
- `[[tts:...]]`/`[[/tts:...]]`/`[[audio_as_voice]]`/`[[reply_to_current]]` tag 正则（bot.ts:1427-1432）—— fork 的入站/出站文本清理依赖它们；port TTS 后这些 tag 应从“纯剥离”升级为“触发 TTS 合成”。
- ref-index `transcriptSource` 四态（`stt`/`asr`/`tts`/`fallback`，ref-index-store.ts:12）—— 已与上游兼容（上游 `TranscriptSource = "stt"|"asr"|"fallback"`，无 `tts`，但 fork 的更宽，保留即可）。
- 复用 shared 的 `fetchMediaFromUrl` / `downloadToTempFile` / `readMedia`（`packages/shared/src/media/media-io.ts`）做媒体下载 —— 不引入上游 `downloadFile`（image-server.ts，daemon 专属）。

### 实施方案

总策略：把上游 `src/utils/audio-convert.ts`（887 行）作为 **shared 音频基础设施** 下沉到 `packages/shared/src/audio/`（新建），并改造上游 `src/stt.ts` 为 provider-dispatch 架构，把腾讯 Flash ASR 注册为一等 provider。**禁止**把上游 daemon 模块原样拷进插件——必须走 fork 的 contracts（`fetchMediaFromUrl`/`downloadToTempFile`/`uploadC2CMedia`/`sendC2CMediaMessage`）与 shared。

**1. 新建 `packages/shared/src/audio/`（shared 音频层）**

- `packages/shared/src/audio/audio-convert.ts`：移植上游 `src/utils/audio-convert.ts` 全部纯逻辑——silk-wasm 动态 import（`loadSilkWasm`/`isSilkSync`）、`stripAmrHeader`、`pcmToWav`、`convertSilkToWav`、`pcmToSilk`、`audioFileToSilkBase64`/`audioFileToSilkFile`、`shouldTranscodeVoice`、`isVoiceAttachment`/`isAudioFile`、`waitForFile`、`parseWavFallback`、`wasmDecodeMp3ToPCM`、`normalizeFormats`。
- `packages/shared/src/audio/ffmpeg.ts`：移植上游 `platform.ts:242-290` `detectFfmpeg()`（`which`/`where` + 常见安装路径），以及 `ffmpegToPCM()`（execFile pipe:1 s16le 24kHz mono，Windows `windowsHide:true`/`encoding:"buffer"`）。这是 fork 当前缺失的跨平台 ffmpeg 探测——替代 send.ts 的 `ffmpeg-static` 硬依赖。
- `packages/shared/src/audio/index.ts`：re-export 全部。
- `packages/shared/src/index.ts`：新增 `export * from "./audio/index.js"`。
- 依赖：在 `packages/shared/package.json` 加 `silk-wasm ^3.7.1`（必装）、`mpg123-decoder ^1.0.3`（必装，MP3 WASM fallback）。移除 fork `extensions/qqbot/package.json` 的 `ffmpeg-static`（被 `detectFfmpeg` 替代），silk-wasm 上提到 shared。

**2. 改造 `packages/shared/src/asr/` 为 provider-dispatch（保留腾讯 + 新增 OpenAI）**

- `packages/shared/src/asr/index.ts`：新增 `transcribe(params: { source: "buffer" | "file", audio: Buffer | string, provider: "tencent-flash" | "openai", config })` dispatcher；`provider:"tencent-flash"` 走 raw buffer 直送（保留 tencent-flash.ts 不变），`provider:"openai"` 走新增 `openai-stt.ts`（移植上游 stt.ts:58-86 `transcribeAudio`，但接收 `Buffer` + fileName，构造 multipart/form-data，避免插件侧 `fs.readFileSync`）。
- 复用 `errors.ts` 现有 `ASRError` 树：OpenAI provider 的 HTTP/parse 错误映射到 `ASRRequestError`/`ASRResponseParseError`/`ASREmptyResultError`，保持统一 taxonomy。
- `resolveSTTConfig` 不放 shared（它读 `channels.qqbot.*`/`tools.media.*`/`models.providers.*`，是插件配置语义），放插件侧 `extensions/qqbot/src/stt.ts`（新建），新增 `provider:"tencent-flash"` 分支：当 `asr.enabled && appId/secretId/secretKey` 齐全时返回 `{ provider:"tencent-flash", appId, secretId, secretKey }`，否则走上游两级回退返回 `{ provider:"openai", baseUrl, apiKey, model }`。

**3. 配置迁移（`extensions/qqbot/src/config.ts` + `channel.ts`）**

- `QQBotAccountSchema`（config.ts:55-99）保留 `asr`，**新增** `stt`（`{ enabled?, provider?, model?, baseUrl?, apiKey? }`）与 `tts`（`{ enabled?, provider?, model?, baseUrl?, apiKey?, voice?, authStyle?, queryParams?, speed? }`）与 `audioFormatPolicy`（`{ sttDirectFormats?, uploadDirectFormats?, transcodeEnabled? }`）。
- `resolveQQBotASRCredentials()`（config.ts:304-318）保留；新增 `resolveQQBotSTTProvider()`（优先 `stt.*`，回退 `asr.*`→腾讯 provider，再回退 `tools.media.audio.models[0]`→OpenAI）+ `resolveQQBotTTSConfig()`（优先 `tts.*`，回退 `messages.tts`）。提供 `asr.*`→`stt.provider:"tencent-flash"` 的向后兼容 reader，老配置无需改动即可工作。
- `channel.ts:149-158,204-213` JSON Schema 同步加 `stt`/`tts`/`audioFormatPolicy`/`voiceDirectUploadFormats`。

**4. 入站语音改造（`extensions/qqbot/src/bot.ts` `resolveInboundAttachmentsForAgent` 876-916）**

- `QQInboundAttachment`（types.ts）加 `voice_wav_url?` / `asr_refer_text?`（从 QQ 事件解析处填充）。
- 按 provider 分流：`provider:"tencent-flash"` 保持现状（`fetchMediaFromUrl`→raw buffer→`transcribeTencentFlash`）；`provider:"openai"` 先 `downloadToTempFile` 落盘 → 若 `voice_wav_url` 存在直下 WAV 跳过转换，否则 `convertSilkToWav()`（shared）→ `transcribe(... provider:"openai")`。
- 引入 `asr_refer_text` 兜底（STT 空/失败时回退，transcriptSource=`"asr"`），**但保留** `buildVoiceASRFallbackReply()` 中文兜底作为 `asr_refer_text` 也不存在时的最终用户提示（bot.ts:3117-3134 不动，只扩展触发条件）。
- 可选：多附件改并行（`Promise.all`，对齐上游三阶段，但 fork 现为串行 for-loop，非必须，列为 nice-to-have）。

**5. 出站 TTS 接线（新建 `extensions/qqbot/src/tts.ts` + 改 bot.ts/outbound.ts）**

- 新建 `extensions/qqbot/src/tts.ts`：移植上游 `resolveTTSConfig`（audio-convert.ts:248-271，从 channels.qqbot.tts / messages.tts 解析）、`buildTTSRequest`、`textToSpeechPCM`（audio-convert.ts:296-399），用 shared 的 `detectFfmpeg`/`pcmToSilk`。`textToSilk` 落盘到 `~/.openclaw/media/qqbot/tts/`。
- bot.ts 的 `[[tts:text]]`/`[[audio_as_voice]]` 解析从“纯剥离”升级：在 `sanitizeQQBotOutboundText` 之前**抽取** tts 文本与 audio-as-voice 标志，若 `resolveQQBotTTSConfig()` 命中则调 `textToSilk()` 产出 SILK，走 `send.ts` 的 `uploadQQBotFile(fileType:VOICE)` + `sendC2CMediaMessage`/`sendGroupMediaMessage`（fork 已有的 client.ts:446-556 原语，**不**引入上游 `sendC2CVoiceMessage`/`sendGroupVoiceMessage`，避免重复实现）。
- `convertAudioToSilk()`（send.ts:115-142）**替换**为 shared 的 `audioFileToSilkFile()`（多层 fallback、不硬依赖 ffmpeg-static），保留 `MediaFileType.VOICE` 上传路径不变。

**6. 出站格式策略**：`send.ts` 的 VOICE 分支读 `audioFormatPolicy.uploadDirectFormats ?? [".wav",".mp3",".silk"]` 与 `transcodeEnabled`，`shouldTranscodeVoice()` 判定直传 vs 转码。

### 测试计划

1. **腾讯 provider 回归（必须不破）**：配 `asr.enabled+appId+secretId+secretKey`，发一条 SILK `.amr` 语音，断言走 raw-buffer 路径（不触发 `convertSilkToWav`）、transcriptSource=`"asr"`、`transcribeTencentFlash` 被调用一次、mock fetch 收到 `application/octet-stream` body。
2. **OpenAI provider 新增**：配 `stt.provider:"openai"+baseUrl+apiKey`，发 `.amr` SILK 语音，断言先 `convertSilkToWav` 生成 `.wav`、再 multipart POST `/audio/transcriptions`（`file`+`model:"whisper-1"`）、transcriptSource=`"stt"`。
3. **`voice_wav_url` 短路**：附件带 `voice_wav_url`，OpenAI provider 下断言不调用 `convertSilkToWav`、直接用 WAV 送 STT。
4. **`asr_refer_text` 兜底**：STT 返回空且附件有 `asr_refer_text`，断言 transcript=`asr_refer_text`、source=`"asr"`；STT 空 + 无 `asr_refer_text` + 腾讯 provider，断言触发 `buildVoiceASRFallbackReply`（中文兜底文本）。
5. **配置兼容**：老配置仅有 `asr.*`（无 `stt`/`tts`），断言 `resolveQQBotSTTProvider()` 返回 `provider:"tencent-flash"`，行为与升级前完全一致。
6. **TTS 合成**：配 `tts.provider:"openai"+baseUrl+apiKey+voice`，模型输出含 `[[tts:你好]]`，断言 `textToSpeechPCM` 被调（PCM 成功）、产出 `.silk` 经 `uploadC2CMedia(VOICE)` + `sendC2CMediaMessage` 发出、ref-index 记 `transcriptSource:"tts"`。
7. **TTS Azure 风格**：`tts.authStyle:"api-key"`+`queryParams:{api-version:...}`，断言 header 含 `api-key`、URL 带 `?api-version=`。
8. **TTS PCM 不支持回退**：mock `/audio/speech` 对 `response_format:"pcm"` 返回 400，断言自动重试 `mp3` 并经 ffmpeg/WASM 解码为 PCM 再 encode SILK。
9. **ffmpeg 缺失降级（shared 新能力）**：`detectFfmpeg()` 返回 null，发一条 `.ogg` 语音出站，断言走 WASM `parseWavFallback`/`mpg123-decoder` 路径而非抛 `ffmpeg-static not found`（修复 send.ts:117-119 旧硬依赖）。
10. **`shouldTranscodeVoice`**：`.wav`/`.mp3`/`.silk` 断言 `false`（直传），`.ogg`/`.m4a` 断言 `true`（转码）；`transcodeEnabled:false` + `.ogg` 断言 fallback 到文件发送/错误而非崩溃。
11. **silk-wasm 可选降级**：模拟 silk-wasm import 失败，断言 `loadSilkWasm()` 返回 null、语音编解码禁用且日志告警（不抛 fatal）。
12. **AMR 头剥离**：构造 `#!AMR\n`+SILK magic 的 buffer，断言 `stripAmrHeader` 后 `isSilk` 为 true 并正确 decode。

### 风险与注意事项

- **最高风险：STT provider 切换会改变入站语音语义**。腾讯路径要 raw SILK buffer（无本地转换），OpenAI 路径要 WAV（必须 `convertSilkToWav`）。dispatcher 必须按 provider 严格分流，**禁止**对腾讯 provider 也强制走 `convertSilkToWav`——否则破坏国内现网可用性。务必保留测试 1、2 分别验证两条路径。
- **TTS 是纯新增**，但依赖整条音频转换管线落地 + silk-wasm/mpg123-decoder 新依赖（shared package.json）。需评估 shared 作为多 channel 共享包引入这两个 dep 的影响面（其他 channel 是否需要）。
- **`ffmpeg-static` 移除**影响现有 `send.ts:115-142` 行为：替换为 `detectFfmpeg()` 后，从“找不到 ffmpeg-static 就抛错”变为“探测系统 ffmpeg，找不到走 WASM fallback”——这是行为变化，需在 README/changelog 说明，且 CI 要覆盖 ffmpeg 缺失场景（测试 9）。
- **上游 `downloadFile`/`image-server.ts` 不可复用**（daemon 专属图床/下载），必须用 shared 的 `downloadToTempFile`/`fetchMediaFromUrl`；签名（`sourceFileName`/`tempDir`/`tempPrefix`，media-io.ts:448-463）与上游 `downloadFile({destDir,timeoutMs})` 不同，移植 inbound-attachments.ts 时要改适配层。
- **不引入上游 `sendC2CVoiceMessage`/`sendGroupVoiceMessage`**（api.ts:1135/1144）——fork 已有 `uploadC2CMedia(VOICE)`+`sendC2CMediaMessage` 等价路径（client.ts:446-556），引入会重复。
- **ref-index `TranscriptSource` 上游是三态、fork 四态**（多 `tts`）——保留 fork 四态，上游 inbound-attachments 的 `"fallback"` 写入与 fork ref-index-store.ts:244-249 的分支已兼容，无需改动。
- **`asr_refer_text` / `voice_wav_url` 的来源**：fork 当前 `QQInboundAttachment` 从 QQ 事件解析（bot.ts 解析处），需确认 QQ 官方事件 payload 是否实际下发这两字段；若不下发，则仅作为“有则用”的可选增强，不影响主路径。

## 4.7 Group Chat Fine-Tuning (per-group requireMention/toolPolicy/prompt/historyLimit)

### 现状对比

**Fork 现状（@openclaw-china/qqbot 2026.3.9-1）** — 群行为完全是账户级（account-level）扁平字段，无任何按群（per-group）覆盖：

- `QQBotAccountSchema`（`extensions/qqbot/src/config.ts:55-99`）定义了 4 个群相关字段，全部挂在账户上：
  - `groupPolicy: open|allowlist|disabled`，默认 `open`（`config.ts:82`）
  - `requireMention: boolean`，默认 `true`（`config.ts:83`）
  - `groupAllowFrom: string[]`（`config.ts:85`）
  - `historyLimit: integer>=0`，默认 `10`（`config.ts:86`）—— **dead config，运行时从不读取**（`bot.ts` 全文 grep `historyLimit` 仅命中 schema/resolve 工具函数，`shouldHandleMessage` 与 `dispatchToAgent` 均不使用）。
- 群门控完全委托给 shared 包的 `checkGroupPolicy`（`packages/shared/src/policy/group-policy.ts:54-93`），在 `shouldHandleMessage`（`bot.ts:3829-3861`）中调用：`checkGroupPolicy({ groupPolicy, conversationId, groupAllowFrom, requireMention, mentionedBot })`。
- 关键：`parseGroupMessage`（`bot.ts:1096-1118`）**硬编码 `mentionedBot: true`**（`bot.ts:1116`）并把原始 `mentions[]` 数组、`message_type`、`msg_elements`（引用消息）全部丢弃。`QQInboundMessage`（`types.ts:46-62`）只有布尔 `mentionedBot`，无 `mentions`/`refMsgIdx`/`messageType` 字段。`parseChannelMessage`（`bot.ts:1120-1144`）同样硬编码 `mentionedBot: true`（`bot.ts:1142`）。
- `buildInboundContext`（`bot.ts:2929-2970`）直接 `WasMentioned: event.mentionedBot`（`bot.ts:2965`），无 implicit-mention / activation / bypass 逻辑；`GroupSubject` 直接取 `event.groupOpenid`/`channelId`（`bot.ts:2959`），无 group name 解析。
- `InboundContext`（`types.ts:64-89`）**没有** `GroupSystemPrompt`/`extraSystemPrompt`/`ToolPolicy` 字段；`dispatchToAgent`（`bot.ts:2972-3998`）通过 `replyApi.dispatchReplyWithDispatcher`/`dispatchReplyWithBufferedBlockDispatcher`/`dispatchReplyFromConfig` 传入 `finalCtx`（`bot.ts:3701/3721/3766`），不携带任何群级行为提示或工具策略。
- `channel.ts`（`extensions/qqbot/src/channel.ts`）**未注册** `groups` 适配器（全文无 `groups:`/`resolveRequireMention`/`resolveToolPolicy`）；也未注册 `mentions` 适配器。
- `openclaw.plugin.json` 与 `channel.ts configSchema`（`channel.ts:134-249`）的账户级 schema 含 `requireMention`/`groupPolicy`/`groupAllowFrom`/`historyLimit`，但无 `groups` map、无 `defaultRequireMention`、无 per-group 子对象。

**上游现状（@tencent-connect/openclaw-qqbot v1.7.2）** — 完整的按群解析引擎 + 历史缓存 + 统一门控：

- 类型：`GroupConfig`（`upstream/src/types.ts:44-60`）含 `requireMention`、`ignoreOtherMentions`、`toolPolicy: full|restricted|none`、`name`、`prompt`、`historyLimit`；`QQBotAccountConfig`（`types.ts:74-152`）新增 `groups: Record<groupOpenid, GroupConfig>`（`types.ts:91`，`"*"` 为通配符）与账户级 `defaultRequireMention`（`types.ts:137`）。
- 解析器族（`upstream/src/config.ts`）：`resolveGroupConfig`（`config.ts:128-145`）实现 4 级优先链 `specific group > "*" > account.defaultRequireMention > 硬编码默认`；派生 `resolveRequireMention`(161)、`resolveIgnoreOtherMentions`(166)、`resolveToolPolicy`(171)、`resolveHistoryLimit`(148)、`resolveGroupPrompt`(153)、`resolveGroupName`(176)；`DEFAULT_GROUP_HISTORY_LIMIT=50`（`config.ts:82`）、`DEFAULT_GROUP_CONFIG`（`config.ts:84-90`，`toolPolicy:"restricted"`）、`DEFAULT_GROUP_PROMPT`（`config.ts:93-97`，bot-vs-human 防抢答 PE）；`resolveMentionPatterns`（`config.ts:16-33`，agent > global > []）；`isGroupAllowed`（`config.ts:112-123`，内联 `evaluateMatchedGroupAccessForPolicy` `config.ts:47-69`）。
- 群历史缓存 `group-history.ts`：内存 `Map<groupOpenid, HistoryEntry[]>`，`MAX_HISTORY_KEYS=1000` LRU；`recordPendingHistoryEntry`/`buildPendingHistoryContext`/`clearPendingHistory`；`formatAttachmentTags`（MEDIA: 标签统一入口，`group-history.ts:156-191`）；`AttachmentSummary`/`toAttachmentSummaries`/`formatMessageContent`。
- 统一门控 `message-gating.ts`：`resolveGroupMessageGate`（`message-gating.ts:129-190`）三层串行 `drop_other_mention > block_unauthorized_command > skip_no_mention > pass`；`resolveMentionGating`/`resolveMentionGatingWithBypass`。
- gateway 接线（`upstream/src/gateway.ts:1082-1214`）：`isGroupAllowed` → `detectWasMentioned`(mentionPatterns) → `resolveRequireMention` + `resolveGroupActivation`(session store `/activation`) → `resolveImplicitMention`(refMsgIdx→isBot) → `resolveGroupMessageGate` → 命中 `drop`/`skip` 时 `recordPendingHistoryEntry`；`pass` 时 `wasMentioned=effectiveWasMentioned`，注入 `groupSystemPrompt = resolveGroupIntroHint + resolveGroupPrompt`（`gateway.ts:1203-1214`）；历史注入 `buildPendingHistoryContext`（`gateway.ts:1289-1313`）。helper：`hasAnyMention`(279)、`resolveImplicitMention`(296)、`resolveGroupActivation`(309)、`hasControlCommand`(246，委托 `runtime.channel.text.hasControlCommand`)、`shouldHandleTextCommands`(267)。
- channel `groups` SDK 适配器（`upstream/src/channel.ts:84-113`）：`resolveRequireMention`/`resolveToolPolicy`（映射 full→undefined / none→{allow:[],deny:["*"]} / restricted→{allow:[]}）/`resolveGroupIntroHint`。

### 差距清单（upstream 有、fork 缺）

1. **per-group `groups: Record<groupOpenid, GroupConfig>` 配置 map**（`types.ts:91`）—— fork 完全没有；fork 只有账户级扁平字段。
2. **4 级 requireMention 优先链**（specific > `*` > `defaultRequireMention` > 默认，`config.ts:128-145`）—— fork 仅单一账户级 `requireMention`，无覆盖层级。
3. **账户级 `defaultRequireMention`**（`types.ts:137`）—— fork 用 `requireMention` 同名同语义但无优先级链。
4. **`ignoreOtherMentions`**（drop @ 了他人但未 @bot 的消息）—— message-gating Layer 1（`message-gating.ts:142-154`）+ GroupConfig 字段；fork 无。
5. **per-group `toolPolicy: full|restricted|none`** 映射为 `{allow,deny}`（`channel.ts:92-100`，SDK `GroupToolPolicyConfig` `sdk.d.ts:389-392`）—— fork 无。
6. **per-group `prompt`（行为 PE）** 经 `resolveGroupPrompt`（`config.ts:153-158`）注入 groupSystemPrompt，含 bot-vs-human 防抢答差异化（`gateway.ts:1200-1214`）—— fork 无 groupSystemPrompt 通道。
7. **per-group `historyLimit`** 经 `resolveHistoryLimit`（`config.ts:148-150`）—— fork 定义了 `historyLimit` 但运行时 dead。
8. **群历史 LRU 缓存模块** `group-history.ts`（record/build/clear，MAX_HISTORY_KEYS=1000）—— fork 无；非@群消息不被缓存/注入。
9. **统一群消息门控** `resolveGroupMessageGate`（drop/block/skip/pass）—— fork 仅 shared `checkGroupPolicy`（open/allowlist/disabled + requireMention）。
10. **implicit-mention（引用回复 bot）** `resolveImplicitMention`（`gateway.ts:296-303`，依赖 refMsgIdx + ref-index isBot）—— fork 无（但 `ref-index-store.ts` 已有 `isBot`/`getRefIndex` 可复用）。
11. **`/activation` session-state requireMention 覆盖** `resolveGroupActivation`（`gateway.ts:309+`，读 session store）—— fork 无。
12. **`groups` SDK 适配器注册**（resolveRequireMention/resolveToolPolicy/resolveGroupIntroHint）—— fork channel.ts 无。
13. **per-group `name` 解析** `resolveGroupName`（`config.ts:176-179`，用于 group system-prompt hint + sender label）—— fork 无（直接用 openid）。
14. **`mentionPatterns` 解析**（agent > global > []，`config.ts:16-33`）—— fork 无。
15. **`hasAnyMention`/`hasControlCommand`/`shouldHandleTextCommands`** 辅助（`gateway.ts:279/246/267`）—— fork 无。

### 必须保留（China-fork 特性，port 时不得丢失）

1. **`parseGroupMessage` 硬编码 `mentionedBot:true` 的 QQ 平台事实**：QQ 开放平台只下发 `GROUP_AT_MESSAGE_CREATE`（必然已 @bot），fork 据此省略了 `detectWasMentioned`。port 上游门控时，`wasMentioned` 仍应以 QQ 事件保证为 true 为主，新增的 `ignoreOtherMentions`/`hasAnyMention`/implicit-mention 仅在能拿到 `mentions[]`/`refMsgIdx` 时生效——不能把 `mentionedBot` 改回 false 导致所有群消息被 skip。
2. **shared 包 `checkGroupPolicy` 复用**：fork 的 `disabled`/`allowlist`/`open` 三态与 shared `checkGroupPolicy`（`packages/shared/src/policy/group-policy.ts`）行为一致。port 时 `isGroupAllowed` 应**继续委托 shared 引擎**（或调用 shared `checkGroupPolicy`），不要复制上游内联的 `evaluateMatchedGroupAccessForPolicy`（那是上游因 dist 未导出而内联的；fork 已有 shared 导出，属重复）。
3. **fork 的 `formatAttachmentTags`/MEDIA: 标签风格与 displayAliases/known-targets/ref-index 的整合**：若 port group-history.ts，其 `formatAttachmentTags` 必须与 fork 现有附件标签风格一致（fork 的 `resolveInboundAttachmentsForAgent` `bot.ts:822+`、`ref-index-store.RefAttachmentSummary` 已使用 MEDIA: 风格），避免双套标签。
4. **CN 默认文案**：上游 `DEFAULT_GROUP_PROMPT`（`config.ts:93-97`）已是中文防抢答 PE，可直接采用；但 fork 现有账户级默认提示若存在 CN 差异，port 后保留 fork 的措辞或显式合并。
5. **`groupPolicy` 默认值**：fork schema 默认 `open`（`config.ts:82`），fork `security.collectWarnings`（`channel.ts:326-333`）在 `open` 时告警。上游 `DEFAULT_GROUP_POLICY="open"`（`config.ts:79`）。port 后保持默认 `open` 以避免行为变更，且保留 `collectWarnings` 告警逻辑。
6. **多账户配置合并**：fork 的 `mergeQQBotAccountConfig`（`config.ts:270-285`）做 base+account 合并；新增 `groups`/`defaultRequireMention` 必须纳入合并语义（account 级 groups 覆盖 base 级 groups，或深合并——需明确策略）。
7. **`InboundContext` 契约稳定性**：fork 通过 `finalizeInboundContext` SDK hook（`bot.ts:3221-3224`）让 core 加工 ctx。新增 groupSystemPrompt/toolPolicy 不应破坏现有 `InboundContext` 字段集；优先通过新增可选字段 + `finalizeInboundContext` 注入，而非重写 ctx。

### 实施方案

**总原则**：这是 capability port，不是文件 rebase。上游 `group-history.ts`/`message-gating.ts` 是自包含纯函数模块，可**近乎原样移植**到 fork 的 `extensions/qqbot/src/`（它们不依赖 openclaw/plugin-sdk，仅依赖注入的回调）；但 `config.ts` 解析器族与 `channel.ts` 适配器必须改写为读取 fork 的 `QQBotAccountConfig`（来自 `mergeQQBotAccountConfig`）而非上游的 `OpenClawConfig`。

**Step 1 — 类型与 schema（`extensions/qqbot/src/config.ts` + `types.ts`）**
- 在 `config.ts` 新增 `ToolPolicy = "full"|"restricted"|"none"`、`GroupConfig`（requireMention/ignoreOtherMentions/toolPolicy/name/prompt/historyLimit）、`GroupPolicy`（已有 zod enum，复用）。
- 在 `QQBotAccountSchema`（`config.ts:55-99`）新增：`defaultRequireMention: z.boolean().optional().default(true)`、`groups: z.record(z.string(), GroupConfigSchema).optional()`。保留现有 `requireMention` 作为**向后兼容别名**（port 时映射到 `defaultRequireMention`，见 fork→upstream map）。
- `GroupConfigSchema` 用 zod：`requireMention?: boolean`、`ignoreOtherMentions?: boolean`、`toolPolicy?: z.enum(["full","restricted","none"])`、`name?: string`、`prompt?: string`、`historyLimit?: z.number().int().min(0)`。
- 同步 `channel.ts configSchema`（`channel.ts:134-249`）顶层与 `accounts.*` 两处均加 `defaultRequireMention` + `groups`（JSON Schema 形式，与上游 channel 一致），并同步 `openclaw.plugin.json configSchema`。

**Step 2 — 解析器族（新建 `extensions/qqbot/src/group-config.ts`，避免污染 config.ts）**
- 移植上游 `resolveGroupConfig`/`resolveRequireMention`/`resolveIgnoreOtherMentions`/`resolveToolPolicy`/`resolveHistoryLimit`/`resolveGroupPrompt`/`resolveGroupName`（上游 `config.ts:128-179`），但签名改为接收 `QQBotAccountConfig`（fork 的合并后账户配置）而非 `OpenClawConfig`：
  - `resolveGroupConfig(account: QQBotAccountConfig, groupOpenid: string): ResolvedGroupConfig`。
  - 4 级链不变：`specific > "*" > account.defaultRequireMention ?? account.requireMention ?? true > 默认`（**关键：fork 的扁平 `requireMention` 作为 `defaultRequireMention` 的 fallback**，保证旧配置向后兼容）。
  - `DEFAULT_GROUP_HISTORY_LIMIT`：建议沿用上游 50（fork 旧值 10 是 dead config，可直接弃用；若要保守则取上游 50 并文档化）。
  - `DEFAULT_GROUP_PROMPT` 直接采用上游 CN 文案。
- `resolveMentionPatterns`：port 时需读取 fork 的全局 cfg（`params.cfg: PluginConfig`），但 `messages.groupChat.mentionPatterns` 与 `agents.list[].groupChat.mentionPatterns` 属于 core 全局配置而非 qqbot channel 配置——**标记为可选/二期**，一期可先返回 `[]`，detectWasMentioned 退化为纯 `is_you` 检测（QQ 本就保证 @bot）。

**Step 3 — 群历史缓存（移植 `group-history.ts` → `extensions/qqbot/src/group-history.ts`）**
- 上游 `group-history.ts` 是纯函数 + 注入回调，**可近乎原样复制**：`recordPendingHistoryEntry`/`buildPendingHistoryContext`/`clearPendingHistory`/`formatAttachmentTags`/`toAttachmentSummaries`/`formatMessageContent`/`AttachmentSummary`/`HistoryEntry`。
- **必须保留一致性的点**：`formatAttachmentTags` 的 MEDIA: 标签风格需与 fork 现有 `resolveInboundAttachmentsForAgent`（`bot.ts:822+`）和 `ref-index-store.RefAttachmentSummary` 一致——上游版本即统一入口，可直接采用并让 fork 其他附件路径也改用它（消除重复）。
- 缓存 Map 实例：在 `handleQQBotDispatch` 的调用方（`monitor.ts` 的连接生命周期，`monitor.ts:60+ ActiveConnection`）持有 `Map<groupOpenid, HistoryEntry[]>`，按 account 隔离；或挂在 dispatch 闭包。上游在 gateway 连接初始化处 `new Map`（`gateway.ts:771`）。

**Step 4 — 统一门控（移植 `message-gating.ts` → `extensions/qqbot/src/message-gating.ts`）**
- `resolveGroupMessageGate` + `resolveMentionGating`/`resolveMentionGatingWithBypass` **纯函数，原样复制**。
- helper（`hasAnyMention`/`resolveImplicitMention`/`resolveGroupActivation`/`hasControlCommand`/`shouldHandleTextCommands`）从上游 `gateway.ts:246-330` 抽出到 `group-config.ts` 或新 `group-gating-helpers.ts`：
  - `resolveImplicitMention` 复用 fork 已有的 `getRefIndex`（`ref-index-store.ts:294`）与 `RefIndexEntry.isBot`（`ref-index-store.ts:20`）——**无需新增 ref 存储**。
  - `resolveGroupActivation` 读 session store JSON（上游 `gateway.ts:309+`），fork 已有 `sessionApi`（`bot.ts:3099`）可对接；一期可先返回 `configRequireMention ? "mention" : "always"`（不读 store），二期接 `/activation`。
  - `hasControlCommand` 委托 `runtime.channel.text.hasControlCommand`（fork runtime 已有 `textApi`，`bot.ts:3306`）。

**Step 5 — 重写 `shouldHandleMessage` + `buildInboundContext`（`bot.ts`）**
- **前置必做**：扩展 `parseGroupMessage`（`bot.ts:1096-1118`）与 `QQInboundMessage`（`types.ts:46-62`）以保留 `mentions?: Array<{is_you?;bot?;member_openid?;nickname?}>`、`refMsgIdx?`、`messageType?`、`msgElements?`。否则 ignoreOtherMentions/implicit-mention 无数据。`mentionedBot` 仍默认 true（QQ 平台保证），但当 `mentions` 可解析时改为 `mentions.some(m=>m.is_you)` 以支持未来精确检测。
- `shouldHandleMessage`（`bot.ts:3829-3861`）群分支重写为两段：
  1. **准入**：继续用 shared `checkGroupPolicy`（或新增 `isGroupAllowed` 包装，内部仍调 shared）判定 disabled/allowlist。
  2. **门控 + 历史**：移到 `handleQQBotDispatch` 中 `shouldHandleMessage` 通过后（`bot.ts:3909+`），调用 `resolveGroupMessageGate`，按 action 分支：`drop_other_mention`/`skip_no_mention` → `recordPendingHistoryEntry` 后 return；`block_unauthorized_command` → 静默 return；`pass` → 设 `resolvedInbound.mentionedBot = gate.effectiveWasMentioned`，继续。
- `buildInboundContext`（`bot.ts:2929-2970`）：`WasMentioned` 改用传入的 effective 值；`GroupSubject` 改用 `resolveGroupName(account, groupOpenid)`。
- `dispatchToAgent`（`bot.ts:2972+`）：在构建 `agentBody`（`bot.ts:3244-3251`）后，群消息调用 `buildPendingHistoryContext` 包裹（上游 `gateway.ts:1289-1313`），`clearPendingHistory` 在回复完成后调用。groupSystemPrompt 注入：扩展 `InboundContext` 新增可选 `GroupSystemPrompt?: string`（`types.ts:64-89`），在 `buildInboundContext` 中由 `resolveGroupIntroHint + resolveGroupPrompt` 拼装；若 core 通过 `finalizeInboundContext` 消费则对接，否则作为 `extraSystemPrompt` 经 dispatch options 传入（需确认 core 支持）。

**Step 6 — `groups` SDK 适配器（`channel.ts`）**
- 在 `qqbotPlugin`（`channel.ts:64`）新增 `groups: { resolveRequireMention, resolveToolPolicy, resolveGroupIntroHint }`（上游 `channel.ts:84-113`）。签名改为接收 `{cfg: PluginConfig, accountId, groupId}`，内部 `mergeQQBotAccountConfig(cfg, accountId)` 后调 `group-config.ts` 解析器。
- `resolveToolPolicy` 映射同上游：full→undefined、none→{allow:[],deny:["*"]}、restricted→{allow:[]}。
- **前提**：确认 fork 运行的 openclaw core 是否消费 `groups` 适配器（fork 无 plugin-sdk.d.ts，shared 无 ChannelGroupAdapter 类型）。若 core 不消费，则 `resolveToolPolicy` 需在 `dispatchToAgent` 内手动应用到 agent 调用（通过 dispatch options 的 toolPolicy/allowedTools 参数，需 core 支持）；`resolveRequireMention`/`resolveGroupIntroHint` 则由 fork 自身在 bot.ts 内消费（已在 Step 5 做）。**适配器注册仍建议加上**，以便 core 未来支持时自动生效。

**fork→upstream 映射**
- fork `requireMention`（账户扁平，`config.ts:83`）→ upstream `defaultRequireMention`（`types.ts:137`）+ `groups."*".requireMention` 优先链（`config.ts:138`）。port 时 `resolveGroupConfig` 的 account 默认值取 `account.defaultRequireMention ?? account.requireMention ?? true`。
- fork `groupAllowFrom`（账户扁平）→ upstream `resolveGroupAllowFrom`（`config.ts:106-109`，大写归一）+ shared `checkGroupPolicy` allowlist。
- fork `historyLimit`（账户扁平，dead，默认 10）→ upstream per-group `resolveHistoryLimit`（`config.ts:148-150`，默认 50）。port 时账户级 `historyLimit` 可作为 `groups."*".historyLimit` 的 fallback 以向后兼容。
- fork `groupPolicy`（账户扁平）→ upstream `resolveGroupPolicy`/`isGroupAllowed`（`config.ts:100-123`）—— fork 继续委托 shared `checkGroupPolicy`，不复制上游内联 `evaluateMatchedGroupAccessForPolicy`。
- fork `checkGroupPolicy`（shared，`bot.ts:3849`）→ upstream `resolveGroupMessageGate`（`message-gating.ts:129`）+ `isGroupAllowed`。准入仍用 shared，细粒度门控用新 gate。
- fork `mentionedBot=true`（硬编码，`bot.ts:1116`）→ upstream `detectWasMentioned` + `resolveImplicitMention` + `gate.effectiveWasMentioned`。
- fork `GroupSubject=groupOpenid`（`bot.ts:2959`）→ upstream `resolveGroupName`（`config.ts:176`）。

### 测试计划

1. **`group-config.test.ts`** — `resolveGroupConfig` 4 级优先链：仅 defaultRequireMention、`groups["*"]` 覆盖、specific 覆盖 wildcard、旧 `requireMention` 作为 defaultRequireMention fallback（向后兼容）；`resolveToolPolicy` 三态；`resolveHistoryLimit` Math.max(0,·)；`resolveGroupName` fallback openid.slice(0,8)。
2. **`message-gating.test.ts`** — `resolveGroupMessageGate` 全部分支：ignoreOtherMentions+hasAnyMention+!wasMentioned→drop；未授权控制命令→block；requireMention+canDetect+!effective→skip；pass 时 effectiveWasMentioned 含 implicit+bypass。纯函数，无 mock。
3. **`group-history.test.ts`** — `recordPendingHistoryEntry` LRU（>MAX_HISTORY_KEYS 淘汰最早）、limit<=0 不记录、单条 limit 滑窗；`buildPendingHistoryContext` 无历史返回原文、有历史包裹 HISTORY_CTX 标签；`clearPendingHistory`；`formatAttachmentTags` MEDIA:/[图片]/[语音消息（内容）] 各分支。
4. **`bot.group-gate.test.ts`** — 端到端（mock dispatch）：(a) groupPolicy=disabled→blocked；(b) allowlist 未命中→blocked；(c) requireMention=true + 非@（需 mock mentions 为空）→skip 且写入历史；(d) @bot→pass；(e) ignoreOtherMentions=true + @他人→drop 且写历史；(f) implicit-mention（refMsgIdx 指向 isBot ref）→pass；(g) pass 后 agentBody 被 `buildPendingHistoryContext` 包裹、回复后 `clearPendingHistory`。
5. **`config.test.ts` 扩展** — zod schema：`groups` record 校验、`defaultRequireMention` 默认 true、`toolPolicy` enum；`mergeQQBotAccountConfig` 下 groups 合并语义（account.groups 覆盖 base.groups）。
6. **回归** — 现有 `bot.regressions.test.ts`/`bot.streaming.test.ts` 不破坏：确认 `mentionedBot=true` 默认路径（无 mentions 字段）仍 pass，不引入 skip 回归。

### 风险与注意事项

1. **`parseGroupMessage` 数据丢失（最高风险）**：fork 当前丢弃 `mentions[]`/`refMsgIdx`/`message_type`。ignoreOtherMentions/implicit-mention/hasAnyMention 全部依赖这些字段。**必须先扩展 `QQInboundMessage` 与 parse 函数**，否则 port 后这些功能静默失效（gate 永远 pass，因为 hasAnyMention 恒 false、wasMentioned 恒 true）。这是上游门控能工作而 fork 不能的直接原因。
2. **`mentionedBot` 语义变更风险**：QQ 仅下发 `GROUP_AT_MESSAGE_CREATE`（已 @bot）。若把 `mentionedBot` 改为 `mentions.some(is_you)` 且 QQ 不在该数组标 is_you，会导致所有群消息被误 skip。**保留 `mentionedBot=true` 默认**，仅在 `mentions` 显式存在且含 `is_you:false` 时才降级。
3. **core 是否消费 `groups` 适配器不确定**：fork 无 plugin-sdk 类型声明，shared 无 ChannelGroupAdapter。若 core 不消费，`resolveToolPolicy` 无法经适配器生效，必须在 `dispatchToAgent` 内手动应用——需先验证 core 的 dispatch options 是否接受 toolPolicy/allowedTools。建议一期先在 bot.ts 内自消费（不依赖适配器），适配器注册作为二期增强。
4. **groupSystemPrompt 注入通道**：fork `InboundContext` 无对应字段，`dispatchReply*` 未传 extraSystemPrompt。需确认 core 的 `finalizeInboundContext` 或 dispatch options 支持；否则 per-group prompt 无法注入（只能退化拼入 BodyForAgent，污染 transcript）。这是 design 阻塞点，需与 core 团队确认。
5. **`historyLimit` 默认值变更**：fork 旧值 10（dead）→ 上游 50。虽是 dead config，但若用户显式设了 10，port 后语义从"账户级全局"变为"per-group 默认（可被 `*`/specific 覆盖）"。文档化迁移：旧 `historyLimit` 映射为 `groups."*".historyLimit`。
6. **`groups` map 合并语义**：`mergeQQBotAccountConfig` 当前是浅展开 `{...baseConfig, ...account}`（`config.ts:278-284`）。若 base 与 account 都有 `groups`，account.groups 会**整体覆盖** base.groups（非深合并）。需决定：深合并（per-key）还是整体覆盖？建议整体覆盖（与 displayAliases 的合并策略对齐——displayAliases 是显式深合并，groups 可仿效深合并以允许 base 设 `*`、account 设 specific）。
7. **`/activation` session store 读取**：上游直接 `fs.readFileSync` 读 `~/.openclaw/agents/{agentId}/sessions/sessions.json`（`gateway.ts:318-329`）。fork 已有 `sessionApi`（`bot.ts:3099`）。优先用 sessionApi 而非直读文件，避免路径假设与 fork 的 state 目录布局不一致。
8. **`DEFAULT_GROUP_PROMPT` bot-vs-human 差异化**：上游 `gateway.ts:1200-1214` 注入的 prompt 含"若发送者为机器人…"防抢答逻辑。port 时需保留这段 CN PE，且确认它不与 fork 现有 systemPrompt 冲突（fork 账户级无 group prompt，无冲突）。

## 4.8 Multi-Account (token cache, connection routing, RequestContext)

### 现状对比

**Fork 现状（@openclaw-china/qqbot 2026.3.9-1）**

- 多账户通过 @openclaw-china 框架契约实现：`config.listAccountIds` (`channel.ts:256`) 调 `listQQBotAccountIds` (`config.ts:250-254`)，框架按 accountId 循环调用 `gateway.startAccount` (`channel.ts:367-413`)，每个账户一个 WebSocket。
- 账户合并：`mergeQQBotAccountConfig(cfg, accountId)` (`config.ts:270-285`) 将顶层 base 配置与 `accounts[accountId]` 叠加，`displayAliases` 做合并。
- 连接路由：`monitor.ts` 维护 `activeConnections: Map<string, ActiveConnection>` (`monitor.ts:78`)，每账户一个 socket + 独立 heartbeat/reconnect 定时器（`RECONNECT_DELAYS_MS` `monitor.ts:44`）。`accountId` 作为显式参数贯穿 `handleQQBotDispatch` (`monitor.ts:316-323`)。
- Token 缓存：`client.ts` 已实现 per-appId 隔离 —— `tokenCacheMap: Map<string, TokenCache>` (`client.ts:14`) + `tokenPromiseMap: Map<string, Promise>` singleflight (`client.ts:15`)，`getAccessToken` (`client.ts:130-172`) 仅在 `Date.now() < expiresAt - 5*60*1000` 时复用缓存，否则惰性刷新（`client.ts:138-141`）。`clearTokenCache(appId)` 用于 op 9 invalid session (`client.ts:119-128`，被 `monitor.ts:293` 调用)。
- accountId 传播：**仅靠显式函数参数**。`InboundContext.AccountId` (`types.ts:77`)、`route.accountId`、`QQInboundMessage` 均带 accountId；`bot.ts` 全程通过 `outboundAccountId`/`accountId` 参数透传（`bot.ts:1226,2992,3004` 等）。**无 AsyncLocalStorage**（grep 确认 fork src 中无 `runWithRequestContext`/`AsyncLocalStorage`）。
- 秘密来源：**仅 inline `clientSecret`**（`config.ts:59`），无 `clientSecretFile` / env 支持（grep `QQBOT_CLIENT_SECRET`/`clientSecretFile` 在 fork src 中 0 命中）。
- known-targets store (`proactive.ts`) 已按 accountId+kind+target 复合键隔离（`proactive.ts:17-26`），与上游 known-users.ts 是同位功能。

**上游现状（@tencent-connect/openclaw-qqbot v1.7.2）**

- 同样 per-account 一个 `startGateway(GatewayContext)`（`gateway.ts`），`GatewayContext.account: ResolvedQQBotAccount`（`gateway.ts:56,368-369`）。
- Token 缓存：`api.ts` `tokenCacheMap: Map<string,{token,expiresAt,appId}>` (`api.ts:134`) + `tokenFetchPromises` singleflight (`api.ts:135`)，`getAccessToken` (`api.ts:145-177`)，提前刷新阈值用 `Math.min(5*60*1000, (expiresAt-now)/3)` 自适应短有效期 token（`api.ts:151-153`）。`getTokenStatus(appId)` (`api.ts:256-267`) 返回 `valid|expired|refreshing|none`。
- **后台主动刷新**：`startBackgroundTokenRefresh`/`stopBackgroundTokenRefresh`/`isBackgroundTokenRefreshRunning` (`api.ts:1189-1272`)，per-appId `AbortController`（`backgroundRefreshControllers` `api.ts:1187`），带 jitter（`refreshAheadMs=5min`/`randomOffsetMs=30s`/`minRefreshIntervalMs=60s`/`retryDelayMs=5s`，`api.ts:1200-1203`）。在 WS `ws.on("open")` 启动 (`gateway.ts:1994`)、webhook 模式启动 (`gateway.ts:1943`)；在 abort-signal cleanup 停止 (`gateway.ts:700`)、webhook teardown 停止 (`gateway.ts:1971`)。注意：WS `ws.on("close")` 不直接停止（`gateway.ts:2148`），靠 start 幂等（`api.ts:1194`）。
- **RequestContext (AsyncLocalStorage)**：`request-context.ts` 提供 `{target, accountId}` + `runWithRequestContext`/`getRequestContext`/`getRequestTarget`/`getRequestAccountId`。`gateway.ts:1417-1890` 把整条入站消息处理包进 `runWithRequestContext({target: qualifiedTarget, accountId: account.accountId}, ...)`，使下游 tool/agent 可安全读取（如 `tools/remind.ts:261,266` 用 `getRequestTarget()`/`getRequestAccountId()`）。
- 秘密来源更丰富：`resolveQQBotAccount` (`config.ts:241-296`) 支持 `clientSecret` (config) / `clientSecretFile` (file) / `QQBOT_CLIENT_SECRET` env（仅 default 账户，`config.ts:267-276`），返回 `secretSource`（`config.ts:289`）；appId 也可来自 `QQBOT_APP_ID` env（`config.ts:279-281`）。`ResolvedQQBotAccount` 还带 `systemPrompt`/`imageServerBaseUrl`/`userAgentSuffix`/`name`/`config` (`types.ts:19-33`)。

### 差距清单

1. **后台主动 token 刷新缺失**：fork 仅有惰性刷新（`client.ts:138-141`），上游有 `startBackgroundTokenRefresh`（`api.ts:1189`）。后果：fork 在 token 过期后的**第一个**请求会触发同步刷新，若恰好命中 11255/网络抖动则该次发送失败；上游提前 5min 抖动刷新可避免。注意 fork 的 `outbound.ts:307,678` 取 token 后**无 token-expiry 重试包装**（上游有 `sendWithTokenRetry` `reply-dispatcher.ts:31`），所以惰性刷新的失败窗口在 fork 里更明显。
2. **`getTokenStatus(appId)` 监控接口缺失**（fork `client.ts` 无；上游 `api.ts:256-267`）。
3. **RequestContext (AsyncLocalStorage) 缺失**：fork 仅靠参数透传 accountId。任何**不接收 accountId 参数**的下游代码（移植上游 tool 如 `remind.ts`，或共享包内调用）无法获知当前账户。上游 `request-context.ts` 全文 50 行可直接移植。
4. **Token 提前刷新阈值的短有效期自适应缺失**：fork 写死 `5*60*1000`（`client.ts:139`），上游用 `Math.min(5min, expiresIn/3)`（`api.ts:151-153`），对有效期 <15min 的 token 更稳。
5. **多 secret 来源缺失**：fork 仅 inline `clientSecret`；上游支持 `clientSecretFile` + `QQBOT_CLIENT_SECRET`/`QQBOT_APP_ID` env（`config.ts:267-281`）。注意：env 仅对 default 账户生效，多命名账户仍需 inline/file。
6. **ResolvedQQBotAccount 字段更薄**：fork (`types.ts:17-27`) 不含 `clientSecret`/`secretSource`/`systemPrompt`/`imageServerBaseUrl`/`userAgentSuffix`/`name`/`config`（上游 `types.ts:19-33`，`config.ts:283-295`）。

### 必须保留

- **fork 的框架契约入口**：`gateway.startAccount`/`stopAccount`/`getStatus` (`channel.ts:366-419`) + `config.listAccountIds`/`resolveAccount`/`setAccountEnabled`/`deleteAccount`/`isConfigured` (`channel.ts:255-323`)。**不可**用上游 self-contained `startGateway(GatewayContext)` 替换——那是 port-not-rebase 的硬约束。
- **`monitor.ts` 连接管理**：`activeConnections` Map、`RECONNECT_DELAYS_MS`、per-connection heartbeat/reconnect/sessionId/lastSeq（`monitor.ts:44,78,60-70`）是上游 gateway.ts 的框架契约化等价物，保留。
- **配置命名空间 `channels.qqbot-china`**（`config.ts:6-8`，`QQBOT_CONFIG_CHANNEL_ID='qqbot-china'`），与上游 `channels.qqbot` 不同——`mergeQQBotAccountConfig` 不能被上游 `resolveQQBotAccount` 直接替换。
- **China 本地化 per-account 字段**（`config.ts:55-99`）：`streaming`、`displayAliases`（base+account 合并）、`asr{enabled,appId,secretId,secretKey}`、`c2cMarkdownDeliveryMode`/`c2cMarkdownChunkStrategy`/`c2cMarkdownSafeChunkByteLimit`、`typingHeartbeatMode`/`typingHeartbeatIntervalMs`/`typingInputSeconds`、`dmPolicy`/`groupPolicy`/`requireMention`/`allowFrom`/`groupAllowFrom`、`textChunkLimit`/`replyFinalOnly`/`longTaskNoticeDelayMs`/`mediaTimeoutMs`/`autoSendLocalPathMedia`/`inboundMedia{dir,keepDays}`。
- **known-targets store (`proactive.ts`)**：`KnownQQBotTarget` schema、legacy+new 路径迁移、`listKnownQQBotTargets`/`getKnownQQBotTarget`/`remove`/`clear` 导出，已 accountId-scoped，与上游 known-users.ts 同位——保留，不替换。
- **fork 的 `client.ts` 消息序号/被动消息重试逻辑**（`msgSeqMap` `client.ts:17`、`postPassiveMessage` 的 `MAX_DUPLICATE_MSG_SEQ_RETRIES` `client.ts:104-117`、`isDuplicateMsgSeqError` 40054005 `client.ts:84`）——上游用无状态随机 `getNextMsgSeq`（`api.ts:273-277`），fork 的方案更严谨，保留。
- **`registerChinaSetupCli`/`showChinaInstallHint`** 渠道注册（channel.ts meta + setup）。

### 实施方案

分两批，按风险/价值排序。

**批次 1（P0，低风险，纯增量）：后台主动 token 刷新 + getTokenStatus + 短有效期自适应阈值。**

- 修改 `src/client.ts`：
  - `TokenCache` 加 `appId` 字段（对齐上游 `api.ts:134` 结构，便于 `getTokenStatus`）。
  - `getAccessToken` 的提前刷新阈值从写死 `5*60*1000` 改为 `cached ? Math.min(5*60*1000, (cached.expiresAt-Date.now())/3) : 0`（移植 `api.ts:151-153`）。
  - 新增 `getTokenStatus(appId)`（移植 `api.ts:256-267`）。
  - 新增 `startBackgroundTokenRefresh`/`stopBackgroundTokenRefresh`/`isBackgroundTokenRefreshRunning` + `backgroundRefreshControllers: Map<string,AbortController>` + `BackgroundTokenRefreshOptions` + `sleep`（移植 `api.ts:1175-1280`）。**关键适配**：上游 `doFetchToken` 用裸 `fetch`（`api.ts:191`），fork 必须改用 `@openclaw-china/shared` 的 `httpPost`（`client.ts:1,150`）以复用 fork 的超时/错误处理，避免绕过共享 HTTP 基础设施（port-not-rebase 约束）。
- 修改 `src/monitor.ts`：
  - `op===10 (Hello)` 拿到 token 后 / `READY` 分支后调用 `startBackgroundTokenRefresh(qqCfg.appId, qqCfg.clientSecret)`（对齐上游 `gateway.ts:1994`）。注意 fork 的 READY 在 `monitor.ts:301-308`。
  - `finish()` teardown（`monitor.ts:176-193`）中调用 `stopBackgroundTokenRefresh(qqCfg.appId as string)`（对齐上游 abort-cleanup `gateway.ts:700`）。**不要**在 `ws.on("close")` 的 `scheduleReconnect` 路径停止——靠 `startBackgroundTokenRefresh` 幂等（`api.ts:1194`）避免重复。
- 集成点：`monitor.ts:14` 已 `import { clearTokenCache, getAccessToken, getGatewayUrl } from "./client.js"`，扩展该 import 即可。

**批次 2（P1，中高风险，架构变更）：RequestContext (AsyncLocalStorage)。**

- 新建 `src/request-context.ts`：**逐字移植**上游 `request-context.ts`（50 行，无外部依赖除 `node:async_hooks`）。这是纯加法，不与 fork 现有参数透传冲突。
- 修改 `src/bot.ts`：在 `handleQQBotDispatch` 入站分发处（`bot.ts:1214-1216` `dispatchInbound` 附近，或 `bot.ts:2980 processInbound` 入口）用 `runWithRequestContext({target: qualifiedTarget, accountId: resolvedAccountId}, async () => {...})` 包裹整个 inbound 处理闭包。`qualifiedTarget` 由 `inbound.type` 推导（参考上游 `gateway.ts:1018`：group→`qqbot:group:${groupOpenid}`，c2c→`qqbot:c2c:${senderId}`）。这样下游任何调用 `getRequestAccountId()` 的代码（含未来移植的上游 tool）都能拿到正确账户。
- **不强制**立即让现有 `bot.ts` 代码改用 `getRequestAccountId()`——保留显式参数透传作为权威源，RequestContext 仅作为补充/兼容层，降低回归风险。
- 风险控制：RequestContext 的 `target` 格式必须与 fork `messaging.normalizeTarget`/`outbound` 期望的 `user:/group:/channel:` 前缀一致（fork `channel.ts:84-104`），避免把 `qqbot:c2c:` 直接当投递地址用。RequestContext 仅用于"查询当前账户"，target 字段可用 fork 内部表示。

**批次 3（P2，可选）：多 secret 来源 + ResolvedQQBotAccount 富字段。**

- 修改 `src/config.ts`：`QQBotAccountSchema` 加 `clientSecretFile: optionalCoercedString`；`resolveQQBotCredentials` (`config.ts:295-302`) 扩展为优先 inline > 文件读取 > env（仅 default 账户，对齐上游 `config.ts:267-276`）。env 名沿用 `QQBOT_CLIENT_SECRET`/`QQBOT_APP_ID`。
- 可选扩展 `ResolvedQQBotAccount` (`types.ts:17-27`) 加 `clientSecret`/`secretSource` —— 但 fork 把 clientSecret 通过 `resolveQQBotCredentials` 单独传（`channel.ts:49`），改类型会牵动 `resolveQQBotAccount` (`channel.ts:41-62`)，评估后再做。

### 测试计划

- `client.test.ts` 新增：
  - `getTokenStatus` 返回 `none`（无缓存）/`valid`（未到期）/`expired`（接近到期）/`refreshing`（singleflight 进行中）。
  - `startBackgroundTokenRefresh` 幂等：对同一 appId 连续调用两次，第二个 no-op 且不创建第二个 controller（`isBackgroundTokenRefreshRunning` 为 true）。
  - `stopBackgroundTokenRefresh(appId)` 只停该 appId，`stopBackgroundTokenRefresh()`（无参）停全部。
  - 短有效期 token 自适应：构造 `expiresAt = now + 6min`，验证刷新阈值用 `min(5min, 2min)=2min` 而非写死 5min。
- `monitor.test.ts` 新增：
  - READY 后 `isBackgroundTokenRefreshRunning(appId) === true`；`finish()`（abort/stop）后为 `false`。
  - socket close 触发 `scheduleReconnect` 后，后台刷新仍在运行（不在 reconnect 路径停止）。
- `request-context.test.ts`（新建）：
  - `runWithRequestContext` 内 `getRequestAccountId()`/`getRequestTarget()` 返回正确值；`await` 跨异步边界仍保持；闭包外 `getRequestContext()` 为 `undefined`；并发两个不同 accountId 的作用域互不串扰（用 `Promise.all` + 延时验证）。
- 回归：`bot.test.ts`/`bot.known-targets.test.ts` 中已知的多账户串号用例仍通过（per-appId token 隔离未被破坏）。

### 风险与注意事项

1. **HTTP 基础设施一致性**：移植后台刷新时务必用 `@openclaw-china/shared` 的 `httpPost`（`client.ts:150`），不能用上游裸 `fetch`（`api.ts:191`），否则绕过 fork 的超时/HttpError/日志约定——这是 port-not-rebase 的核心约束。
2. **后台刷新泄漏**：`monitor.ts` 的 `finish()` 必须可靠调用 `stopBackgroundTokenRefresh(appId)`；多账户场景下若一个账户 stop 漏调，其 AbortController+定时器会泄漏。建议在 `stopAllQQBotMonitors` (`monitor.ts:423-427`) 末尾兜底 `stopBackgroundTokenRefresh()`（无参，全清）。
3. **RequestContext target 格式**：fork 的 outbound/messaging 期望 `user:/group:/channel:` 前缀（`channel.ts:88`），上游用 `qqbot:c2c:`/`qqbot:group:`（`gateway.ts:1018`）。移植时 target 字段用 fork 内部表示，**不可**让 RequestContext.target 直接喂给 outbound，否则 normalizeTarget 行为不一致。
4. **RequestContext 跨账户竞态**：AsyncLocalStorage 在 Node 中跨 `await`/回调可靠传播，但**不**跨 `process.nextTick` 之外的显式线程切换。fork 的 `bot.ts` 大量用 `Promise.all`/dispatcher，需确保 `runWithRequestContext` 包裹整个 inbound 处理闭包而非仅外层。
5. **env secret 仅 default 账户**：移植 `QQBOT_CLIENT_SECRET` env 时严格保持"仅 DEFAULT_ACCOUNT_ID 生效"语义（上游 `config.ts:273`），否则多账户下 env 会错误地注入到命名账户。
6. **不要替换 monitor.ts 为 startGateway**：上游 `startGateway` 是自包含 daemon（含 webhook/image-server/approval-handler 等大量 fork 未采用的子系统），整体替换会破坏框架契约。仅取其 token 刷新 + request-context 两点。

## 4.9 Streaming, Typing Indicator, Markdown Delivery (fork-strength area)

> 结论先行：本子系统 fork 是**配置能力与 C2C markdown 投递的更强方**（typing 三模式、passive/proactive markdown、block 分块、replyFinalOnly 缓冲、长任务提示），upstream v1.7.2 是**流式控制器健壮性与内联富媒体流式的更强方**（StreamingPhase 状态机、FlushController 互斥+reflush+长间隔批处理、`_callbackChain` 串行队列 + `acquireCallbackLock` first-callback-wins、raw-text `startsWith` 边界检测、`processMediaTags` 内联媒体流式、`onIdle/onError/abortStreaming`）。实施方针：**保留全部 fork 本地配置与 C2C markdown/replyFinalOnly/typing 能力，选择性移植 upstream 控制器的 flush/锁定/边界/媒体内部机制进 fork 的 controller**，绝不整体替换 `streaming.ts` 或重写 `bot.ts` 的 deliver 决策树。

### 现状对比

#### Fork 现状（@openclaw-china/qqbot）

**流式 (`extensions/qqbot/src/streaming.ts:33-333`，`QQBotStreamingController`)**
- 全量 REPLACE 模型：`latestText`/`lastSentText`（streaming.ts:39-40），`input_mode: REPLACE`（streaming.ts:259）。
- 节流：默认 500ms / 最小 300ms（streaming.ts:30-31, 54-56），`scheduleFlush` 用单一 `setTimeout`（streaming.ts:193-214），**无 reflush、无长间隔批处理**。
- 回复边界检测：**长度递减启发式** `text.length < this.lastPartialLength`（streaming.ts:75），不如 upstream 的前缀匹配稳健。
- 公共 API：`onPartialReply` / `finalize` / `dispose`（streaming.ts:71,99,105）；getter `hasSuccessfulChunk`/`shouldFallbackToStatic`/`hasObservedPartial`（streaming.ts:59-69）；`onFirstChunk` 钩子（streaming.ts:280-290）。**无 `onDeliver/onIdle/onError/abortStreaming`，无显式状态机**（仅 `sessionShouldFallbackToStatic` + `disposed` 标志）。
- 纯文本流式；媒体在 `bot.ts:3383-3401` 的 `handleStreamingPartialReply` 中先 `extractQQBotReplyMedia` 抽取媒体、`looksLikeQQBotStreamingIneligibleMarkdown`（bot.ts:2829-2844，检测 table/heading/blockquote/fence/thematic-break/list）命中或含媒体则**提前 return 不流式**，由 `bot.ts` 的静态 markdown transport 接管。

**Typing（`extensions/qqbot/src/bot.ts:722-762`，`startQQBotTypingHeartbeat`）**
- 可配置心跳：`typingHeartbeatMode` none|idle|always（默认 `idle`，config.ts:48）、`typingHeartbeatIntervalMs`（默认 5000，config.ts:49）、`typingInputSeconds`（默认 60，config.ts:50）。
- `startQQBotTypingHeartbeat`（bot.ts:722）：`setInterval` 续期 + `renewalInFlight` in-flight 守卫（bot.ts:746,748）+ `shouldRenew` 谓词（idle 仅当 `Date.now()-lastVisibleOutboundAt >= intervalMs` 续期，bot.ts:3053；always 无条件续期，bot.ts:3050-3051）。
- 首次 typing 由 `qqbotOutbound.sendTyping`（outbound.ts:657-731，走 contract → `client.ts:402 sendC2CInputNotify`）发出；`onFirstChunk` 回调里 `typingHeartbeat?.stop()`（bot.ts:3358）。
- WS 网关心跳 `op:1`/`case 11` 在 `monitor.ts:218-227,280-283`，多账户 `activeConnections` Map（monitor.ts:78），独立于 typing，不在移植范围。

**C2C Markdown 投递（`extensions/qqbot/src/bot.ts` + `config.ts`）**
- `c2cMarkdownDeliveryMode` passive|proactive-table-only|proactive-all（默认 `proactive-table-only`，config.ts:27-32, bot.ts:3333）→ `resolveQQBotTextReplyRefs`（bot.ts:1604-1636）算出 `forceProactive`，proactive 时丢弃 `replyToId`/`replyEventId`（bot.ts:1631-1635）。
- `c2cMarkdownChunkStrategy` markdown-block|length（默认 `markdown-block`，bot.ts:3334）→ `chunkC2CMarkdownText`（bot.ts:2846-2868）→ block 感知 `chunkQQBotStructuredMarkdown`（bot.ts:2618，按表/代码块/段落分块）+ `c2cMarkdownSafeChunkByteLimit`（默认 1200，config.ts:149-156）+ UTF-8 字节软限 `resolveQQBotStructuredMarkdownSoftLimit`。
- `replyFinalOnly`（config.ts:88 默认 false）：`evaluateReplyFinalOnlyDelivery`（bot.ts:1537-1550）+ 缓冲累加器 `bufferedC2CMarkdownTexts/MediaUrls`（bot.ts:3340-3342）+ `appendQQBotBufferedText`（bot.ts:1638-1657）+ `flushBufferedC2CMarkdownReply`，把所有非 final/非 tool delta 合并成一条；还旁路一个 `shouldBufferStructuredMarkdownPayload`（bot.ts:3592-3607）对 `markdown-block` 策略的连续结构化 markdown 做缓冲合并。
- `markdown-images.ts` 把 http 图片 URL 内联进 markdown；`markdownSupport`（bot.ts:3332 默认 true）；`longTaskNoticeDelayMs`（默认 30000，bot.ts:666）+ `LONG_TASK_NOTICE_TEXT`（bot.ts:665）+ `markReplyDelivered` 协调（bot.ts:3023-3026,3091）。

#### 上游现状（upstream v1.7.2）

**流式 (`openclaw-qqbot-upstream/src/streaming.ts:235-980`，`StreamingController` 类；文件 1078 行)**
- `StreamingPhase` 状态机 idle/streaming/completed/aborted（streaming.ts:44-55），`PHASE_TRANSITIONS` 守卫（streaming.ts:50-55），`isTerminalPhase`/`transition`（streaming.ts:337-376）。
- `FlushController`（streaming.ts:62-190）：互斥 `flushInProgress`+`flushResolvers`（streaming.ts:65-66）、冲突 `needsReflush` 跟进（streaming.ts:152-158）、长间隔批处理 `LONG_GAP_THRESHOLD_MS=2000`/`BATCH_AFTER_GAP_MS=300`（streaming.ts:37-40, 171-177）、`cancelPendingAndWait`（streaming.ts:96-103）。
- 串行队列 `_callbackChain` + `acquireCallbackLock` first-callback-wins（streaming.ts:277,285-304,422,499）：onPartialReply 与 onDeliver 互斥。
- 回复边界：raw 文本 `startsWith` + `_boundaryPrefix` 追加 `"\n\n"` 分隔（streaming.ts:252-258,457-468），比长度启发式稳健。
- 内联富媒体流式：`processMediaTags` 循环消费（streaming.ts:692-772）+ `stripIncompleteMediaTag`/`findFirstClosedMediaTag`（utils/media-tags.ts、utils/media-send.ts）+ `StreamingMediaContext`（streaming.ts:988-1005）+ `sendMediaQueue` `skipInterTagText`（streaming.ts:1043-1053）+ `sentIndex` 媒体后断点续传（streaming.ts:266,732）。
- 完整生命周期：`onIdle`/`onError`/`abortStreaming`/`markFullyComplete`（streaming.ts:513-678），显式 DONE chunk 终结 + 错误/中止文案。
- gateway 接线（gateway.ts:1494-1863）：`shouldUseStreaming`（streaming.ts:1064-1077，需 `account.config?.streaming === true`，默认关）→ `StreamingController` 注入 `mediaContext` → onDeliver/onPartialReply/onIdle 全走 controller。

**Typing（`openclaw-qqbot-upstream/src/typing-keepalive.ts:13-59`，`TypingKeepAlive` 类）**
- 固定 `TYPING_INTERVAL_MS=50_000` / `TYPING_INPUT_SECOND=60`（typing-keepalive.ts:10-11），**无模式/无间隔/无 inputSecond 可配**。
- gateway.ts:812-857 接线：首次 `sendC2CInputNotify` 成功后 new `TypingKeepAlive` 并 `start()`（gateway.ts:822-830）；失败时刷新 token 重试（gateway.ts:834-848）；`send()` 内 token 失败二次刷新（typing-keepalive.ts:50-57）。

**Markdown 投递（`openclaw-qqbot-upstream/src/outbound-deliver.ts`）**
- 仅 `markdownSupport`（config.ts:256 默认 true）开关；通用 `chunkMarkdownText`/`chunkText` + `TEXT_CHUNK_LIMIT`（outbound-deliver.ts:287,399,468）。
- **无** passive/proactive 模式选择、**无** block 感知分块、**无** `replyFinalOnly` 缓冲、**无** deliverDebounce（后者在独立 deliver-debounce.ts，gateway.ts:1437-1438 接线，按 account.config.deliverDebounce 启用）。

### 差距清单（upstream 有、fork 缺）

1. **StreamingPhase 状态机**（upstream streaming.ts:44-55,363-381）+ 终态保护：fork 的 controller 无显式 phase 机，仅 `sessionShouldFallbackToStatic`/`disposed`（streaming.ts:47,50），缺乏对重复 finalize、终态后误入的防御。
2. **FlushController 互斥 + reflush + 长间隔批处理**（upstream streaming.ts:62-190）：fork `scheduleFlush`（streaming.ts:193-214）仅单 `setTimeout`，flush 冲突时丢弃而非 reflush，长间隔后无批处理窗口。
3. **`_callbackChain` 串行 + `acquireCallbackLock` first-callback-wins**（upstream streaming.ts:277-304,422,499）：fork 用 `enqueue` Promise 链（streaming.ts:110-116）串行化 partial，但**无 onDeliver，无 partial/deliver 互斥锁**。
4. **raw-text `startsWith` 边界检测**（upstream streaming.ts:457-468）+ `_boundaryPrefix` 追加：fork 的 `text.length < lastPartialLength`（streaming.ts:75）在文本被 normalize/trim 后可能误判或漏判（含媒体标签时尤其不稳定）。
5. **内联富媒体流式**（upstream streaming.ts:692-772 + utils/media-tags.ts + utils/media-send.ts + streaming.ts:988-1053）：fork 流式纯文本，遇媒体直接 fallback 到静态 markdown transport，丢失"流式中途插图"能力。
6. **`onIdle/onError/abortStreaming/markFullyComplete`**（upstream streaming.ts:513-678）：fork 仅有 `finalize/dispose`，错误/中止无 DONE chunk 文案，`streamingController` 不接收 dispatch 完成信号（fork 靠 `bot.ts:3782-3784` finalize）。
7. **deliverDebounce**（upstream deliver-debounce.ts 全文 + gateway.ts:1739 接线）：`{enabled,windowMs,maxWaitMs,separator}` 合并快速连续 deliver，fork 无此机制（靠 `replyFinalOnly`/结构化缓冲部分覆盖，但 deliver 碎片仍可能轰炸）。

### 必须保留（China-fork 特性，移植中不得丢失）

- **Typing 三模式可配**：`typingHeartbeatMode`/`typingHeartbeatIntervalMs`/`typingInputSeconds`（config.ts:41-50,158-174）+ `startQQBotTypingHeartbeat` 的 `shouldRenew` 谓词 + in-flight 守卫 + `onFirstChunk` stop（bot.ts:722-762,3044-3070,3358）。upstream 的 `TypingKeepAlive` 固定 50s/60s 是 fork 的真子集。
- **C2C markdown passive/proactive 模式**：`c2cMarkdownDeliveryMode` + `resolveQQBotTextReplyRefs` `forceProactive`（config.ts:27-32, bot.ts:1604-1636）。
- **block 感知 C2C markdown 分块**：`c2cMarkdownChunkStrategy` + `chunkC2CMarkdownText`/`chunkQQBotStructuredMarkdown` + `c2cMarkdownSafeChunkByteLimit` + UTF-8 软限（bot.ts:2618,2846-2868; config.ts:149-156）。
- **replyFinalOnly 缓冲**：`evaluateReplyFinalOnlyDelivery` + `bufferedC2CMarkdownTexts/MediaUrls` + `appendQQBotBufferedText` + `flushBufferedC2CMarkdownReply` + `shouldBufferStructuredMarkdownPayload`（bot.ts:1537-1550,1638-1657,3340-3607）。
- **`looksLikeQQBotStreamingIneligibleMarkdown` 门控**（bot.ts:2829-2844,3393-3399）：结构化 markdown（表/标题/引用/代码块/分隔线/列表）不流式、走静态渲染，体验更佳。
- **长任务提示**：`longTaskNoticeDelayMs` + `LONG_TASK_NOTICE_TEXT` + `markReplyDelivered` 协调（bot.ts:665-666,680-720,3023-3094）。
- **多账户 WS 网关**：`monitor.ts` 的 `activeConnections` Map + per-account op:1 心跳 + resume/identify + 重连退避（monitor.ts:78,218-227,242-253,369-375），与 typing/streaming 解耦，不在移植范围。
- **markdown-images 内联**（`markdown-images.ts`）、`displayAliases`、`textChunkLimit`/`resolveChunkMode`/`resolveMarkdownTableMode` 协同（非 C2C 文本分块）。

### 实施方案

**约束**：上游自包含模块必须适配 fork 的契约（outbound contract `sendTyping`/`sendText`/`sendMarkdown`、`client.ts` 的 `sendC2CStreamMessage`/`sendC2CInputNotify`/`allocateMsgSeq`、shared 包），不得 verbatim 拷贝 gateway.ts 的 dispatcher 耦合。

#### 阶段一（低风险快赢，1-2d）：边界检测 + FlushController 移植

1. **修改 `extensions/qqbot/src/streaming.ts`**：
   - 把回复边界从 `text.length < this.lastPartialLength`（streaming.ts:75）改为 raw 文本 `startsWith` + boundary prefix：新增 `lastRawFull`、`_boundaryPrefix` 字段，移植 upstream streaming.ts:457-468 的检测逻辑（保留 fork 的全量 REPLACE 语义——fork 每次 `sendChunk` 发 `latestText` 全量，不同于 upstream 的 `sentIndex` 切片，故 boundary prefix 仅用于"是否开新流式会话"判断，`content_raw` 仍是全量文本）。
   - 引入精简 `FlushController`：移植 upstream streaming.ts:62-190 的 `flushInProgress`+`flushResolvers`+`needsReflush`+`cancelPendingAndWait`，以及 `LONG_GAP_THRESHOLD_MS`/`BATCH_AFTER_GAP_MS` 长间隔批处理，替换 fork streaming.ts:193-214 的单 `setTimeout`。**不引入 upstream 的 `_ready`/`reset`/`setReady` 全套**——fork 的 `ensureStreamingStarted`（streaming.ts:118-133）已覆盖启动就绪语义，只需把 `scheduleFlush`/`flushNow` 包进新的 FlushController。
   - 保持公共 API 不变（`onPartialReply/finalize/dispose/hasSuccessfulChunk/shouldFallbackToStatic/onFirstChunk`），`bot.ts` 接线零改动。

#### 阶段二（中等风险，1d）：状态机 + 错误/中止 finalize

2. **修改 `extensions/qqbot/src/streaming.ts`**：
   - 加最小 `StreamingPhase`（idle/streaming/completed/aborted）+ `PHASE_TRANSITIONS`（移植 upstream streaming.ts:44-55,363-376），让 `shouldFallbackToStatic` 改为 `isTerminalPhase && sessionSentChunkCount===0`（对齐 upstream streaming.ts:350-352），终态后所有入口短路。
   - 给 `finalize` 增加 upstream streaming.ts:575-609 的"有活跃会话发 DONE / 已发过分片标 completed / 啥都没发降级"三分支（fork 当前只有发 DONE 一条路径 streaming.ts:232-246）。
   - 可选：新增 `onError`/`abortStreaming`（upstream streaming.ts:614-678）以支持 bot.ts 错误路径发"生成响应时发生错误"DONE 文案。`bot.ts` 调用点（3782-3784 finalize）按需扩展。

#### 阶段三（可选高价值，独立，1d）：deliverDebounce 移植

3. **创建 `extensions/qqbot/src/deliver-debounce.ts`**：从 upstream deliver-debounce.ts 全量移植 `DeliverDebouncer`/`createDeliverDebouncer`（纯逻辑、无 SDK 耦合，可直接复用）。
4. **修改 `extensions/qqbot/src/config.ts` + `types.ts`/Zod schema**：新增 `deliverDebounce: {enabled, windowMs(default1500), maxWaitMs(default8000), separator(default "\\n\\n---\\n\\n")}` 账户字段（default enabled=true，与 upstream createDeliverDebouncer 一致）。
5. **修改 `extensions/qqbot/src/bot.ts`**：在 deliver 入口（约 bot.ts:3560 `deliver` 处理）包一层 `debouncer`，executor 调用现有 `sendC2CMarkdownTransportPayload`/静态发送。**注意**：`replyFinalOnly` 与 deliverDebounce 语义重叠（都是合并 deliver），需在 `evaluateReplyFinalOnlyDelivery` 之上加优先级——replyFinalOnly 激活时不叠 deliverDebounce，避免双重缓冲。

#### 阶段四（高复杂度，可缓做）：内联富媒体流式

6. 仅当需要"流式中途插图"时才做。需把 upstream `utils/media-tags.ts`/`utils/media-send.ts`（`normalizeMediaTags`/`stripIncompleteMediaTag`/`findFirstClosedMediaTag`/`executeSendQueue`/`StreamingMediaContext`/`sendMediaQueue skipInterTagText`）移植进 fork，并给 `QQBotStreamingController` 注入 `mediaContext`，把 `processMediaTags` 循环 + `sentIndex` 断点续传接进 fork 的全量 REPLACE 模型（需把 `content_raw` 从全量改为 `slice(sentIndex)` 增量——这是与 fork 现有模型最大的语义冲突，建议先做 PoC）。**若不做，保留 fork 现状（媒体触发 fallback 静态 transport），不影响其余移植。**

#### fork→upstream 映射

- fork `QQBotStreamingController.onPartialReply`（streaming.ts:71）→ upstream `StreamingController.onPartialReply`（streaming.ts:417）+ `_doPartialReply`（streaming.ts:437）；边界检测逻辑对齐 streaming.ts:457-468。
- fork `scheduleFlush`/`flushNow`（streaming.ts:167-214）→ upstream `FlushController.throttledUpdate`/`performFlush`（streaming.ts:163-189,947-979）。
- fork `finalize`（streaming.ts:99）→ upstream `finalizeOnIdle`（streaming.ts:575-609）三分支。
- fork `shouldFallbackToStatic`（streaming.ts:63）→ upstream `shouldFallbackToStatic`（streaming.ts:350，语义统一为 terminal+zeroChunks）。
- fork `startQQBotTypingHeartbeat`（bot.ts:722）= upstream `TypingKeepAlive`（typing-keepalive.ts:13）的严格超集；**不移植 upstream typing**，保留 fork 全部配置。
- fork `qqbotOutbound.sendTyping`（outbound.ts:657）→ upstream `sendC2CInputNotify`（api.ts:696）：均走 C2C input_notify，fork 已封装进 contract，无需改。
- 新增 fork `deliverDebounce` 字段 → upstream `DeliverDebouncer`（deliver-debounce.ts:39）；executor 桥接 fork `sendC2CMarkdownTransportPayload`。

#### 与 fork 契约/shared 的集成点

- `streaming.ts` 仅依赖 `client.ts` 的 `allocateMsgSeq`/`getAccessToken`/`sendC2CStreamMessage`/`QQBotStream*` 枚举（streaming.ts:1-8），移植后依赖不变。
- typing 走 `qqbotOutbound.sendTyping`（outbound.ts:657 → client.ts:402 `sendC2CInputNotify`），与 shared 无直接耦合。
- markdown 投递走 fork 原生 `sendC2CMarkdownTransportPayload`（bot.ts:3404+）+ shared `runtime.channel.text`（resolveTextChunkLimit/chunkMarkdownText/resolveChunkMode/resolveMarkdownTableMode，bot.ts:3306-3329），保留。
- deliverDebounce 是纯逻辑模块，仅新增 config 字段，不触碰 shared。

### 测试计划

新增/扩展测试（fork 现有 `bot.streaming.test.ts`/`bot.c2c-markdown-chunking.test.ts`/`bot.reply-final-only.test.ts` 为基线）：
1. **边界检测回归**：构造 partial 序列 "abc" → "abcde" → "xy"（非前缀延续，模拟新回复），断言开新流式会话、msgSeq/index 重置；再构造 normalize 后长度波动但 raw 前缀一致的序列，断言**不**误开新会话（旧实现 `length<` 会误判）。
2. **FlushController 互斥 + reflush**：在高频 onPartialReply（间隔 < throttleMs）下，断言 flush 串行、冲突时触发一次 reflush 跟进、长间隔（>2000ms）后首次 flush 延迟 300ms 批处理。
3. **finalize 三分支**：mock stream start 成功→finalize 发 DONE；mock start 失败但已有 chunk→finalize 标 completed 不发；mock 零 chunk→`shouldFallbackToStatic===true`。
4. **状态机终态短路**：finalize 后再调 onPartialReply，断言被终态短路（不二次开流式）。
5. **deliverDebounce（阶段三）**：连续 3 条纯文本 deliver（间隔 100ms < windowMs 1500）断言合并为 1 条（separator 拼接）；含 media 的 deliver 断言先 flush 缓冲再发媒体；maxWaitMs 到达断言强制 flush；replyFinalOnly 激活时断言 deliverDebounce 不生效（不双重缓冲）。
6. **typing 配置回归**：mode=idle 且 lastVisibleOutboundAt 新鲜→断言不续期；mode=always→无条件续期；mode=none→不启心跳；onFirstChunk→心跳 stop。已有 bot.streaming.test.ts 覆盖，扩展断言 `renewalInFlight` 防重入。
7. **C2C markdown 模式回归**（防回归）：proactive-table-only + 含表格→forceProactive 丢弃 replyToId/eventId；passive→保留 replyToId；proactive-all→总是 forceProactive。block 分块按表/代码块边界切分且每块 UTF-8 ≤ safeChunkByteLimit。
8. **replyFinalOnly 回归**：非 final delta 全部缓冲、tool delta 不缓冲、final delta 触发 flush 合并发送。

### 风险与注意事项

- **最高风险：streaming.ts 全量 REPLACE vs upstream sentIndex 增量语义冲突**。upstream `performFlush` 发 `slice(sentIndex)`（streaming.ts:955），fork `sendChunk` 发 `latestText` 全量（streaming.ts:262）。阶段一/二移植时**必须保留 fork 的全量 content_raw**，只借 upstream 的调度/边界/状态机骨架；阶段四若做内联媒体流式才转增量，需 PoC 验证 QQ stream API 对增量 vs 全量的行为差异。
- **`bot.ts:3300-3700` deliver 决策树深度耦合**：`streamingEnabled`/`useC2CMarkdownTransport`/`replyFinalOnly`/`streamingOwnsAssistantText`/`shouldBufferStructuredMarkdownPayload` 交织（bot.ts:3337-3620）。阶段一/二保持 `QQBotStreamingController` 公共 API 不变即可零改动 bot.ts；阶段三 deliverDebounce 必须接在 `evaluateReplyFinalOnlyDelivery` 之后并处理优先级，否则双重缓冲。
- **类名/构造器差异**（corrections 已述）：上游 `StreamingController(StreamingControllerDeps)` vs fork `QQBotStreamingController(QQBotStreamingControllerParams)`，不可 drop-in，需 deps 适配。
- **typing 不移植**：upstream `TypingKeepAlive` 固定 50s/60s 是 fork 真子集，移植会**丢失** fork 的 mode/interval/inputSecond 可配，明确拒绝。
- **deliverDebounce 与 replyFinalOnly 语义重叠**：两者都合并 deliver。默认 `enabled=true`（与 upstream 一致）可能与现有 `replyFinalOnly=false` 用户的非 final deliver 行为产生变化（消息更少/更合并）。需在配置文档标注，并提供 `deliverDebounce.enabled=false` 关闭。
- **monitor.ts / WS 心跳不在范围**：fork 多账户 `activeConnections` 与 upstream gateway.ts 单账户结构不同，勿合并。

## 4.10 主动消息 / 引用索引 / 队列与会话 (Proactive / Ref-Index / Queue & Session)

本子系统覆盖三块能力：(1) 主动消息（已知目标/用户存储 + 主动发送）；(2) 引用索引（quoted-message 上下文缓存与跨设备回退）；(3) 队列/分发/会话（message-queue、reply-dispatcher、deliver-debounce、session-store）。这是上游与 fork 架构差异最大的子系统：fork 把队列与分发外包给 OpenClaw host runtime，而 upstream 自带全套 in-plugin 实现。因此本次升级是**能力择优移植（capability port）**，而非文件整体移植。

### 现状对比

**Fork 现状**

- **已知目标存储**（`src/proactive.ts:17-251`）：使用单一现代化 `KnownQQBotTarget` 接口（`accountId`/`kind` user|group|channel/`target`/`displayName?`/`sourceChatType: QQChatType`/`firstSeenAt`/`lastSeenAt`），持久化到 `~/.openclaw/qqbot/data/known-targets.json`（`proactive.ts:8`）。提供完整的 CRUD（`upsertKnownQQBotTarget`/`getKnownQQBotTarget`/`listKnownQQBotTargets`/`removeKnownQQBotTarget`/`clearKnownQQBotTargets`，152-250）。带旧路径迁移 `migrateLegacyKnownTargets`（`~/.openclaw/data/qqbot/known-targets.json` → 新路径，60-75）。该存储被 `bot.ts` 实时消费：`getKnownQQBotTarget`（`bot.ts:499`，DM 显示名优先级）、`upsertKnownQQBotTarget`（`bot.ts:3920`，入站时记录）。
- **主动发送**（`src/proactive.ts:252-285`）：`sendProactiveQQBotMessage` 委托给 `qqbotOutbound.sendText`/`sendMedia`（复用 outbound 契约）。`src/send.ts` 提供命令行主动发送入口。
- **引用索引存储**（`src/ref-index-store.ts`）：自包含 JSONL 缓存。`RefIndexEntry`（15-22）、`RefAttachmentSummary`（5-13）。常量 `REF_INDEX_FILE`（34）、`MAX_CONTENT_LENGTH=500`（35，截断保护）、`MAX_ENTRIES=50000`（36）、`TTL_MS=7天`（37）。关键加固函数：`normalizeRefIdx`（43-46）、`truncateContent`（52-54）、`sanitizeAttachmentSummary`（56-79，空值剔除）、`sanitizeEntry`（81-97）。`formatAttachmentSummary`（230-267）是 fork 自带的、带中文标签（`[图片]`/`[语音消息: ... (官方识别)]`/`[视频]`/`[文件]`）的附件格式化器，**不依赖**外部 processAttachments/parseFaceTags。公共 API：`setRefIndex`（269-292）、`getRefIndex`（294-310）、`formatRefEntryForAgent`（312-321）、`flushRefIndex`（323-327）。
- **引用上下文注入**（`src/bot.ts:610-643, 3146-3252`）：`parseQQBotRefIndices`（610-643）**仅**从 `message_scene.ext` 解析 `ref_msg_idx=`/`msg_idx=`。`bot.ts:3151-3163` 处理引用：命中缓存 → `formatRefEntryForAgent`；未命中 → 直接 `replyToBody = QQ_QUOTE_BODY_UNAVAILABLE_TEXT`（"原始内容不可用"，`bot.ts:668`），**无任何事件负载回退**。出站侧 `outbound.ts:237-271` `recordOutboundC2CRefIndex` 在每次 C2C 发送后写回 ref-index（`outbound.ts:435,510,638`）。
- **队列/分发**：fork **不存在** session-store.ts、reply-dispatcher.ts、deliver-debounce.ts、message-queue.ts。回复分发完全外包给 host runtime：`runtime.ts:56-99` 暴露 `channel.reply.dispatchReplyWithDispatcher` / `dispatchReplyWithBufferedBlockDispatcher` / `createReplyDispatcherWithTyping`，由 `bot.ts` 调用。`outbound.ts` 的 `sendText`（291-435）发送时只调用一次 `getAccessToken`（307），**无 401/token 重试**；其重试逻辑仅是 `shouldRetryWithEventId`（130，针对 eventId 回退，非 token 刷新）。

**上游现状（v1.7.2）**

- **已知用户存储有 *两套***：`known-users.ts`（现代化、被 gateway 实时消费）字段含 `interactionCount`、`firstSeenAt`/`lastSeenAt`、`groupOpenid`，5 秒写入节流（`SAVE_THROTTLE_MS=5000`），`recordKnownUser`/`flushKnownUsers` 在 `gateway.ts:1897-1918` 每条入站调用，702 行 shutdown 时 flush。`proactive.ts` 内部又自带一套过时的 `KnownUser`（firstInteractionAt/lastInteractionAt，无 interactionCount，`proactive.ts:19-26,78`），与 known-users.ts 数据模型冲突——upstream 自身存在重复存储。
- **主动发送**（`proactive.ts:300-511`）：`sendProactive`/`sendBulkProactiveMessage`/`broadcastMessage`/`sendProactiveMessageDirect`，直接调 `api.ts`（`sendProactiveC2CMessage`/`sendProactiveGroupMessage`/`sendC2CImageMessage`），自带 500ms 节流。
- **引用索引存储**（`ref-index-store.ts`）：核心结构与 fork 同构（JSONL + 缓存 + compact + TTL），但**额外**提供：`formatMessageReferenceForAgent`（321-385）——缓存未命中时从事件负载实时重建被引用内容（调 `processAttachments` 下载附件 + `formatVoiceText` 语音转录 + `parseFaceTags` 表情解析 + `buildAttachmentSummaries` 构建摘要）；`getRefIndexStats`（399-412，调试统计）。附件格式化委托给 `group-history.ts` 的 `formatAttachmentTags`（19），而非 fork 的自包含 `formatAttachmentSummary`。
- **引用解析**：`utils/text-parsing.ts:45-69` `parseRefIndices(ext, messageType, msgElements)` ——当 `messageType===MSG_TYPE_QUOTE` 时用 `msgElements[0].msg_idx` 覆盖 ext 解析结果（更权威）。gateway.ts:924-948 三级回退：缓存命中 → `formatRefEntryForAgent`；缓存未命中且 `msgType===MSG_TYPE_QUOTE` → `formatMessageReferenceForAgent(msgElements[0])`；否则仅记日志。
- **Session 存储**（`session-store.ts`）：持久化 WebSocket `sessionId`/`lastSeq`/`intentLevelIndex`/`appId`，5 分钟 TTL（`SESSION_EXPIRE_TIME`，34）、appId 变更检测（94-102）、1 秒写入节流（`SAVE_THROTTLE_MS`，37）、`loadSession`/`saveSession`/`clearSession`/`updateLastSeq`/`getAllSessions`/`cleanupExpiredSessions`。支持 Resume。
- **Reply Dispatcher**（`reply-dispatcher.ts`）：`sendWithTokenRetry`（31-52）——捕获 `401`/`token`/`access_token` 错误 → `clearTokenCache(appId)` → 重新 `getAccessToken` 并重试一次；`sendTextToTarget`（57-74）做 c2c/group/channel/dm 文本路由；`handleStructuredPayload`（91-145）+ `handleImagePayload`/`handleAudioPayload`/`handleVideoPayload`/`handleFilePayload`（149-334）做完整媒体路由。
- **Deliver Debounce**（`deliver-debounce.ts`）：`DeliverDebouncer` 类（windowMs=1500 / maxWaitMs=8000 / separator=`\n\n---\n\n`），纯文本 deliver 缓冲合并、媒体 deliver 立即 flush，`createDeliverDebouncer` 工厂（enabled=false 时返回 null）。
- **Message Queue**（`message-queue.ts`）：`createMessageQueue`（164-354），按用户并发（同用户串行、跨用户并行、`maxConcurrentUsers=10`），群聊/私聊不同队列上限（50/20），群溢出优先丢弃 bot 消息，群消息合并 `mergeGroupMessages`（91-154），斜杠指令穿透逐条处理，`clearUserQueue`/`executeImmediate`。

### 差距清单

上游有而 fork 缺失的能力（按价值排序）：

1. **跨设备引用回退（最高价值）**：`formatMessageReferenceForAgent` + `MSG_TYPE_QUOTE` + `msg_elements[0]` 解析（`ref-index-store.ts:321-385`、`gateway.ts:934-944`）。fork 在缓存未命中时直接返回 `QQ_QUOTE_BODY_UNAVAILABLE_TEXT`（`bot.ts:3160`），丢失全部引用上下文。当用户在新设备/重启后引用一条 fork 未缓存的消息时，AI 完全看不到被引用内容——这是真实的跨设备正确性回归。
2. **`parseRefIndices` 的 MSG_TYPE_QUOTE 权威覆盖**（`text-parsing.ts:61-67`）：fork 的 `parseQQBotRefIndices`（`bot.ts:610-643`）只读 ext，不读 `msg_elements[0].msg_idx`，引用场景下 refMsgIdx 可能不够权威。
3. **`sendWithTokenRetry` / 401 token 自动刷新**（`reply-dispatcher.ts:31-52`）：fork `outbound.ts:307` 单次 `getAccessToken` 无重试，token 过期时整条消息失败。fork 的 `shouldRetryWithEventId`（130）只处理 eventId 回退，不处理 token。
4. **Message Queue 按用户并发控制**（`message-queue.ts:164-354`）：同用户串行、跨用户并行、群消息合并、斜杠穿透、`clearUserQueue`/`executeImmediate`。fork 完全依赖 host runtime 排队。
5. **Deliver Debounce / 防消息轰炸合并**（`deliver-debounce.ts`）：fork 无此层，连续 deliver 会被逐条发出。
6. **Session 持久化 / WebSocket Resume**（`session-store.ts`）：fork 的 `monitor.ts` 仅松散引用 sessionId，无持久化、无 appId 变更检测、无 Resume 支持。
7. **`interactionCount` 追踪**（`known-users.ts` KnownUser.interactionCount）：fork 的 `KnownQQBotTarget`（`proactive.ts:17-25`）无交互次数字段。
8. **`getRefIndexStats` 调试导出**（`ref-index-store.ts:399-412`）：fork 无统计导出。

### 必须保留

China-fork 独有、升级时不得丢弃的特性：

- **`KnownQQBotTarget` 统一存储 + 多账户 accountId 键控 + `displayName` + `sourceChatType: QQChatType`**（`proactive.ts:17-25`）：比上游 KnownUser 更丰富（displayName、sourceChatType、kind 三态 user|group|channel）。**不要**用上游 `proactive.ts` 的过时 KnownUser（无 interactionCount、字段名不一致）覆盖它。
- **旧路径迁移 `migrateLegacyKnownTargets`**（`proactive.ts:60-75`）：`~/.openclaw/data/qqbot/known-targets.json` → `~/.openclaw/qqbot/data/known-targets.json`，rename 失败则 copy+rm。`proactive.path-migration.test.ts` 覆盖此行为。
- **`displayAliases` 配置映射 + known-target displayName 优先级**（`bot.ts:484-485,499-507`）：DM 显示名优先取 known-target.displayName，其次 displayAliases。`config.ts` 的 `displayAliasesSchema`/`normalizeDisplayAliasesMap`。
- **`recordOutboundC2CRefIndex`**（`outbound.ts:237-271`）：出站 C2C 发送后写回 ref-index，使机器人自己的回复可被后续引用。上游无此对称写回逻辑。
- **ref-index 自包含加固层**：`MAX_CONTENT_LENGTH=500` 截断（`ref-index-store.ts:35,52-54`）、`normalizeRefIdx`（43-46）、`sanitizeEntry`（81-97）、`sanitizeAttachmentSummary`（56-79）、自包含中文 `formatAttachmentSummary`（230-267）。上游 ref-index-store 无此加固（直接透传，无截断/无 sanitize）。
- **China 出站特性**（上游 reply-dispatcher/queue 不得覆盖）：c2c markdown 传输（`markdownSupport`/`groupMarkdown`，`outbound.ts:308-309`）、流式投递、typing 心跳/keepalive、`sendTextAsFollowupForMedia` 媒体后补发文本（`outbound.ts:548-641`）、`parseTarget` 目标前缀解析（group:/channel:/user:/c2c:）。
- **host-runtime 分发委托**（`runtime.ts:56-99`）：fork **刻意**把回复分发外包给 OpenClaw host，与 upstream in-plugin `reply-dispatcher.ts` 设计哲学相反。不得用上游 reply-dispatcher 整体替换。

### 实施方案

总体策略：**逐项择优移植，不整体移植文件**。按依赖与风险分三波。

**前置依赖（必先做，阻塞第 1 项）**：移植 `processAttachments` / `parseFaceTags` / `buildAttachmentSummaries` / `formatVoiceText`（来自 upstream `inbound-attachments.ts`、`utils/text-parsing.ts`、`group-history.ts`）。fork 当前无这些导入。跨设备引用回退（`formatMessageReferenceForAgent`）硬依赖它们——脱离此管线无法独立移植。建议落到 `extensions/qqbot/src/` 下新建 `inbound-attachments.ts` 与 `utils/text-parsing.ts`（fork 已有 `utils` 风格可参照），并使 `formatAttachmentTags` 与 fork 的 `formatAttachmentSummary`（`ref-index-store.ts:230-267`）输出格式对齐，避免引用标签在缓存命中 vs 未命中两条路径上不一致。

**第 1 波（P0，最高价值，跨设备引用回退）**

- 修改 `src/ref-index-store.ts`：新增 `formatMessageReferenceForAgent`（移植自 upstream 321-385，但**保留** fork 的 sanitize 包装——入参先过 `sanitizeEntry` 再格式化）、`getRefIndexStats`（移植 399-412）。`formatRefEntryForAgent` 保持调用 fork 自有 `formatAttachmentSummary`，不切换到 `formatAttachmentTags`。
- 修改 `src/bot.ts`：(a) 在入站解析中读取 `message_type`/`msgType` 与 `msg_elements`，扩展 `parseQQBotRefIndices`（610-643）支持 MSG_TYPE_QUOTE 时 `msgElements[0].msg_idx` 覆盖（移植 `text-parsing.ts:61-67`）；需在 `src/types.ts` 导出 `MSG_TYPE_QUOTE` 常量。(b) 改造 `bot.ts:3151-3163` 的引用回退：缓存命中 → `formatRefEntryForAgent`（不变）；未命中且 `msgType===MSG_TYPE_QUOTE` 且 `msgElements[0]` 存在 → `await formatMessageReferenceForAgent(msgElements[0], {appId, peerId, cfg, log})`；否则保留 `QQ_QUOTE_BODY_UNAVAILABLE_TEXT`。注意 `formatMessageReferenceForAgent` 是 async，而当前该块是同步的——需将外层引用处理改为 async（bot.ts 该函数已是 async，可安全 await）。

**第 2 波（P1，token 重试 + interactionCount + stats）**

- 修改 `src/outbound.ts`：在 `sendText`（291）及 `sendMedia`/`sendMediaAsFollowup` 中引入 token 重试。不整体引入 upstream reply-dispatcher.ts，而是新增一个 fork 内部 helper `sendWithTokenRetry(appId, clientSecret, sendFn)`（移植 `reply-dispatcher.ts:31-52`），在 fork 的 `client.ts`/`outbound.ts` 调用 `getAccessToken`+发送的位置包一层。需确认 fork 的 `client.ts` 是否已暴露 `clearTokenCache`（上游 api.ts 有；fork client.ts 需补等价能力或直接调底层）。
- 修改 `src/proactive.ts`：在 `KnownQQBotTarget`（17-25）新增可选 `interactionCount?: number`；`upsertKnownQQBotTarget`（152-179）在更新现有条目时 `interactionCount = (existing.interactionCount ?? 0) + 1`，新建时置 1。`normalizeKnownQQBotTarget`（84-100）透传该字段。保持向后兼容（旧 JSON 无此字段时按 0 处理）。
- `getRefIndexStats`（第 1 波已加）暴露给 fork 的诊断/监控（如有 admin 工具）。

**第 3 波（P2，队列/Debounce/Session——谨慎，架构耦合最深）**

这三个上游模块与 `gateway.ts` 强耦合（gateway 用 message-queue + session-store + deliver-debounce 编排整个入站生命周期），而 fork 用 `bot.ts` + host-runtime dispatch 替代了 gateway。**不建议整体移植**，而是按需摘取：

- **Deliver Debounce**：相对独立，可在 fork 的 host-runtime dispatcher `deliver` 回调（`runtime.ts:67` 的 `deliver`/`bot.ts` 调用处）与实际 `qqbotOutbound.sendText` 之间插入 `DeliverDebouncer`（移植 `deliver-debounce.ts` 整文件，约 230 行，依赖少）。新增 `src/deliver-debounce.ts`，在 `bot.ts` 构造 dispatcher 时用 `createDeliverDebouncer` 包装 executor。注意保留 fork 的 markdown/流式/typing 不被 debounce 吞掉（媒体 deliver 立即 flush 的语义正好兼容）。
- **Message Queue**：fork 已有 host-runtime 排队，再叠一层 in-plugin queue 会双重排队。**建议不移植**整体，仅摘取 `mergeGroupMessages`（群消息合并，91-154）与 `clearUserQueue`/`executeImmediate`（停指令时清队列）这类无并发模型冲突的子能力，按需集成到 fork 的 `/stop` 指令路径（`bot.stop-command.test.ts` 相关）。
- **Session Store**：与 fork 的 `monitor.ts`（WebSocket 管理）强相关。若 fork 需支持断线 Resume，可移植 `session-store.ts` 整文件并接入 `monitor.ts` 的连接/重连逻辑；但这是独立大特性，**建议单独立项**，不在本子系统本轮一并落地，避免 scope 蔓延。

**集成点（fork 契约/shared）**

- ref-index 回退的 `formatMessageReferenceForAgent` 需要从 `bot.ts` 拿到 `appId`/`peerId`/`cfg`/`log`，这些在 `bot.ts` 入站处理上下文均已可用。
- token 重试需接入 fork 的 `client.ts`（`getAccessToken`）与配置层 `resolveQQBotCredentials`（`outbound.ts:301`）。
- `KnownQQBotTarget.interactionCount` 不影响 `bot.ts:499` 的 displayName 解析路径，纯增量字段。

### 测试计划

针对每个波次，fork 已有测试基线（`bot.ref-index.test.ts`、`bot.known-targets.test.ts`、`proactive.path-migration.test.ts`、`proactive.test.ts`、`outbound.test.ts`）：

1. **跨设备引用回退**：构造 `msgType===MSG_TYPE_QUOTE` 且 ref-index 缓存未命中的入站事件，`msgElements[0]` 含文本+图片附件 → 断言 `replyToBody` 不再是 "原始内容不可用"，而是重建后的内容（含图片标签）。覆盖 (a) 有 msgElements、(b) MSG_TYPE_QUOTE 但 msgElements 为空（应仍回退到不可用文本且不抛错）、(c) 非 QUOTE 类型缓存未命中（保持不可用文本）。
2. **parseQQBotRefIndices 权威覆盖**：ext 给出 ref_msg_idx=A，但 msgType=QUOTE 且 msgElements[0].msg_idx=B → 断言 refMsgIdx===B。
3. **token 重试**：mock `getAccessToken` 第一次抛 401/"access_token expired"、`clearTokenCache` 被调用、第二次成功 → 断言 `sendText` 最终成功且只发一次。覆盖非 401 错误（应不重试、直接抛）。
4. **interactionCount**：连续 `upsertKnownQQBotTarget` 同一 target 三次 → 断言 `interactionCount===3`；读取旧无字段 JSON 后再 upsert → 断言兼容（从 0 或 1 起计，不 NaN）。
5. **getRefIndexStats**：set 若干条后断言 size/totalLinesOnDisk/filePath 正确；compact 后 totalLinesOnDisk 回落。
6. **Deliver Debounce（若移植）**：连续 3 次 deliver 纯文本（间隔 < windowMs）→ 断言 executor 只被调一次且文本含 separator 合并；插入一次媒体 deliver → 断言缓冲文本先 flush 再发媒体。
7. **回归**：跑现有 `bot.ref-index.test.ts`、`bot.known-targets.test.ts`、`proactive.path-migration.test.ts`、`bot.stop-command.test.ts`、`bot.streaming.test.ts`，确保 displayName 解析、旧路径迁移、停指令、流式投递不受影响。

### 风险与注意事项

- **最高风险：存储架构倒置**。fork 的 `KnownQQBotTarget`（proactive.ts）等价于上游 `known-users.ts`，而上游 `proactive.ts` 自带的 KnownUser 是过时重复存储。**严禁**用上游 proactive.ts 的存储覆盖 fork 存储——会丢 displayName/sourceChatType/多账户键控，并引入字段名冲突。上游 proactive.ts 仅作为 sendProactive/broadcast API 形态的参考。
- **双重分发/双重排队冲突**：fork 把分发/排队外包给 host runtime，若整体移植 upstream 的 message-queue.ts/reply-dispatcher.ts 会与 host dispatch 冲突（双重排队、顺序错乱）。必须坚持摘取子能力（token 重试、群合并、clearUserQueue），不引入其并发编排模型。
- **`formatMessageReferenceForAgent` 是 async**：fork `bot.ts:3151-3163` 当前引用处理在同步块内，需确认该块所在函数已是 async 且该 await 不阻塞后续 setRefIndex/信封构建。gateway.ts 中该 await 在附件并行下载完成之后，fork 应对齐时序（避免在未 await 完附件下载前就 await 引用回退）。
- **附件标签格式一致性**：fork `formatAttachmentSummary`（中文 `[图片]`/`[语音消息]`）与上游 `formatAttachmentTags` 输出格式可能不同。跨设备回退路径若用上游格式化器，会导致「缓存命中」与「缓存未命中回退」两条路径对同一附件给出不同标签。移植时需统一为 fork 的中文标签风格。
- **sanitize 不可丢**：上游 ref-index-store 无 `MAX_CONTENT_LENGTH` 截断与 sanitize，移植 `formatMessageReferenceForAgent` 时务必用 fork 的 `sanitizeEntry` 包裹其输出，否则超长/恶意内容会污染缓存与上下文。
- **token 重试的无限循环防护**：`sendWithTokenRetry` 只重试一次（upstream 31-52 的结构保证），移植时不得改成循环重试，否则 token 持续无效时会刷屏。
- **session-store 与 monitor.ts 耦合**：本轮不建议落地，避免与 monitor.ts 的 WebSocket 生命周期管理冲突，单独立项。
- **路径并非真正分歧**：fork `ref-index-store.ts:34` 与 upstream `getQQBotDataDir('data')`（60）解析到同一 `~/.openclaw/qqbot/data/`，ref-index.jsonl 跨版本兼容，无需迁移文件。


## 4.11 Skills & Tools (registerTool: channel_api / remind; skills)

### 现状对比

**Fork 现状（@openclaw-china/qqbot 2026.3.9-1）**

- 工具注册面：**为零**。整个 fork 仓库 grep `registerTool` 无任何命中。插件入口 `extensions/qqbot/index.ts:11-15` 定义的 `MoltbotPluginApi` 仅声明 `registerChannel` 与 `runtime`；`register(api)`（`index.ts:149-157`）只调用 `api.registerChannel({ plugin: qqbotPlugin })`，从不注册任何 model-callable tool。姊妹扩展 wecom-kf 使用完全相同的 registerChannel-only API（`extensions/wecom-kf/index.ts:24-25`、`extensions/wecom-kf/src/types.ts:227-228`）。
- 渠道插件契约：`qqbotPlugin`（`src/channel.ts:64`）是一个结构化 `ChannelPlugin` 对象，暴露 `meta/capabilities/messaging/configSchema/reload/onboarding/config/security/setup/outbound/gateway` 等槽位，但**没有 `tools` 槽位**——结构化 channel 契约里没有声明工具的钩子。
- Skills：恰好一个，`skills/qqbot-contact-send/SKILL.md`，是收件人解析助手。它读取 `~/.openclaw/qqbot/data/known-targets.json`，用两个 Python 脚本（`scripts/resolve_known_target.py`、`scripts/prepare_send.py`）做 ranked displayName/target/substring 匹配 + lastSeenAt 排序，最后产出 `channel:"qqbot"`/`target`/`accountId` 的 `message` 工具负载。manifest `openclaw.plugin.json` 用 `"skills": ["./skills"]` 声明。
- Token / API base：fork **已有** `getAccessToken(appId, clientSecret, options?)`（`src/client.ts:130-172`，appId 维度 token 缓存 `tokenCacheMap`，`Authorization: QQBot {token}` 头）与 `API_BASE = "https://api.sgroup.qq.com"`（`src/client.ts:3`）。被 `send.ts:6/162`、`monitor.ts:14/269/338`、`outbound.ts:16` 复用。
- 富媒体：fork 走 `markdown-images.ts`（`MARKDOWN_IMAGE_RE`，`src/markdown-images.ts:24`）+ bot.ts 的 `extractQQBotReplyMedia`（`src/bot.ts:1392`）→ `extractMediaLinesFromText`（解析 `MEDIA:` 行，`src/bot.ts:1363`）+ `extractLocalMediaFromText`（解析 markdown 图片/链接/裸路径，`src/bot.ts:1293`）。媒体类型判定与路径处理复用 `@openclaw-china/shared` 的 `detectMediaType`/`extractMediaFromText`/`isLocalReference`/`stripTitleFromUrl`（`bot.ts:17-24`，实现在 `packages/shared/src/media/media-parser.ts`）。受 `autoSendLocalPathMedia` 开关控制（`config.ts:143` `resolveQQBotAutoSendLocalPathMedia`，`bot.ts:1401`）。**无 `<qqmedia>` 标签、无模糊别名归一化。**
- 每请求上下文：**无 AsyncLocalStorage**。grep `AsyncLocalStorage`/`runWithRequestContext`/`getRequestTarget`/`getRequestAccountId` 在 `extensions/qqbot/src` 下零命中。入站 target/accountId 仅在入站派发局部可见：`monitor.ts:316-323` 以 `cfg + accountId` 调 `handleQQBotDispatch`；`bot.ts:1249-1282` 由 inbound 构造 `user:`/`group:`/`channel:` target。这些值从未传播到工具可读的作用域。
- 提醒：**无**。无 `qqbot_remind` 工具，无 cron/相对时间解析。`packages/shared/src/cron/index.ts` 提供了 cron 工具契约（`CRON_HIDDEN_PROMPT` 要求 `payload.kind=agentTurn`、`delivery.mode=announce`、`sessionTarget=isolated`），但 fork 没有任何前端工具把简单参数转成该 cron 工具负载。

**上游现状（@tencent-connect/openclaw-qqbot v1.7.2）**

- 自带守护式 daemon plugin：根 `index.ts:14-19` `register(api)` 依次 `api.registerChannel({plugin})` + `registerChannelTool(api)` + `registerRemindTool(api)`，三个调用都直接打在 `OpenClawPluginApi` 上。
- 工具 1 — `qqbot_channel_api`（`src/tools/channel.ts:113` `registerChannelTool`）：QQ 开放平台 HTTP 代理，参数 `method/path/body/query`（`ChannelApiSchema` `channel.ts:19-49`），支持 GET/POST/PUT/PATCH/DELETE，`validatePath` 做 SSRF 防护（`channel.ts:83-95`），30s `AbortController` 超时（`channel.ts:6,191-223`），自动 `getAccessToken` 注入 `Authorization: QQBot {token}`（`channel.ts:182-189`）。覆盖频道/子频道/成员/公告/论坛/日程。token 来源：从 `api.ts` 导入的 `getAccessToken` 与 `API_BASE`（`api.ts:57,145`）。账号选取：`listQQBotAccountIds`/`resolveQQBotAccount`（`channel.ts:120-127`）取第一个已配置账号。
- 工具 2 — `qqbot_remind`（`src/tools/remind.ts:221` `registerRemindTool`）：`action=add/list/remove`（`RemindSchema` `remind.ts:31-74`），相对时间解析 `parseRelativeTime`（`remind.ts:89-115`，支持 `5m/1h30m/2d/30s`、纯数字按分钟），cron 判定 `isCronExpression`（3-6 段，`remind.ts:120-123`），≥30s 下限（`remind.ts:292-294`）。`add` 返回 `cronParams`（`buildOnceJob`/`buildCronJob`，`remind.ts:137-191`）含 `payload.kind=agentTurn`、`delivery={mode:"announce",channel:"qqbot",to,accountId}`、`sessionTarget=isolated`，模型须原样转发给 `cron` 工具。target/accountId 自动从 `getRequestTarget()`/`getRequestAccountId()`（`request-context.ts:39-49`，AsyncLocalStorage）解析，模型通常无需手填 `to`。
- Skill：`qqbot-remind/SKILL.md`（强制规则「必须调工具不能只口头承诺」+ cron 速查）、`qqbot-media/SKILL.md`（`<qqmedia>` 标签 + 大小上限 图片30MB/语音20MB/视频与文件100MB）、`qqbot-channel/SKILL.md`（接口速查表）+ `references/api_references.md`（521 行）、`qqbot-upgrade/SKILL.md`（`curl ... tencent-connect/openclaw-qqbot main scripts/upgrade-via-npm.sh | bash`）。
- 富媒体标签归一化：`src/utils/media-tags.ts`（183 行），`VALID_TAGS=[qqimg,qqvoice,qqvideo,qqfile,qqmedia]`，`TAG_ALIASES` 约 50 个模糊别名（img/image/pic/photo/voice/audio/video/file/doc/media/attach/send …），`FUZZY_MEDIA_TAG_REGEX` + `SELF_CLOSING_TAG_REGEX` 容忍中文尖括号/缺斜杠/引号包裹/markdown 反引号包裹。由 `src/utils/media-send.ts:14` `normalizeMediaTags` 引入，在 `outbound-deliver.ts`/`outbound.ts`/`streaming.ts` 的发送路径解析标签并路由到 sendPhoto/sendVoice/sendVideoMsg/sendDocument/sendMedia。

### 差距清单（上游有、fork 缺）

1. **工具注册面整体缺失**：fork 的 `MoltbotPluginApi` 与 `ChannelPlugin` 契约都没有 `registerTool`，无法把任意 `qqbot_*` 工具注册给模型。这是上游两个工具落地的前置阻塞，必须先解决。
2. **`qqbot_remind` 工具 + 相对时间/cron 解析**：`parseRelativeTime`/`isCronExpression`/`buildOnceJob`/`buildCronJob`/`buildReminderPrompt`/`formatDelay`（remind.ts:89-217）全套缺失。fork 用户无法用「5分钟后提醒我」创建定时任务。
3. **`request-context`（AsyncLocalStorage）**：`runWithRequestContext`/`getRequestContext`/`getRequestTarget`/`getRequestAccountId`（request-context.ts:9-49）缺失，导致即使搬来 remind.ts，target/accountId 也无法自动解析。
4. **`qqbot_channel_api` 工具**：频道/子频道/成员/公告/论坛/日程的 GET/POST/PUT/PATCH/DELETE 代理（channel.ts 全文）缺失。token 基础设施 fork 已具备（client.ts:130），但 `validatePath` SSRF 校验、30s 超时、`buildUrl` query 拼接需要随工具一起引入。
5. **`qqbot-channel` skill + `references/api_references.md`**：~30 接口的模型参考文档缺失。
6. **`<qqmedia>` 标签 + `media-tags.ts` 模糊归一化**：fork 没有任何 `qqmedia`/`qqimg`/`qqvoice`/`qqvideo`/`qqfile` 解析。shared 的 `media-parser.ts` 只认 `MEDIA:` 行/markdown 图片/html `<img>`/裸路径，不认 qq 标签。
7. **`qqbot-media` skill**：标签用法文档与大小上限说明缺失。
8. **`qqbot-remind` skill**：强制调工具的提示词与 cron 速查缺失。

（`qqbot-upgrade` skill 见「必须保留/风险」——不可原样移植。）

### 必须保留（China-fork 本子系统特性，移植全程不得破坏）

- `skills/qqbot-contact-send/`（SKILL.md + `resolve_known_target.py` + `prepare_send.py`）：known-targets.json 收件人解析、ranked displayName/target/substring + lastSeenAt 排序、歧义检测、message 工具负载生成。上游无对应物，整体保留。
- `known-targets.json` 注册表（`~/.openclaw/qqbot/data/known-targets.json`，`accountId/kind/target/displayName/lastSeenAt/sourceChatType`）：上游 known-users.ts 是不同且更简的结构，不得替换。
- `displayAliases` 配置（`config.ts:21 displayAliasesSchema`、`config.ts:270-282 mergeQQBotAccountConfig`、manifest `configSchema.properties.displayAliases`）：按账号的 displayName 别名解析，上游缺。
- 流式 / typing 心跳（`typingHeartbeatMode` none/idle/always、`typingHeartbeatIntervalMs`、`typingInputSeconds`，config.ts:41-50；`streaming.ts`）与 c2c markdown 投递（`c2cMarkdownDeliveryMode`、`c2cMarkdownChunkStrategy`、`c2cMarkdownSafeChunkByteLimit`）：中国侧传输行为，上游 skill/tool 面没有，移植 qqmedia/remind 时不得触碰 bot.ts 的流式与分块路径。
- China setup CLI / onboarding（`registerChinaSetupCli`/`showChinaInstallHint`，`@openclaw-china/shared`，`index.ts:9/150-151`）与 ASR 配置块（`asr`，config.ts:304-314）。
- fork 的 token 基础设施：`client.ts` 的 `getAccessToken`/`API_BASE`/`tokenCacheMap`（多账户 appId 维度缓存）。channel.ts 工具必须复用它，不得引入上游独立的 `api.ts` 造成第二份 token 缓存。
- 已有 media 路径（`markdown-images.ts` + `extractQQBotReplyMedia` + `extractLocalMediaFromText` + shared `extractMediaFromText` + `autoSendLocalPathMedia`）：qqmedia 标签必须作为**额外输入形态**叠加，不得替换既有 markdown 图片/裸路径/MEDIA: 行解析。

### 实施方案

> 总原则：port-not-rebase。上游是 daemon 自带模块；fork 是结构化 channel + shared 包。上游每个自洽模块都要改写成「调 fork 契约 / 复用 shared / 复用 client.ts」，凡会与 shared 功能重复的不得照抄。

**阶段 0 — 打通工具注册面（前置阻塞，最高优先）**

fork 的 `MoltbotPluginApi`（`extensions/qqbot/index.ts:11-15`）只有 `registerChannel`。两种走法（择一，由 openclaw-china 主仓拍板）：

- (A) 扩 `MoltbotPluginApi`：增加 `registerTool?: (tool, opts?) => void` 与 `runtime?`，在 `register(api)`（`index.ts:149`）里当 `api.registerTool` 存在时调用 `registerRemindTool(api)` / `registerChannelTool(api)`。对 wecom-kf 等兄弟扩展零影响（optional）。
- (B) 若结构化 `ChannelPlugin` 契约（qqbotPlugin）支持 `tools?: ToolDef[]` 槽位，则把工具定义放进 `qqbotPlugin.tools`，由主框架在 registerChannel 时一并注册。需先确认主仓 ChannelPlugin 类型是否已有该槽位（本仓内未见类型定义，疑似来自外部 `openclaw` 主框架，需向主仓确认）。

`{ name: "qqbot_remind" }` 这类 `(tool, {name})` 二参签名（upstream `remind.ts:304`、`channel.ts:273`）需与所选注册面对齐——若 fork 选 (A) 的单参 `registerTool(tool)`，则去掉第二个参数，靠 tool 自身的 `name` 字段。

**阶段 1 — request-context（小、自洽）**

- 新建 `extensions/qqbot/src/request-context.ts`，直接移植 upstream（`request-context.ts:9-49`）的 `AsyncLocalStorage<RequestContext>` + `runWithRequestContext`/`getRequestContext`/`getRequestTarget`/`getRequestAccountId`，类型 `RequestContext={target:string; accountId?:string}`。无外部依赖，照搬即可。
- 接线点：`monitor.ts:316-323` 的 `handleQQBotDispatch` 派发处。该函数内部 `bot.ts:1249-1282` 已能算出 target（`user:${inbound.c2cOpenid}` / `group:${inbound.groupOpenid}` / `channel:${inbound.channelId}`）与 accountId。需把这些值在调用 runtime 派发（`runImmediateSessionDispatch` 等，`bot.ts:391`）外层用 `runWithRequestContext({target: qualifiedTarget, accountId}, () => …)` 包裹。qualifiedTarget 形如 `qqbot:c2c:<openid>`/`qqbot:group:<group_openid>`（与 remind.ts 的 `to` 语义一致）。注意只包「AI agent turn 执行」这段异步链，确保 tool execute 时能读到 store。

**阶段 2 — `qqbot_remind` 工具 + skill（中、自洽、价值最高）**

- 新建 `extensions/qqbot/src/tools/remind.ts`，移植 upstream `remind.ts`（`parseRelativeTime`/`isCronExpression`/`generateJobName`/`buildOnceJob`/`buildCronJob`/`buildReminderPrompt`/`formatDelay`/`RemindSchema`/`registerRemindTool`），仅把 `import ... from "../request-context.js"` 指向阶段 1 的本地文件，并把 `registerTool(tool, {name})` 二参签名按阶段 0 的结论对齐。
- `cronParams` 的 `delivery.channel` 仍写 `"qqbot"`、`delivery.to` 取 `getRequestTarget()`、`delivery.accountId` 取 `getRequestAccountId() || "default"`（remind.ts:261-266）。这正好契合 `packages/shared/src/cron/index.ts` 的 `CRON_HIDDEN_PROMPT`（announce/isolated/agentTurn），模型把 cronParams 原样转发给框架内置 `cron` 工具——**无需在 fork 内自建 cron 引擎**，这是 port-not-rebase 的关键。
- 新建 `skills/qqbot-remind/SKILL.md`（移植 upstream，`requires.config:["channels.qqbot"]` 改为 fork 的 `channels.qqbot-china`，见 channel.ts:6 `QQBOT_CONFIG_CHANNEL_ID`）。
- 阶段 0 完成后在 `index.ts:register(api)` 调 `registerRemindTool(api)`。

**阶段 3 — `qqbot-media` 标签 + skill（中，须与既有 media 路径融合）**

- 新建 `extensions/qqbot/src/media-tags.ts`，移植 upstream `utils/media-tags.ts`（`VALID_TAGS`/`TAG_ALIASES`/`FUZZY_MEDIA_TAG_REGEX`/`SELF_CLOSING_TAG_REGEX`/`normalizeMediaTags`）。`expandTilde` 依赖 upstream `utils/platform.ts`——fork 改用 shared 的 `normalizeLocalPath`（`packages/shared/src/media/media-parser.ts`，已 export）。
- **不要**把 upstream `media-send.ts` 整体搬入（它会和 fork 的 `outbound.ts`/`streaming.ts`/`markdown-images.ts` 重复并造成双发送路径）。改为在 fork 的 `extractQQBotReplyMedia`（`bot.ts:1392`）入口先跑 `normalizeMediaTags(text)`，把 `qqmedia`/`qqimg`/… 标签先规整成标准 `<qqmedia>path</qqmedia>`，再用一个新增的 `extractQqMediaTags(text)` 把这些标签拆成 mediaUrls（按 `detectMediaType` 路由 image/voice/video/file，复用 shared），从 text 移除，再交给既有的 `extractMediaLinesFromText` + `extractLocalMediaFromText`。即 qqmedia 是 markdown 图片/裸路径之外的**第三种输入形态**，输出统一汇入既有 mediaUrls → 既有 send.ts/outbound.ts 发送链。
- size 上限（图 30MB/语音 20MB/视频与文件 100MB，来自 qqbot-media SKILL.md:36-39）落进 skill 文案即可，发送侧 fork 已有 `maxFileSizeMB`/`mediaTimeoutMs`（config.ts:78-79），无需额外代码。
- 新建 `skills/qqbot-media/SKILL.md`（移植，`requires` 改 `channels.qqbot-china`）。
- manifest `openclaw.plugin.json` 的 `"skills": ["./skills"]` 自动覆盖新 skill 目录，无需改 manifest。

**阶段 4 — `qqbot_channel_api` 工具 + skill（大、低频，可延后）**

- 新建 `extensions/qqbot/src/tools/channel.ts`，移植 upstream channel.ts 的 `ChannelApiSchema`/`validatePath`/`buildUrl`/`json`/`registerChannelTool`，但：
  - token：删掉 `import { getAccessToken, API_BASE } from "../api.js"`，改 `import { getAccessToken } from "../client.js"`（client.ts:130）+ 本地 `const API_BASE = "https://api.sgroup.qq.com"`（或 export 自 client.ts）。复用 fork 的 appId 维度 token 缓存。
  - 账号选取：把 `listQQBotAccountIds`/`resolveQQBotAccount`（upstream channel.ts:120-127）替换为 fork 的 `listQQBotAccountIds(cfg)`（config.ts:250）+ `mergeQQBotAccountConfig(cfg, id)` + `resolveQQBotCredentials(merged)`（config.ts:295）取 appId/clientSecret。
- 新建 `skills/qqbot-channel/SKILL.md` + `references/api_references.md`（521 行，整体移植，仅把 `requires` 指向 `channels.qqbot-china`）。
- 阶段 0 后在 `index.ts:register(api)` 调 `registerChannelTool(api)`。
- 因 fork 当前以 C2C/群聊为主，频道管理为低频；若 fork 目标不涉及频道，本阶段可整体延后。

**关于 `qqbot-upgrade` skill — 不移植 / 重写**

upstream `qqbot-upgrade/SKILL.md:24` 直接 `curl tencent-connect/openclaw-qqbot main | bash`，与 China fork 的 npm scope（`@openclaw-china/qqbot`）、China setup CLI（`registerChinaSetupCli`，`index.ts:150`）冲突，照搬会让用户升级到上游包覆盖 China fork。处理：要么删掉、要么把脚本 URL 重写为 China fork 自己的升级脚本（若存在）。**不得原样移植 upstream upgrade skill。**

### 测试计划

1. **request-context 单元**：`runWithRequestContext({target:"qqbot:c2c:t1",accountId:"acc1"}, () => { expect(getRequestTarget()).toBe("qqbot:c2c:t1"); expect(getRequestAccountId()).toBe("acc1"); })`；作用域外 `getRequestTarget()` 为 undefined；并发两个不同 ctx 互不串。
2. **remind 工具 — 相对时间**：`parseRelativeTime("5m")===300000`、`"1h30m"===5400000`、`"2d"===172800000`、`"30s"===30000`、`"45"===2700000`（纯数字按分钟）、`"abc"===null`。
3. **remind 工具 — cron 判定**：`isCronExpression("0 8 * * *")===true`、`"5m"===false`、`"a b c d e f g"===false`（>6 段）、`"a b"===false`（<3 段）。
4. **remind 工具 — add(once)**：`action=add,content=喝水,time=5m`，断言返回 `cronParams.job.schedule={kind:"at",atMs: now+300000±1000}`、`payload.kind==="agentTurn"`、`delivery={mode:"announce",channel:"qqbot",to:<ctx target>,accountId:<ctx accountId>}`、`sessionTarget==="isolated"`、`deleteAfterRun===true`、`_instruction` 含「立即使用 cron 工具」。
5. **remind 工具 — add(cron)**：`time="0 8 * * *",timezone="Asia/Shanghai"`，断言 `schedule={kind:"cron",expr,tz}`、**无** `deleteAfterRun`。
6. **remind 工具 — 30s 下限**：`time="10s"` 返回 `{error: 提醒时间不能少于 30 秒}`；`time` 缺失/无法解析返回相应 error。
7. **remind 工具 — list/remove**：`action=list` → `cronParams={action:"list"}`；`action=remove` 缺 jobId 返回 error；有 jobId 返回 `cronParams={action:"remove",jobId}`。
8. **remind 工具 — context fallback**：未设 request-context 时 `action=add` 返回 `{error: 无法确定投递目标地址...}`（对齐 remind.ts:263）。
9. **media-tags 归一化**：`normalizeMediaTags("<qqimg>/a/b.png</qqimg>")` → 含 `<qqmedia>/a/b.png</qqmedia>`；`<qq_img>...</qq_img>`、`＜qqimage＞...＜/qqimage＞`、`<qqmedia file="/x.png"/>`、markdown 反引号包裹、闭合标签名不匹配（`<qqimg>x</qqvoice>`）均能归一；路径内含 `\n` 被压成空格。
10. **extractQQBotReplyMedia 端到端**：`text="图：<qqmedia>/tmp/a.png</qqmedia> 文：<qqmedia>/tmp/r.pdf</qqmedia>"`（autoSendLocalPathMedia=true，两个文件存在）→ `mediaUrls` 含 a.png 与 r.pdf，`text` 已移除两个标签；标签指向不存在的文件时 logger.warn 且 text 移除标签但 mediaUrls 不含该项（沿用既有 collectLocalRichMedia 行为 bot.ts:1315-1317）。
11. **回归 — 既有 media 路径不受影响**：markdown 图片 `![a](/tmp/a.png)`、裸路径 `/tmp/a.mp3`、`MEDIA:/tmp/a.png` 三种既有形态在未引入 qqmedia 标签时，行为与移植前逐字节一致（用现有 `bot.media-extraction.test.ts`、`markdown-images.test.ts` 跑回归）。
12. **channel 工具 — SSRF/超时**：`path="../x"` 返回 path 校验 error；`path="//evil"` 同；GET 带 body 被 warn 忽略；mock fetch 在 30s 后 abort 返回超时 error（用 fake timers）。
13. **channel 工具 — 鉴权头**：mock getAccessToken 返回 `TOK`，断言 fetch 收到 `Authorization: QQBot TOK`；query 拼接 `?limit=100&after=0`。
14. **manifest/skills 声明**：`manifest.skills.test.ts`（已存在，`src/manifest.skills.test.ts`）扩展断言 skills 目录包含 qqbot-contact-send、qqbot-remind、qqbot-media（以及视阶段决定是否含 qqbot-channel）。
15. **整体冒烟**：在配好 appId/clientSecret 的账号下，QQ 私聊发「5分钟后提醒我喝水」，模型调用 `qqbot_remind`→返回 cronParams→调 `cron`→到点收到暖心提醒消息（payload.kind=agentTurn，非 systemEvent）。

### 风险与注意事项

- **前置阻塞：registerTool 面**。若主仓既不给 `MoltbotPluginApi.registerTool`、也不给 `ChannelPlugin.tools` 槽位，则本子系统两个工具都无法落地，整个 qqbot_remind/qqbot_channel_api 移植停摆。阶段 0 必须最先与主仓对齐结论（A 还是 B），否则后续阶段返工。
- **request-context 作用域边界**：必须只包裹「会执行 AI agent turn / tool execute」的异步链；若把 WS 收包整条都包进去，多账号/多消息并发下 store 可能被后续连接覆盖。要在 monitor.ts:316 派发的最内层、按单条消息包裹，并在 bot.ts 派发 runtime 时确保 runWithRequestContext 跨 await 生效（AsyncLocalStorage 默认跨 async，但若中间有 worker_threads 切换会断——fork 当前未见 worker，低风险）。
- **双 token 缓存**：channel.ts 若误用 upstream api.ts 会引入第二份 token 缓存，与 client.ts 的 tokenCacheMap 冲突。强制复用 client.ts。
- **qqmedia 与既有 media 路径重叠**：用户既用 `<qqmedia>/x.png</qqmedia>` 又用 `![](/x.png)` 或裸路径指同一文件时，须保证只发一次（沿用 `seenMedia` 去重，bot.ts:1326-1330）。归一化顺序：normalizeMediaTags → extractQqMediaTags → 既有 extractMediaLines/extractLocalMedia。
- **cronParams 是「模型转发」契约**：remind 工具本身不创建任务，只产 cronParams 让模型转发给框架 cron 工具。若主框架无内置 cron 工具，或 cron 工具不认 `delivery.accountId`，remind 链路断裂——需确认 fork 运行时确实暴露 `cron` 工具（shared/cron/index.ts 的 CRON_HIDDEN_PROMPT 暗示存在，但需向主仓确认 cron 工具已注册）。
- **qqbot-upgrade 不可照搬**：上游 upgrade skill 会把 China fork 用户导向上游 npm 包，属破坏性，必须重写或删除。
- **api_references.md 体量**：521 行参考文档若 fork 目标不含频道管理（仅 C2C/群），引入纯属噪音且增加 token 占用；建议只在确定要做阶段 4 时才移植。
- **skill 的 `requires` 配置前缀**：fork 用 `channels.qqbot-china`（config.ts:6），upstream 用 `channels.qqbot`。移植 skill frontmatter 时必须改前缀，否则 skill 在 fork 下永不触发。
- **Python 依赖**：fork 的 qqbot-contact-send 依赖 `python3`；新增工具/skill 全为 TS，不引入新运行时依赖。若中国环境无 python3，contact-send skill 已有的限制不变。

## 4.12 Upgrade Infrastructure & China-Specific Packaging/Integration

### 现状对比

**Fork 现状（@openclaw-china/qqbot 2026.3.9-1）—— 完全没有进程内升级/自报告基础设施。**

- `extensions/qqbot/index.ts:149-157` `register(api)` 仅做三件事：`registerChinaSetupCli(api, { channels: [QQBOT_CONFIG_CHANNEL_ID] })`、`showChinaInstallHint(api)`、`setQQBotRuntime` + `api.registerChannel({ plugin: qqbotPlugin })`。没有任何版本/升级处理。
- grep 全仓库（`extensions/qqbot/`、`packages/shared/src/`）对 `upgradeMode | bot-upgrade | bot-version | pkg-version | update-checker | preload | postinstall | minFrameworkVersion | startup-marker | upgradePkg | upgradeUrl` 命中为零 —— fork 确实不存在任何升级基础设施。
- 渠道契约是结构化的：`extensions/qqbot/src/channel.ts:64` `qqbotPlugin` 暴露 `capabilities`/`messaging`/`outbound`/`gateway.startAccount`（channel.ts:83/364/366-367），不是上游那种自包含 `registerCommand` slash-command 框架。`bot.ts:440-441` 仅识别 `/stop` 作为会话中止触发词，无 `/bot-*` 命令体系。
- China 专属安装/引导流程：`packages/shared/src/cli/china-setup.ts`（基于 `@clack/prompts`，line 2-10）注册交互式 `openclaw china setup` 向导 + `china about` 命令，写入凭据到 `channels["qqbot-china"]`（china-setup.ts:82 `QQBOT_CHANNEL_ID="qqbot-china"`，与 config.ts:6 `QQBOT_CONFIG_CHANNEL_ID` 一致）；`packages/shared/src/cli/install-hint.ts:62-97` `showChinaInstallHint` 打印一次性 banner，指向 `github.com/BytePioneer-AI/openclaw-china`（install-hint.ts:14），受 `Symbol.for("@openclaw-china/china-install-hint-shown")`（line 30）去重 + 任意 China 渠道 enabled（line 36-50）抑制。
- 运行时仅认 `~/.openclaw`：china-setup.ts:75 `OPENCLAW_HOME=join(homedir(),".openclaw")`；:76 `DEFAULT_PLUGIN_PATH` 与 `LEGACY_PLUGIN_PATH` 均在 `.openclaw` 下；`resolvePluginPath()`（:181-189）只在 `.openclaw/extensions` 与 `.openclaw/plugins` 间选择。package.json 中 `moltbot`/`clawdbot` manifest 块（extensions/qqbot/package.json:33-74、packages/channels/package.json:30-53）仅声明性存在，运行时不写 `.moltbot`/`.clawdbot`。
- 独立安装器 `packages/setup/src/cli.ts:8` `PLUGIN_PACKAGE_NAME="@openclaw-china/channels"`（meta 包，不是 qqbot 单包），:168-202 串行 `npm pack @openclaw-china/channels@<ver>` → `openclaw plugins install <archive>` → `openclaw china setup`，:108-120 有 Windows `ComSpec` 引号处理。
- Monorepo 发版：`scripts/release-all.mjs`（shared/channels/setup）、`scripts/release-setup.mjs`，版本正则 `^(\d+)\.(\d+)\.(\d+)(?:([.-])([0-9]+))?$`（release-all.mjs:137），即日期-semver `2026.3.9-1`；release-all.mjs:124-133 拒绝以 `latest` tag 发布 prerelease（强制 `--tag next`）。
- 插件 id 为 `"qqbot"`（openclaw.plugin.json:2、index.ts:31 `id: QQBOT_CHANNEL_ID`=`"qqbot"`，config.ts:5），npmSpec `@openclaw-china/qqbot`（package.json:28）；构建用 `tsup` 产出扁平 `dist/index.js`（package.json:75 main）。

**上游现状（@tencent-connect/openclaw-qqbot v1.7.2）—— 自包含 daemon 式完整热升级栈。**

- 插件 id `"openclaw-qqbot"`（openclaw.plugin.json:3），channel id `"qqbot"`（:6），`channelConfigs.qqbot.preferOver:["qqbot"]`（:18-20）；package.json:13-17 `openclaw.id="openclaw-qqbot"` + extensions `["./preload.cjs"]`。
- `src/slash-commands.ts:257` 内部 `function registerCommand(cmd)` 框架（非 SDK 契约），被 `src/gateway.ts:26` 通过 `matchSlashCommand` 接入；:28 `PLUGIN_VERSION = getPackageVersion(import.meta.url)`；:31 `getFrameworkVersion()`；:78 `minFrameworkVersion:"2026.3.2"`；:299 `/bot-version` 命令（:319 调 `getUpdateInfo()` 报告新版）；:1189 `/bot-upgrade` 命令，:1200-1201 `upgradeUrl/upgradeMode`（默认 `"hot-reload"`，:1201），:1186 `_upgrading` 进程内锁。
- `src/types.ts:118/124/131` `upgradeUrl?`、`upgradeMode?:"doc"|"hot-reload"`、`upgradePkg?` 三个 accountConfig 字段。
- `src/update-checker.ts`：:17 `PKG_NAME`、:20-23 REGISTRIES（npmjs.org→npmmirror.com），:25 `CURRENT_VERSION=getPackageVersion`，:112 `getUpdateInfo()`、:128 `checkVersionExists()`、:151 `compareVersions()`（严格隔离 prerelease 与稳定版）。
- `src/utils/pkg-version.ts`：:19/:39 硬编码包名 `@tencent-connect/openclaw-qqbot`，:14 `getPackageVersion(metaUrl?)` 从 `import.meta.url` 向上遍历找 `package.json` + createRequire fallback。
- `src/startup-greeting.ts`：`startup-marker-<acct>-<app>.json`（:19）含 version/startedAt/greetedAt/lastFailureAt，:62 `getStartupGreetingPlan` 判定首次/版本变更/冷却；`src/admin-resolver.ts:46` `upgrade-greeting-target-<acct>-<app>.json` marker，重启后向升级请求者主动问候。
- `scripts/upgrade-via-npm.sh`（1142 行）：:519 `PKG_NAME="@tencent-connect/openclaw-qqbot"`、:520 `PLUGIN_ID="openclaw-qqbot"`；:59 NPM_REGISTRIES 含腾讯云镜像；:64-66 CLS 遥测上报 `ap-guangzhou.cls.tencentcs.com` topic `845a0802-...`（默认 `CLS_ENABLED=true`）；:296 `setup_temp_config()` 删除 `cfg.channels?.qqbot` 绕过 3.23+ 严格校验；:715 `openclaw config set gateway.reload.mode hot`；:587-591 检测 ≥2026.3.30 加 `--dangerously-force-unsafe-install`；:935-944 postflight 检查 `dist/src/*.js` 计数 + 硬编码 `dist/src/gateway.js`、`dist/src/api.js`、`dist/src/admin-resolver.js`；:696-697 `REMOTE_UPGRADE_SCRIPT_URL` 指向 `raw.githubusercontent.com/tencent-connect/openclaw-qqbot/main`。
- `scripts/upgrade-via-source.sh`（1063 行）：:96/:239-241 暂存/恢复 `channels.qqbot`（trap :255-279）；:342-361 安装前临时移走 `node_modules` 规避安全扫描；:523-528 复制 bundledDependencies。
- `scripts/upgrade-via-npm.ps1`（18KB）Windows 变体；`scripts/cleanup-legacy-plugins.sh` 删除 `qqbot/openclaw-qq/openclaw-qqbot` 目录 + 清理 plugins.entries/installs/allow（保留 channels 凭据）；`scripts/postinstall-link-sdk.js` 4 策略 SDK 解析器（npm root -g / which / extensions / pnpm）；`scripts/link-sdk-core.cjs` preload+postinstall 共享核心，:9 `CLI_NAMES=["openclaw","clawdbot","moltbot"]`，:31 `isOpenclawVersionRequiresSymlink()` 要求 ≥2026.3.22；`preload.cjs:12-15` 同步建 symlink + :19 require dist/index.js + :23-31 展平 default export。
- `package.json`：:18-21 `bundledDependencies`/`bundleDependencies`（mpg123-decoder/silk-wasm/ws）；:35 `postinstall` hook；:9-12 bin `openclaw-qqbot`/`qqbot` → `bin/qqbot-cli.js`；:27 `build:"tsc || true"`（产出 `dist/src/*` 层级）。

### 差距清单

Fork 缺失、上游拥有的具体能力（命令/字段/文件名）：

1. **进程内 slash-command 框架与命令**：`registerCommand`（slash-commands.ts:257）、`/bot-version`（:299）、`/bot-upgrade`（:1189，支持 `--latest/--version/--force/--pkg/--local`）、`/bot-help`、`matchSlashCommand` 接入 gateway。Fork 的结构化渠道契约无此入口。
2. **accountConfig 升级字段**：`upgradeUrl?`（types.ts:118）、`upgradeMode?:"doc"|"hot-reload"`（:124）、`upgradePkg?`（:131）。Fork 的 configSchema（openclaw.plugin.json:8-131、index.ts:34-147）无这三字段。
3. **版本自报告**：`src/utils/pkg-version.ts`（`getPackageVersion`，硬编码上游包名）、`PLUGIN_VERSION`、`getFrameworkVersion`、`src/update-checker.ts`（`getUpdateInfo`/`checkVersionExists`/`compareVersions`，npmjs.org→npmmirror fallback）。
4. **热升级脚本**：`scripts/upgrade-via-npm.sh`（PKG_NAME/PLUGIN_ID 硬编码上游、CLS 遥测腾讯云、`channels.qqbot` temp-config、gateway.reload hot、`--dangerously-force-unsafe-install`、`dist/src/*.js` postflight）、`upgrade-via-npm.ps1`、`upgrade-via-source.sh`（`channels.qqbot` stash/restore trap）、`cleanup-legacy-plugins.sh`。
5. **SDK 稳健性层**：`preload.cjs`（同步 symlink + default export 展平）、`scripts/postinstall-link-sdk.js`（4 策略）、`scripts/link-sdk-core.cjs`（≥2026.3.22 判定）、package.json `postinstall` hook + `bundledDependencies`。
6. **启动问候/升级问候**：`startup-marker-*.json`、`upgrade-greeting-target-*.json`、`getStartupGreetingPlan`、admin-resolver 主动问候。
7. **CLI bin**：`bin/qqbot-cli.js`（注册 `openclaw-qqbot`/`qqbot`）。
8. **skills/qqbot-upgrade SKILL.md**：curl 管道执行上游 `upgrade-via-npm.sh`。

### 必须保留

China-fork 在本子系统必须原样保留、不得被移植覆盖的特性：

1. **`registerChinaSetupCli` + `showChinaInstallHint`**（index.ts:150-151）—— China 安装/引导主线，移植升级设施不得删除或冲突。
2. **渠道 config key `qqbot-china`**（config.ts:6 QQBOT_CONFIG_CHANNEL_ID；china-setup.ts:82）—— 与上游 `channels.qqbot` 不同，任何移植的 temp-config/stash 逻辑必须按 `qqbot-china` 操作，绝不能删 `channels["qqbot-china"]`。
3. **插件 id `qqbot` + npmSpec `@openclaw-china/qqbot`**（openclaw.plugin.json:2、package.json:28）—— 不得改为上游 `openclaw-qqbot`。
4. **tsup 扁平 `dist/index.js` 构建产物**（package.json:75）—— 移植的 postflight 检查必须改为校验 `dist/index.js` 等扁平文件，不得沿用 `dist/src/gateway.js`。
5. **`@openclaw-china/setup` 独立安装器**（packages/setup/src/cli.ts）—— 装的是 `@openclaw-china/channels` meta 包 + `openclaw china setup`，不得被上游 `bin/qqbot-cli.js` 取代。
6. **Monorepo 发版工具**（release-all.mjs/release-setup.mjs，`2026.x.x-N` semver + latest/next dist-tag + prerelease 拒发 latest）—— 移植版本检查器须与此 semver 兼容。
7. **china-setup 只认 `~/.openclaw`**（china-setup.ts:75-76）—— 现状如此，无需引入 `.moltbot`/`.clawdbot` 多目录（package.json 里的 moltbot/clawdbot manifest 仅声明性）。
8. **CLS 遥测中性化原则**——上游上报腾讯云 CLS 的逻辑不得原样引入 fork。

### 实施方案

按风险/价值分三阶段，严格遵守"port-not-rebase"：上游自包含模块须改写为适配 fork 的结构化契约与 shared 包，凡硬编码上游包名/id/布局/渠道 key/遥测端点处一律重定向。

**阶段 1（低风险高价值）—— 版本自报告。**

- 新建 `extensions/qqbot/src/utils/pkg-version.ts`：移植上游 pkg-version.ts:14-64，但把 :19/:39 包名常量改为 `@openclaw-china/qqbot`，并保留 `_resolvedPkgPath` 快路径 + createRequire fallback。tsup 扁平布局下从 `dist/utils/pkg-version.js` 向上仍能命中根 `package.json`，逻辑无需调整。
- 新建 `extensions/qqbot/src/update-checker.ts`：移植上游 update-checker.ts，改 :17 `PKG_NAME="@openclaw-china/qqbot"`；:20-23 REGISTRIES 调整为 China 友好顺序（npmmirror.com 优先、npmjs.org fallback），与 china-setup / 发版脚本一致。导出 `getUpdateInfo`/`triggerUpdateCheck`/`checkVersionExists`/`compareVersions`。
- 集成点：fork 无 slash-command 框架，因此 /bot-version 不能照搬 `registerCommand`。两个候选落地：(a) 在 `gateway.startAccount`（channel.ts:367）启动时调 `triggerUpdateCheck(ctx.log)` 预热，并通过 `ctx.log?.info` 输出"新版本可用"提示（最贴合结构化契约）；(b) 若 framework 提供 inbound 文本路由，在 bot.ts 已有 `/stop` 旁（:440）增加 `/bot-version` 文本匹配，回包 plugin+framework 版本。优先 (a)，(b) 作为可选增强。

**阶段 2（中等风险）—— SDK symlink 稳健性 + postinstall。**

- 新建 `extensions/qqbot/scripts/link-sdk-core.cjs`：移植上游同名文件（link-sdk-core.cjs:1-60+），保留 `CLI_NAMES=["openclaw","clawdbot","moltbot"]`（fork package.json 已有 moltbot/clawdbot manifest，CLI 名兼容）与 ≥2026.3.22 判定。
- 新建 `extensions/qqbot/preload.cjs`：移植上游 preload.cjs:1-33，同步建 symlink + require `dist/index.js` + 展平 default export。但注意 fork index.ts 的 default export 已是 `{ id, name, register, configSchema }` 形态（index.ts:30-160），展平逻辑兼容。
- 新建 `extensions/qqbot/scripts/postinstall-link-sdk.js`：移植上游 4 策略解析器，输出 `node_modules/openclaw` symlink。
- 修改 `extensions/qqbot/package.json`：(1) `files` 数组（:7-11）追加 `preload.cjs`、`scripts`；(2) `openclaw.extensions`（:13-15）改为 `["./preload.cjs"]`（替换 `./dist/index.js`，由 preload.cjs 内部 require dist/index.js）；moltbot/clawdbot 块同理；(3) 加 `scripts.postinstall:"node scripts/postinstall-link-sdk.js 2>/dev/null || true"`；(4) 加 `bundledDependencies`（silk-wasm/ws/ffmpeg-static，按 fork deps :91-94）。
- 集成点：tsup 扁平 dist 与 preload.cjs 的 `require("./dist/index.js")` 兼容（tsup 默认产出 dist/index.js，package.json:75 main 已是该路径）。fork 当前靠 framework alias 解析 plugin-sdk，加 preload.cjs 是 fallback 增强，不破坏现状。

**阶段 3（高风险大工程）—— /bot-upgrade 热升级 + 脚本（仅在阶段 1/2 稳定后）。**

- 移植 `scripts/upgrade-via-npm.sh` → 新建 `extensions/qqbot/scripts/upgrade-via-npm.sh`，必须改写：(1) `:519 PKG_NAME="@openclaw-china/qqbot"`、`:520 PLUGIN_ID="qqbot"`（fork id）；(2) temp-config 逻辑（:296-333 `setup_temp_config`）从删 `cfg.channels?.qqbot` 改为删 `cfg.channels?.["qqbot-china"]`，避免清掉 fork 凭据；(3) :64-66 CLS 遥测：默认 `CLS_ENABLED` 改为 `false` 或重定向到 fork 自有端点；(4) :696-697 远程脚本 URL 改为 fork 仓库 `raw.githubusercontent.com/BytePioneer-AI/openclaw-china/main/extensions/qqbot/scripts/upgrade-via-npm.sh`；(5) :935-944 postflight 从 `dist/src/gateway.js|api.js|admin-resolver.js` 改为校验 `dist/index.js` + fork 实际产物文件名。
- 移植 `upgrade-via-npm.ps1`、`upgrade-via-source.sh`（`channels.qqbot` stash→`channels["qqbot-china"]`）、`cleanup-legacy-plugins.sh`（清理目标 id 改为 fork 历史 id，如旧的 `@openclaw-china/qqbot` 早期命名，保留 channels 凭据）。
- types/configSchema 扩展：在 openclaw.plugin.json:8-131 与 index.ts:34-147 的 accountConfig properties 中新增 `upgradeUrl?`、`upgradeMode?:"doc"|"hot-reload"`（默认 `doc`，比上游默认 `hot-reload` 更保守，见风险）、`upgradePkg?`；同时在 config.ts 的 zod schema（:55-99 QQBotAccountSchema）补这三字段（optional）。
- /bot-upgrade 命令落地：同样无 slash 框架，需决定是否引入一个最小的 inbound 命令分发器（在 bot.ts inbound 路径旁），或仅提供 skill + CLI 触发（见下）。建议优先 skill 触发，避免在结构化渠道里硬塞命令分发器。
- 新建 `extensions/qqbot/skills/qqbot-upgrade/SKILL.md`：移植上游 skill，但 curl URL 改为 fork 仓库脚本，包名/措辞改为 `@openclaw-china/qqbot`。fork 已有 skills 目录（manifest.skills.test.ts），将其纳入 openclaw.plugin.json:7 `skills:["./skills"]`。

**Fork→Upstream 映射（关键标识符重定向表）见下方 forkToUpstreamMap。**

### 测试计划

1. **pkg-version 单元测试**：构造临时目录树（package.json name=`@openclaw-china/qqbot` version=`2026.3.9-1`），断言 `getPackageVersion(metaUrl)` 返回正确版本；缺失 package.json 时返回 `"unknown"`；缓存命中后删除文件能回落完整查找。
2. **update-checker 单元测试**：mock https.get 返回 `dist-tags:{latest:"2026.3.10-1",alpha:"..."}`，断言 prerelease 当前版（含 `-`）与 alpha 比、稳定版与 latest 比、`hasUpdate` 计算、`compareVersions` 主版本/prerelease 段比较；全 registry 失败返回 error 字段且 hasUpdate=false。
3. **registry 顺序测试**：断言 fork 版本 npmmirror.com 在数组首位（与上游 npmjs.org 首位相反）。
4. **config schema 测试**：补 upgradeUrl/upgradeMode/upgradePkg 到 QQBotAccountSchema（config.ts:55）后，现有 `config.test.ts` 增加用例：默认 upgradeMode 解析为 `doc`、三字段 optional 不破坏既有解析。
5. **preload.cjs 集成测试**：在隔离 fixture（含 dist/index.js + node_modules/openclaw 不存在）下 require preload.cjs，断言创建 symlink 且 default export 的 `register`/`id` 被展平到顶层。
6. **postinstall-link-sdk 测试**：mock `npm root -g`/`which`，断言 4 策略命中顺序与 symlink 指向；已存在有效 symlink 时短路退出。
7. **upgrade-via-npm.sh 改写回归测试**：grep 断言脚本内 `PKG_NAME`/`PLUGIN_ID` 已改为 fork 值、CLS_ENABLED 默认非 true、temp-config 操作的是 `qqbot-china` 而非 `qqbot`、postflight 校验 `dist/index.js`；不得出现 `@tencent-connect` 或 `tencent-connect/openclaw-qqbot` 字面量。
8. **china-setup 不受影响回归**：运行现有 `china-setup.test.ts`，确认移植升级设施后 `openclaw china setup` 向导仍写 `channels["qqbot-china"]`、banner 仍指向 BytePioneer-AI 仓库。
9. **发版兼容测试**：用 release-all.mjs 跑 dry-run，确认 `2026.3.10-1` 这种 prerelease 仍被正确识别、以 `--tag next` 发布、latest 拒发。

### 风险与注意事项

1. **插件 id 冲突**（最高风险）：上游 `PLUGIN_ID="openclaw-qqbot"` 且脚本会 disable "built-in qqbot/openclaw-qq" 冲突插件。照搬到 fork 会指向错误 id，可能误删 fork 自身。所有脚本必须重定向为 `qqbot`。
2. **渠道 key 冲突**：上游 temp-config 删 `channels.qqbot`；fork 凭据在 `channels["qqbot-china"]`。误删会丢失用户 appId/clientSecret。阶段 3 脚本必须精确改 key。
3. **postflight 布局不匹配**：上游校验 `dist/src/gateway.js|api.js|admin-resolver.js`（tsc `dist/src/*` 层级）；fork 是 tsup 扁平 `dist/index.js`。照搬 postflight 会误判升级失败。
4. **CLS 遥测外泄**：上游默认上报腾讯云 CLS（`ap-guangzhou.cls.tencentcs.com`）。fork 若原样启用等于把用户数据上报给腾讯端点，违反 China-fork 中立性。必须默认关闭或重定向。
5. **upgradeMode 默认值**：上游代码默认 `hot-reload`（slash-commands.ts:1201，与文档注释"doc"不符）。hot-reload 会执行 setsid 隔离的进程替换 + 重启 gateway，对 fork 结构化渠道（gateway 由 framework 管）风险高。建议 fork 默认 `doc`（仅给升级指引），hot-reload 作为显式 opt-in。
6. **进程隔离与 framework 重启**：上游 upgrade-via-npm.sh 用 `setsid`/SIGTERM-ignore 自行 stop/start gateway。fork 的 `gateway.startAccount` 是 framework 调用进来的契约回调，插件不应自行 kill framework 进程。阶段 3 需评估是否降级为"仅 `openclaw plugins install` + 提示用户手动重启 gateway"。
7. **bundledDependencies 改变发版产物**：给 package.json 加 bundledDependencies 会增大 tarball 并影响 release-all.mjs 的 `npm publish`。需回归 release 流程。
8. **无 slash-command 框架的落地困境**：/bot-version、/bot-upgrade 在上游靠内部 `registerCommand`。fork 若不想引入命令分发器，只能走 (a) log 提示 + (b) skill 触发。这限制了命令的交互完整性（如 `<qqbot-cmd-enter>` 按钮），需在文档中明确取舍。
9. **registerChinaSetupCli 线程安全**：移植 `triggerUpdateCheck` 进 `gateway.startAccount` 后，多账号启动会并发查 npm registry。需保证 update-checker 的网络调用 fire-and-forget 且不阻塞 startAccount。

## 5. 优先级积压 (Backlog)

### P0（必须先做：安全 / 核心功能 / 数据正确性）

| ID | 子系统 | 内容 | 工作量 | 风险 | 依赖 |
|---|---|---|---|---|---|
| P0-A | config-types-manifest (4.1) | **config key 决策 + 读侧兼容层**（保留 `qqbot-china` 权威 + 读侧兼容 `channels.qqbot`）；manifest 纯加法（`capabilities`/具名 skills/`extensions` 占位）；Zod + 三处 JSON Schema 增量字段（见 4.1 差距 1-12）；建议抽取 `buildAccountJsonSchema()` 消除三份手抄漂移 | 小-中 | 中（config key 关键路径）/ 低（manifest） | 无（Phase 1 底座） |
| P0-B | media-largefile (4.5) | **✅ 已落地（2026-06-13）SSRF 守卫（仅入站）**：移植 `ssrf-guard.ts`，在 `bot.ts:854/:886` 下载前调 `validateRemoteUrl` | 小（0.5d） | 低 | 无 |
| P0-C | media-largefile (4.5) | **chunked 大文件上传 + upload-cache + 错误码映射**：成组 port（API 客户端 + 类型 + file-utils），re-point 时保留 ref-index/ASR/streaming 集成点 | 大（1.5-2d） | 中 | 无 |
| P0-D | group-finetuning (4.7) | **per-group 精细控制全栈**：`groups` map + 4 层链 + group-history LRU + 三层 gate + SDK adapter；**前置**扩展 `parseGroupMessage` 捕获 `mentions[]`/`refMsgIdx`/`message_type`；remap fork flat `requireMention`→`defaultRequireMention`；扩展 gate 保留 `groupPolicy` allowlist/disabled | 大（3-5d） | 高 | P0-A（config/types） |
| P0-E | transport-connection (4.2) | session-store 持久化 + 跨重启 RESUME + close-code 感知重连 + `MAX_RECONNECT_ATTEMPTS=100` + User-Agent 头 + uncaughtException 守卫 | 中 | 低 | 无 |

> **勘误修正**：config-types-manifest 的 capabilities 差异不是「fork 缺 capabilities」，而是 fork 的 capabilities 在 `ChannelPlugin` 对象上（channel.ts:71-81，chatTypes 含 `channel`，blockStreaming=false），上游 manifest 的 `capabilities:{proactiveMessaging,cronJobs}`（openclaw.plugin.json:8-11）是 fork manifest **完全缺失**的独立字段。P0-A 应 port 后者，保留前者。

### P1（高价值，可在 P0 后并行/分批）

| ID | 子系统 | 内容 | 工作量 | 风险 | 依赖 |
|---|---|---|---|---|---|
| P1-A | multi-account (4.8) | background token 刷新 + `getTokenStatus` + 短有效期自适应阈值（用 `@openclaw-china/shared httpPost`，非裸 fetch） | 中 | 低 | P0-E |
| P1-B | multi-account (4.8) | AsyncLocalStorage RequestContext（逐字移植 request-context.ts；包裹 inbound dispatch；保留显式参数透传为权威源） | 中-高 | 中 | P1-A |
| P1-C | slash-commands (4.3) | slash 框架 + 只读命令（`/bot-ping`/`/bot-version`/`/bot-help`/`/bot-logs`/`/bot-clear-storage`）+ `update-checker`（PKG_NAME 改 `@openclaw-china/qqbot`）；接入 `handleQQBotDispatch` 顶部、fork abort 之前 | 中 | 中 | P0-A（config） |
| P1-D | voice-stt-tts (4.6) | provider STT（Tencent 以 `provider:"tencent-flash"` 接入 raw-buffer 路径 + OpenAI 兼容）+ TTS 全栈（audio-convert.ts 下沉 shared）+ config 迁移 shim（`asr.*` 向后兼容读） | 大（3-5d） | 高（STT 格式不兼容，C4） | shared audio 层先行 |
| P1-E | skills-tools (4.11) | registerTool 面（扩 `MoltbotPluginApi`）+ request-context + `qqbot_remind` + `qqbot-remind` skill | 中 | 中（registerTool 前置阻塞） | P1-B（RequestContext） |
| P1-F | skills-tools (4.11) | `<qqmedia>` tag + `media-tags.ts` + `qqbot-media` skill（叠加到 fork 既有 `extractQQBotReplyMedia`，不替换 shared parser） | 中 | 中 | P1-E |
| P1-G | streaming-typing-markdown (4.9) | 阶段一/二：raw startsWith 边界 + 精简 FlushController + 最小 StreamingPhase 状态机 + finalize 三分支 | 中 | 中 | 无 |
| P1-H | transport-connection (4.2) | INTERACTION 意图(1<<26) + INTERACTION_CREATE/GROUP_* 事件分支（至少记日志不再静默 null） | 小 | 低 | P0-E |
| P1-I | upgrade-china-infra (4.12) | 阶段 1 版本自报告（pkg-version.ts + update-checker.ts，npmmirror 优先） | 小 | 低 | P0-A |

### P2（高级 / 高风险，最后做）

| ID | 子系统 | 内容 | 工作量 | 风险 | 依赖 |
|---|---|---|---|---|---|
| P2-A | approval-system (4.4) | approval-handler + inline-keyboard + admin-resolver（精简版）+ message-gating 三层 gate 替换硬编码 `CommandAuthorized:true` + channel hooks（扁平+嵌套+suppression）+ INTERACTION_CREATE 接线 + `/bot-approve` | 大 | 高（gateway-runtime ≥3.22，C5） | P1-C（slash）、P0-D（message-gating） |
| P2-B | transport-connection (4.2) | webhook transport（Ed25519 验签 + op:13/op:12 + 基于 `registerHttpRoute` 重写，限流留后） | 大 | 高（shared 无 webhook-ingress） | 扩 `MoltbotPluginApi.registerHttpRoute` |
| P2-C | upgrade-china-infra (4.12) | hot-upgrade 全栈（`/bot-upgrade` + 脚本 + preload.cjs + postinstall + startup-greeting + credential-backup + bin CLI）；PKG_NAME/PLUGIN_ID/CLS/temp-config/postflight 全改 fork | 大 | 极高 | P1-I |
| P2-D | streaming-typing-markdown (4.9) | 阶段三 deliverDebounce（注意与 replyFinalOnly 优先级）；阶段四（可选）内联富媒体流式（需 PoC 增量 vs 全量语义） | 中 | 中（阶段四高） | P1-G |
| P2-E | slash-commands (4.3) | Phase 2 config 变更命令（`/bot-streaming`/`/bot-group-allways`/`/bot-approve`，依赖 runtime.config + approval-handler） | 中 | 中（跨仓 runtime.config 依赖） | P1-C、P2-A |
| P2-F | skills-tools (4.11) | `qqbot_channel_api` tool + `qqbot-channel` skill + api_references.md（521 行） | 大（可延后） | 中 | P1-E |
| P2-G | config-types-manifest (4.1) | `upgradeMode` 默认 `doc`（非上游 `hot-reload`）双处锁定；STT/ASR 双轨并存调用方优先级约定 | 小 | 低 | P0-A |

## 6. 四阶段实施计划

### Phase 1：基础设施（config / types / transport 底座）

**交付物**：P0-A（config key 决策 + 读侧兼容层 + manifest 纯加法 + Zod/JSON Schema 增量字段）、P0-B（SSRF 守卫仅入站）、P0-E（session-store + 跨重启 RESUME + close-code 感知重连 + MAX_RECONNECT + User-Agent + uncaughtException）、P1-A（background token 刷新 + getTokenStatus）、P1-H（INTERACTION 意图 + 事件分支）。

**依赖**：无外部前置；Phase 1 是后续所有阶段底座。

**China 保留检查点**：
- config key `qqbot-china` 不变（C1 关键路径）；读侧兼容层不删用户配置。
- Zod schema 不被 `emptyPluginConfigSchema` 替换；三处手抄 Schema 同步（建议抽取 `buildAccountJsonSchema`）。
- 所有 China 字段（c2cMarkdown*/typing*/displayAliases/inboundMedia/asr）在 schema 保留。
- 多账户 `activeConnections` Map 与 `gateway.startAccount/stopAccount` 契约保留。
- `cleanupSocket` socket 身份校验保留（防 stale-socket）。
- background token 刷新复用 fork `tokenCacheMap`，用 `@openclaw-china/shared httpPost`（非裸 fetch）。
- op:11 → setStatus({lastEventAt}) 健康检查钩子保留。

**风险**：config key 决策一旦做出影响所有 ported 上游 config 解析（关键路径）；session-store 非「纯 fs」（依赖 platform helper，须 re-inline 或加 fork-local `getDataDir()`）；uncaughtException 是进程级全局监听，多账户必须严格 removeListener。

### Phase 2：高价值功能

**交付物**：P0-D（group-finetuning 全栈）、P0-C（chunked 上传 + upload-cache + 错误码映射）、P1-C（slash 框架 + 只读命令）、P1-I（版本自报告）、P1-B（RequestContext）、P1-G 阶段一/二（streaming 边界 + FlushController + 状态机）、P1-F（qqmedia tag + media-tags.ts）。

**依赖**：Phase 1 的 config/types/manifest；Phase 1 的 monitor.ts 改造（slash 接入点）；shared audio 层（若含 P1-D）。

**China 保留检查点**：
- group gate 扩展保留 `dmPolicy`/`groupPolicy`/`allowFrom`/`groupAllowFrom`（shared `checkGroupPolicy` 委托）。
- `parseGroupMessage` 扩展后 `mentionedBot` 仍默认 true（QQ 平台保证），不引入 skip 回归。
- chunked 上传 re-point 时保留 `recordOutboundC2CRefIndex`/Tencent-Flash ASR/streaming 调用；保留 `convertAudioToSilk` refIdx 提取。
- slash 框架接入 `handleQQBotDispatch` 顶部，**保留** `isQQBotFastAbortCommandText` 本地化 abort 路径（per-queue-key），上游 `URGENT_COMMANDS` 仅 `/approve` 为新增（P2-A 后才接 fast-path）。
- `group-history` 保留 fork 的 `MEDIA:` tag 附件格式。
- qqmedia tag 叠加到 fork `extractQQBotReplyMedia`，不替换 shared `extractMediaFromText`；保留 `autoSendLocalPathMedia`；保留 `seenMedia` 去重。
- update-checker PKG_NAME=`@openclaw-china/qqbot`，REGISTRIES npmmirror.com 优先。
- streaming 移植保留全量 REPLACE content_raw 语义。

**风险**：group-finetuning 是 P0 里风险最高——`requireMention`/`historyLimit` 语义迁移 + quote-reply 行为变化 + `parseGroupMessage` 数据丢失前置工作；chunked 上传需成组移植 API 客户端，re-point 易漏 ref-index 集成；STT 格式不兼容（C4）必须 provider 分发。

### Phase 3：高级能力

**交付物**：P1-D（provider STT + TTS 全栈）、P1-E（registerTool + request-context + remind tool/skill）、P2-A（approval 系统）、P2-B（webhook transport）、P2-E（config 变更命令）、P2-F（channel_api tool，可延后）。

**依赖**：Phase 2 的 RequestContext、message-gating、config 类型；STT/TTS 需 audio-convert.ts 作为共享音频层先行；approval 需 gateway-runtime ≥3.22 验证；webhook 需 `@openclaw-china/shared` 暴露 webhook-ingress API 验证。

**China 保留检查点**：
- STT 迁移保留 `ASRError` 分类与 `buildVoiceASRFallbackReply` 中文回退；保留 raw-buffer 直送路径（Tencent provider）；保留 ref-index transcriptSource 四态。
- `ffmpeg-static` 移除后 CI 覆盖 ffmpeg 缺失场景（WASM fallback）。
- approval 移植保留 `dmPolicy`/`groupPolicy` 映射；`resolveTarget` 正则放宽 `(?:qqbot|qqbot-china):`；保留 `/stop` 优先于 `/approve` 紧急判定。
- webhook 不替换 WebSocket（双 transport）；不引入 `preferOver`（自引用）。
- `<qqmedia>` tag 接入 fork 的 `markdown-images` + `autoSendLocalPathMedia` 而非覆盖。
- channel_api 移植保留 known-targets/displayAliases 联系人解析；复用 fork client.ts（不引入上游 api.ts 第二份 token 缓存）。
- remind 的 cronParams 复用 shared cron 契约，不自建引擎；skill frontmatter `requires` 改 `channels.qqbot-china`。

**风险**：STT 模型不兼容（C4）；approval 与 fork 的 `CommandAuthorized:true`/inline policy 直接冲突；approval 依赖未确认的 SDK 版本（C5）；webhook 依赖未确认的 SDK API。

### Phase 4：打磨

**交付物**：P2-C（hot-upgrade 全栈）、P2-D（streaming deliverDebounce + 可选内联富媒体流式）、P2-G（upgradeMode 默认 doc 锁定 + STT/ASR 优先级约定）。

**依赖**：Phase 3 的 approval + 升级版本自报告；hot-upgrade 依赖 fork 实际安装布局已验证。

**China 保留检查点**：
- 升级脚本不删 `channels["qqbot-china"]`（temp-config 改 key）；`china-setup`/`install-hint` 流程正交保留。
- postflight 校验 tsup 扁平 `dist/index.js`（非上游 `dist/src/gateway.js`）。
- CLS 遥测默认关闭/重定向。
- upgradeMode 默认 `doc`。
- StreamingController 内部改进不破坏 `replyFinalOnly`/长任务提醒/`looksLikeQQBotStreamingIneligibleMarkdown`/全量 REPLACE。

**风险**：hot-upgrade 是**单点最高风险**（除 config key 外）——所有脚本硬编码上游 id，temp-config 删 `channels.qqbot`，postflight 假设 tsc 布局，CLS 遥测上报腾讯主题，`upgradeMode` 默认 `hot-reload`（代码）与文档 `doc` 不符。

### 推荐落地顺序（价值/风险比降序）

1. **Phase 1**（SSRF → config key 决策 → session-store/close-code → background token → config/manifest 底座）——低风险、立竿见影的安全与稳定性收益。
2. **Phase 2**（group-finetuning → chunked 上传 → slash 只读命令 → RequestContext + streaming 边界 → qqmedia tag）——核心能力补齐。
3. **Phase 3**（STT/TTS → skills/tools remind+media → approval → webhook → channel_api）——高级能力。
4. **Phase 4**（hot-upgrade → streaming deliverDebounce → upgradeMode 锁定）——打磨。

## 7. 风险登记册 (Risk Register)

### 7.1 对抗性裁决驱动的顶级风险

#### R1：配置存储键差异（claim C1 — confirmed）

| 字段 | 内容 |
|---|---|
| claim | Fork 读 `channels["qqbot-china"]`（`QQBOT_CONFIG_CHANNEL_ID`），上游读 `channels.qqbot`（config.ts:185,199,220,243,...）；直接采纳上游 config 解析会让现有 fork 用户配置变孤儿。 |
| verdict | **confirmed** |
| evidence | Fork：config.ts:5 `QQBOT_CHANNEL_ID="qqbot"`（运行时 channel id）；config.ts:6 `QQBOT_CONFIG_CHANNEL_ID="qqbot-china"`（配置存储键）；config.ts:7 `QQBOT_CONFIG_PREFIX="channels.qqbot-china"`；config.ts:200 `resolveQQBotChannelConfig` 读 `cfg.channels?.[QQBOT_CONFIG_CHANNEL_ID]`；config.ts:203-225 `withQQBotChannelConfig` 写/删；channel.ts:251 `reload.configPrefixes: [...QQBOT_CONFIG_PREFIXES]`（即 `["channels.qqbot-china"]`）。上游：config.ts:185,199,220,243,310,316,331,337,340,342 全部读 `cfg.channels?.qqbot`；channel.ts:81 `reload.configPrefixes: ["channels.qqbot"]`。上游全仓 grep `qqbot-china`/`QQBOT_CONFIG_CHANNEL_ID` **零命中**。 |
| correctedStatement | Claim 精确。Fork 故意拆分两个标识符：运行时 channel id = `"qqbot"`（config.ts:5）vs 配置存储键 = `"qqbot-china"`（config.ts:6）。两侧仅配置键不同（运行时 channel id 相同 `"qqbot"`），但不影响孤儿结论——config 从存储键读取，不从运行时 id。 |
| implication | **硬性阻塞**任何 verbatim 采纳上游 config.ts/onboarding.ts/slash-commands.ts 的 phase。升级计划 **必须**在导入上游 config 解析之前/同时添加显式 config-migration/shim：(a) 一次性迁移 `channels["qqbot-china"]` → `channels.qqbot`，或 (b) **推荐**保留 fork 双键间接层让两个键都解析（更安全的滚动升级，不 touch 用户文件）。reload configPrefixes 也必须匹配所读的键，否则 hot-reload 断裂。**这是 #1 排序依赖**。 |

#### R2：historyLimit 是死配置（claim C2 — confirmed）

| 字段 | 内容 |
|---|---|
| claim | Fork 的 historyLimit 是「死配置」——在 config/schema 中定义但运行时不读取。 |
| verdict | **confirmed** |
| evidence | historyLimit 仅出现在声明：config.ts:86 zod schema（默认 10）、index.ts:73/:128 JSON-Schema、channel.ts:174/:229 JSON-Schema、openclaw.plugin.json:52/:112 JSON-Schema。**无运行时消费**：`grep -rn ".historyLimit" extensions/qqbot/src` 零命中；bot.ts 消费 `qqCfg.*` 字段列表（lines 3074,3117,3311,3312,3331-3334,3831,3835,3844,3852,3853,3876,838,839,878,907）覆盖 longTaskNoticeDelayMs/asr/textChunkLimit/replyFinalOnly/markdownSupport/c2cMarkdownDeliveryMode/c2cMarkdownChunkStrategy/dmPolicy/allowFrom/groupPolicy/groupAllowFrom/requireMention/enabled/mediaTimeoutMs/maxFileSizeMB——**historyLimit 缺席**；无 `resolveQQBotHistoryLimit` helper；对比 sibling `textChunkLimit` 在 bot.ts:3311-3312 被读取。 |
| correctedStatement | 确认。historyLimit 在 8 处声明（zod + 7 处 JSON-Schema），但运行时从不读取。默认值 10 功能无意义。 |
| implication | 升级计划可安全将 historyLimit 视为非承重。若升级意图让 historyLimit 实际控制会话历史裁剪，那是**新功能**，不是 config port——须作为独立实现任务（加 `resolveQQBotHistoryLimit` helper + bot.ts consumer）。不要在任何运行时 phase 上 gate historyLimit；若设计文档列 historyLimit 为活动行为旋钮，应修正为「仅声明」。 |

#### R3：requireMention 是 account 级 flat，无 per-group 优先级链（claim C3 — confirmed）

| 字段 | 内容 |
|---|---|
| claim | Fork 仅有 account 级 flat requireMention，没有 per-group groups map / defaultRequireMention / 4-tier priority chain。 |
| verdict | **confirmed** |
| evidence | config.ts:83 `requireMention: z.boolean().optional().default(true)` 是 `QQBotAccountSchema` 属性（account 级，扁平布尔）。channel.ts:171/:226 JSON-Schema 镜像。bot.ts:3853 消费扁平 `requireMention: qqCfg.requireMention ?? true` 直传 `checkGroupPolicy`。shared group-policy.ts:54-93 取单一 `requireMention: boolean`（param type :20-31），lines 84-90 `if (requireMention && !mentionedBot) return {allowed:false,...}`。负向搜索：`grep -rn "defaultRequireMention"` 零命中；`grep "groups:"` 零 config-object 命中（仅 client.ts 的 QQ API URL path `/v2/groups/...`）。 |
| correctedStatement | 确认。fork `requireMention` 仅作为扁平 account 级布尔（默认 true），在一处读取（bot.ts:3853），由 shared `checkGroupPolicy`（group-policy.ts:85）单一统一 mention gate 强制。无 per-group `groups` config 对象、无 `defaultRequireMention`、无多级优先链。 |
| implication | 引入 per-group mention 行为/默认 fallback/优先链是**净新功能**，非现有逻辑迁移/port。须扩展 `QQBotAccountSchema`（config.ts）+ JSON schema（channel.ts）+ **shared `group-policy.ts`（跨 feishu/wecom/dingtalk/qqbot 共享，改动影响所有 adapter）**+ bot.ts:3849 调用点 per-conversation lookup。4 级优先链须从头设计，无现有优先序可保留。 |

#### R4：STT 格式不兼容（claim C4 — confirmed）

| 字段 | 内容 |
|---|---|
| claim | STT 格式不兼容：fork 的 Tencent ASR 直传 raw SILK；上游 STT 路径期望 WAV。粗暴替换会破坏 Tencent ASR。 |
| verdict | **confirmed** |
| evidence | Fork：tencent-flash.ts:80 `voiceFormat = config.voiceFormat ?? "silk"`；:85 `voice_format: voiceFormat`；:100-103 `Content-Type: application/octet-stream`, `body: audio`（raw buffer 未修改）；bot.ts:886-898 `fetchMediaFromUrl(att.url)` → `transcribeTencentFlash({audio: media.buffer})`，**无转换**。上游：audio-convert.ts:98-138 `convertSilkToWav()` decode SILK→PCM→`pcmToWav`（44-byte RIFF/WAVE header）；stt.ts:64-70 `transcribeAudio()` 按扩展名设 MIME（.wav→audio/wav）POST multipart 到 OpenAI 兼容端点（期望 WAV/MP3/OGG 容器，非 raw SILK）；inbound-attachments.ts:285 `convertSilkToWav` → :303 `transcribeAudio`。 |
| correctedStatement | 确认。fork Tencent Flash ASR 发送 raw downloaded QQ voice buffer（SILK）直接给 Tencent ASR，voice_format 默认 `silk`，无容器转换。上游 STT 路径 decode SILK→PCM→WAV 容器，发 WAV 到 OpenAI 兼容端点。drop-in 替换会破坏 Tencent ASR：(a) 喂 WAV 给 Tencent（voice_format=silk）会告诉 Tencent 字节是 SILK 但实际是 WAV；(b) 喂 raw SILK 给上游 transcribeAudio（.wav 扩展名→audio/wav MIME）会交 OpenAI/Whisper raw SILK，它无法 decode。**注意**：格式在两侧可配置——tencent-flash 支持 `config.voiceFormat`（默认 silk，也支持 wav/pcm），上游 transcribeAudio 纯按扩展名设 MIME。所以不兼容在默认/典型配置间，非硬编码不可能。 |
| implication | 无任何 phase 可「drop-in swap」Tencent ASR 与上游 STT pipeline。须显式音频格式适配层/决策：哪个 STT backend 胜出。保留 Tencent：voice bytes 须继续以 raw SILK + voice_format=silk 到达 `transcribeTencentFlash`——**不可**在它前面插入 `convertSilkToWav`（上游 inbound-attachments.ts:285 正是此插入，合并会静默破坏语音 ASR）。用上游 OpenAI 路径：fork 的 direct-SILK-to-Tencent 流必须替换 **且** SILK→WAV 转换须先运行——意味 Tencent ASR 不能在该路径后原样保留。阻塞任何触碰入站语音处理的 phase；不可在未解决 convertSilkToWav-vs-raw-SILK 分歧前合并上游 inbound-attachments.ts。 |

#### R5：Approval 依赖 SDK createOperatorApprovalsGatewayClient（claim C5 — partially）

| 字段 | 内容 |
|---|---|
| claim | Approval 系统依赖 openclaw/moltbot SDK 暴露 createOperatorApprovalsGatewayClient；fork bundled 的版本未必有此 API，需先验证可用性。 |
| verdict | **partially** |
| evidence | 上游依赖真实存在且文档化：approval-handler.ts:25 `loadGatewayRuntime()` resolve from `dist/plugin-sdk/gateway-runtime.js`；:285 `createOperatorApprovalsGatewayClient`；openclaw-plugin-sdk.d.ts:707-720 声明该 export（版本门控 ≥3.22）；:276-282 加载失败**非致命**——log error + `started=false` + 功能静默降级（不崩溃）。Fork：全仓 grep `createOperatorApprovalsGatewayClient|OperatorApprovals|gateway-runtime|approval-handler` **零命中**；extensions/qqbot/package.json `peerDependencies: {moltbot: ">=0.1.0"}` with `optional: true`——runtime 是**外部可选 peer dependency**，非 vendored/bundled；node_modules ABSENT，无法从磁盘确认 host moltbot 是否实际 export 该 symbol。 |
| correctedStatement | 上游 approval handler 确实依赖 `createOperatorApprovalsGatewayClient`（openclaw/plugin-sdk/gateway-runtime 模块的文档化 export，仅 openclaw ≥3.22 存在）。但 fork **不 bundle 任何 SDK 版本**——moltbot/openclaw 是外部可选 peer dependency 在 host runtime 解析，fork source 含零 approval/gateway-runtime 代码（qqbot extension 无 approval-handler）。正确风险是：(a) **host** moltbot/openclaw runtime 是否 ≥3.22 且 export 该 symbol（非「fork bundled 版本」），(b) fork 当前**无** approval-handler 实现可 port——上游 approval-handler.ts 根本不在 fork。上游 loader 已容错：symbol 不可用时 log error + 禁用 approval 功能而非崩溃。验证：host 环境 `node -e "const m=require('openclaw/plugin-sdk/gateway-runtime'); console.log(typeof m.createOperatorApprovalsGatewayClient)"` 或检查 `node_modules/moltbot/dist/plugin-sdk/gateway-runtime.js`。 |
| implication | 两个不同 gap，均不匹配文档框架：(1) **symbol 可用性是 host 关注**，非 fork-bundling 关注。验证步骤有效但须重述：target **host** openclaw/moltbot 版本（≥3.22），非「bundled fork version」。加 pre-flight 检查。因上游 loader 已优雅降级，**非核心 channel 升级硬阻塞**——仅门控可选 approval 功能。优先级从「升级前必须验证」降为「验证以启用 approval；缺失 = 功能静默关闭」。(2) **porting gap（claim 未述）**：fork 无 approval-handler.ts。若 approval 在升级范围内，需新 phase/port 任务把上游 approval-handler.ts port 进 extensions/qqbot/src/（+ inline 类型 + QQ API helpers sendC2CMessageWithInlineKeyboard/sendGroupMessageWithInlineKeyboard from api.ts）。设计文档当前未捕获此 porting effort。建议加显式「Approval handler port」工作项并确认 api.ts 的 inline-keyboard send 函数在 fork 的 client.ts/outbound.ts 中存在。 |

### 7.2 子系统级风险（汇总）

| ID | 子系统 | 风险 | 缓解 |
|---|---|---|---|
| RR-1 | config-types | 三份手抄 JSON Schema 漂移（index.ts/channel.ts/openclaw.plugin.json） | 抽取 `buildAccountJsonSchema()` 或从 Zod 生成 |
| RR-2 | config-types | `channelConfigs.qqbot.preferOver:["qqbot"]` 自引用（fork id 本身是 qqbot） | **不 port** 此字段 |
| RR-3 | config-types | upgradeMode 默认值分歧（上游 hot-reload vs fork 应 doc） | schema + resolve 双处锁定 doc |
| RR-4 | config-types | STT/ASR 双轨并存（asr.* Tencent vs stt.* OpenAI）shape 不兼容 | 调用方约定优先级（asr 优先），schema 各自独立 |
| RR-5 | transport | Webhook 强依赖 plugin-sdk webhook-ingress，shared 完全没有 | 基于 `MoltbotPluginApi.registerHttpRoute` 重写；verify 先做，限流后做 |
| RR-6 | transport | uncaughtException 进程级全局监听，多账户泄漏 | 严格 finish/abort 时 removeListener，按 accountId 绑定 |
| RR-7 | transport | op:9 语义差异（fork 急清 token vs 上游延迟 shouldRefreshToken） | 统一为上游语义，测试确认无回退 |
| RR-8 | slash-commands | handleQQBotDispatch 接入点（fork per-queue-key abort vs 上游 per-peer URGENT） | 不用上游 clearUserQueue 替换 fork markSessionDispatchAbort |
| RR-9 | slash-commands | runtime.config 跨仓依赖（Phase 2 阻塞） | host PR 确认 loadConfig/writeConfigFile，否则降级 delegatePrompt |
| RR-10 | approval | resolveTarget 正则 `qqbot:` 与 fork `qqbot-china` 前缀不匹配 | 放宽为 `(?:qqbot|qqbot-china):` |
| RR-11 | approval | CommandAuthorized 改造回归面广（bot.ts:2966 true→动态） | 逐路核查 dispatchToAgent/reply dispatcher 授权假设 |
| RR-12 | approval | 独立审批 WS 连接多占 gateway 会话配额 | 确认 appId/clientSecret 两连接并发取 token 不冲突 |
| RR-13 | media | 上传机制结构性分歧（base64 透传 vs prepare/partFinish/complete） | 整组 port，不可渐进合并 |
| RR-14 | media | deliver 管线冲突（上游 outbound-deliver vs fork streaming/markdown-images/markdown transport） | 只复用 media-tags + media-send 拆分函数，executeSendQueue.onSendText re-point fork |
| RR-15 | voice | STT provider 切换改变入站语音语义（C4） | dispatcher 按 provider 严格分流，禁对 Tencent 强制 convertSilkToWav |
| RR-16 | voice | ffmpeg-static 移除行为变化 | CI 覆盖 ffmpeg 缺失场景（WASM fallback） |
| RR-17 | group | parseGroupMessage 数据丢失（硬编码 mentionedBot:true，丢弃 mentions[]） | **前置**扩展 QQInboundMessage + parse 函数捕获 mentions/refMsgIdx/message_type |
| RR-18 | group | core 是否消费 groups adapter 不确定 | 一期 bot.ts 内自消费，适配器注册作二期 |
| RR-19 | group | groupSystemPrompt 注入通道缺失（InboundContext 无字段） | 与 core 团队确认 finalizeInboundContext/dispatch options 支持 |
| RR-20 | multi-account | HTTP 基础设施一致性（后台刷新须用 shared httpPost） | 强制复用 @openclaw-china/shared，禁裸 fetch |
| RR-21 | multi-account | RequestContext target 格式（fork user:/group:/channel: vs 上游 qqbot:c2c:） | target 用 fork 内部表示，禁直接喂 outbound |
| RR-22 | streaming | 全量 REPLACE vs upstream sentIndex 增量语义冲突 | 阶段一/二保留全量 content_raw，阶段四才转增量（需 PoC） |
| RR-23 | skills-tools | registerTool 前置阻塞（fork 无此面） | 阶段 0 最先与主仓对齐 |
| RR-24 | skills-tools | qqbot-upgrade skill curl 上游 npm 包 | **不原样 port**；重写或删除 |
| RR-25 | upgrade | CLS 遥测外泄（默认上报腾讯云） | 默认 CLS_ENABLED=false 或重定向 |
| RR-26 | upgrade | hot-upgrade 进程隔离（上游 setsid kill gateway，fork 是契约回调） | 评估降级为 plugins install + 提示手动重启 |

## 8. 必须保留的 China 特性总表

| # | 特性 | 位置 | 共存策略 |
|---|---|---|---|
| 1 | Config key `channels["qqbot-china"]` | config.ts:6 QQBOT_CONFIG_CHANNEL_ID | 保留为权威 key，加读侧兼容层；所有 ported 上游 config 解析改指向 `qqbot-china` |
| 2 | Zod schema（QQBotAccountSchema/QQBotConfigSchema） | config.ts:55-106 | 保留为权威校验；上游 emptyPluginConfigSchema 不替代 |
| 3 | Tencent Cloud ASR block（asr.* + resolveQQBotASRCredentials + transcribeTencentFlash + ASRError 分类） | config.ts:62-69,304-318；shared asr/tencent-flash.ts, errors.ts | 以 provider:"tencent-flash" 接入上游 provider 分发，走 raw-buffer 路径（不强制 WAV） |
| 4 | displayAliases map（config+account 级 merge） | config.ts:21,270-282 | 在上游 resolveGroupName/known-users 解析后叠加 fork alias 优先级 |
| 5 | C2C markdown 三件套（c2cMarkdownDeliveryMode/ChunkStrategy/SafeChunkByteLimit + chunkQQBotStructuredMarkdown） | config.ts:27-39,71-73；bot.ts:2618,2846-2868 | 上游 outbound-deliver.ts generic chunkMarkdownText 不覆盖；deliver 入口先走 fork C2C markdown 路径 |
| 6 | Typing 心跳三件套（typingHeartbeatMode/IntervalMs/typingInputSeconds + startQQBotTypingHeartbeat + shouldRenew + in-flight guard） | config.ts:41-50,158-174；bot.ts:722-762,3044-3070,3358 | 保留 fork 可配置版本，不替换为上游 TypingKeepAlive 固定 50s/60s |
| 7 | 流式交付（QQBotStreamingController + sendC2CStreamMessage + 500ms throttle + 全量 REPLACE） | streaming.ts:33-333；client.ts:531 | 选择性采纳上游 controller 内部健壮性，不整体替换；保留全量 REPLACE |
| 8 | replyFinalOnly 缓冲模式 + looksLikeQQBotStreamingIneligibleMarkdown 门控 | bot.ts:1537-1550,1638-1657,2829-2844,3340-3607 | 独立于上游 deliver pipeline |
| 9 | sendC2CInputNotify（C2C typing）+ event_id fallback 重试 | outbound.ts:130-161,657-740；client.ts:402 | 保留 fork 契约封装 |
| 10 | KnownQQBotTarget 统一 store（accountId+kind+target 复合键 + legacy 路径迁移 + list/get/remove/clear） | proactive.ts:17-26 | 保留 fork store 为主，加 interactionCount；不换上游 known-users.ts |
| 11 | qqbot-contact-send skill + Python 脚本 | skills/qqbot-contact-send/ | 与上游 tool 并列，不冲突 |
| 12 | 本地化 abort 系统（QQBOT_ABORT_TRIGGERS 40+ 多语言词 + isQQBotFastAbortCommandText + per-queue-key scope + stale-reply 抑制） | bot.ts:114-157,428-444,2984-2990,3962-3983 | 上游 URGENT_COMMANDS 视为加法（仅 /approve 新增），不用 clearUserQueue 替换 |
| 13 | ref-index-store（MAX_CONTENT_LENGTH=500 截断 + normalizeRefIdx/sanitizeEntry + 仅解析 message_scene.ext） + outbound ref-index 缓存（recordOutboundC2CRefIndex） | ref-index-store.ts；outbound.ts:237-271 | 保留 fork 路径与自包含摘要 |
| 14 | inbound media 保留/清理（resolveInboundMediaDir/KeepDays/pruneInboundMediaDir/finalizeInboundMediaFile/scheduleTempCleanup） + ResolvedInboundAttachment/buildInboundContentWithAttachments | config.ts:93-98,132；bot.ts:804,822-928,3095-3096,3819 | 移植 inbound-attachments.ts 时 thread 回 fork media 保留策略 |
| 15 | markdown-images.ts（normalizeQQBotMarkdownImages + in-process 头尺寸解析 + fenced-code 感知 + getQQBotHttpImageSize Range fetch）+ groupMarkdown toggle | markdown-images.ts | 独立模块 |
| 16 | file-as-followup 行为（shouldSendTextAsFollowupForMedia） | outbound.ts:163-165,620-635 | 保留排序规则 |
| 17 | 三键打包（openclaw/moltbot/clawdbot + peerDependency moltbot + npmSpec @openclaw-china/qqbot）+ monorepo release（release-all.mjs/release-setup.mjs，2026.x.x-N 日期 semver，tsup 构建） | extensions/qqbot/package.json:12-74,104；scripts/release-all.mjs:124-133,137 | 保留打包与构建；升级脚本适配 tsup dist 布局 |
| 18 | uiHints block（appId/clientSecret/asr.* 的 label + sensitive） | openclaw.plugin.json:132-138 | manifest 纯加法保留 |
| 19 | registerChinaSetupCli + showChinaInstallHint（@openclaw-china/shared）+ china setup clack 向导 + openclaw-china-setup bin + install banner | index.ts:9,150-151；shared cli/china-setup.ts, install-hint.ts；setup src/cli.ts | 与升级基础设施正交，只要 ported 升级脚本不删 channels["qqbot-china"] |
| 20 | chatTypes 含 channel（direct|group|channel）+ capabilities edit/polls/activeSend/reactions/threads/blockStreaming 标志 | channel.ts:71-81 | 保留 fork 更宽集合；port 上游 manifest capabilities 为独立 manifest-level 字段 |
| 21 | MoltbotPluginApi 接口 + inline configSchema（index.ts default export） | index.ts:11-15,34-147 | 不换成上游 emptyPluginConfigSchema |
| 22 | per-appId token cache Map + singleflight（tokenCacheMap/tokenPromiseMap/clearTokenCache）+ msg_seq 去重重试（isDuplicateMsgSeqError 40054005）+ QQBotSendResult/QQInboundMessage/InboundContext 类型 | client.ts:14-15,17,68-117,84,119-128 | 已是上游兼容形状；后台刷新复用 |
| 23 | dmPolicy（open|pairing|allowlist）+ groupPolicy（open|allowlist|disabled）+ allowFrom/groupAllowFrom policy 模型 + shared checkDmPolicy/checkGroupPolicy | config.ts:81-85；shared policy/dm-policy.ts, group-policy.ts | 上游 message-gating 三层 gate 无 allowlist/disabled 对应——扩展 gate 把 fork policy 映射进去 |
| 24 | 长任务提醒（longTaskNoticeDelayMs + LONG_TASK_NOTICE_TEXT + markReplyDelivered） | config.ts:88；bot.ts:665-666,680-720,3023-3094 | 独立于 deliver pipeline |
| 25 | textChunkLimit（默认 1500）+ resolveChunkMode/resolveMarkdownTableMode 非 C2C 文本分块 | config.ts:87；bot.ts:3306-3329 | 与上游 generic chunker 并存 |
| 26 | 多账户 monitor.ts 连接管理（activeConnections Map + RECONNECT_DELAYS_MS + per-connection heartbeat/reconnect/sessionId/lastSeq + gateway.startAccount/stopAccount 契约 + 重入保护 + cleanupSocket 身份校验） | monitor.ts:44,60-78,119-135,137,176-193,205-216,407,423,440,455 | 保留；上游 startGateway 是自包含 daemon，不替换契约 |
| 27 | buildVoiceASRFallbackReply + VOICE_ASR_FALLBACK_TEXT + asrErrorMessage 中文兜底回复 UX | bot.ts:816-820,662-664,3117-3134 | 保留，作 asr_refer_text 也缺失时的最终用户提示 |
| 28 | [[tts:...]]/[[audio_as_voice]]/[[reply_to_current]] tag 正则（bot.ts:1427-1432） | bot.ts:1427-1432,1469-1490 | port TTS 后从纯剥离升级为触发 TTS 合成 |
| 29 | ref-index transcriptSource 四态（stt/asr/tts/fallback） | ref-index-store.ts:12 | 保留（比上游三态更宽） |
| 30 | ResolvedQQBotAccount 的 fork 字段集（c2cMarkdown*/typingHeartbeat*） | types.ts:17-27 | additive 合并，不被上游 config 透传结构无声覆盖 |

## 9. 配置字段映射附录

### 9.1 asr.* → stt.*/tts.* 映射

| Fork 字段 | 上游字段 | 映射语义 |
|---|---|---|
| `asr.{enabled,appId,secretId,secretKey}`（config.ts:62-69） | `stt.{provider,baseUrl,apiKey,model,enabled}`（stt.ts:30-40）+ `tools.media.audio.models[0]` 回退（stt.ts:43-53）+ `models.providers[provider]` 继承 | 兼容映射：`asr.*` ⟺ `stt.provider:"tencent-flash"`（保留 Tencent 路径）。`resolveQQBotSTTProvider()`：优先 `stt.*`，回退 `asr.*`→`provider:"tencent-flash"`，再回退 `tools.media.audio.models[0]`→OpenAI |
| `transcribeTencentFlash({audio:Buffer})` raw octet-stream（tencent-flash.ts:73-165） | `transcribeAudio(audioPath)` multipart/form-data（stt.ts:58-86） | provider-dispatch：tencent-flash 保留 raw buffer，openai 走 multipart |
| （无） | `tts.{provider,model,baseUrl,apiKey,voice,authStyle,queryParams,speed}` | 新增（config.ts QQBotAccountSchema） |
| （无） | `audioFormatPolicy.{sttDirectFormats,uploadDirectFormats,transcodeEnabled}` + `voiceDirectUploadFormats`(deprecated) | 新增 |

### 9.2 requireMention(flat) → defaultRequireMention + groups.* 映射

| Fork 字段 | 上游字段 | 映射语义 |
|---|---|---|
| `requireMention`（flat account，config.ts:83，默认 true） | `defaultRequireMention`（types.ts:137）+ `groups.*.requireMention` 4 级优先链（config.ts:138: specific > `*` > defaultRequireMention > hardcoded） | port `resolveGroupConfig` 的 account 默认值取 `account.defaultRequireMention ?? account.requireMention ?? true`（**fork flat `requireMention` 作 `defaultRequireMention` fallback**，向后兼容） |
| `historyLimit`（flat account，config.ts:86，默认 10，**dead config**） | per-group `resolveHistoryLimit`（config.ts:148-150，默认 50 via `groups.*.historyLimit`） | port 时 account 级 `historyLimit` 作为 `groups."*".historyLimit` fallback 向后兼容（C2 已确认 dead） |
| `groupAllowFrom`（flat，config.ts:85） | `resolveGroupAllowFrom`（config.ts:106-109，uppercase-normalized）+ shared `checkGroupPolicy` allowlist | fork 继续委托 shared `checkGroupPolicy`，不复制上游内联 `evaluateMatchedGroupAccessForPolicy` |
| `groupPolicy`（flat，config.ts:82，默认 open） | `resolveGroupPolicy`/`isGroupAllowed`（config.ts:100-123，默认 open） | 同默认；保留 security.collectWarnings open-policy warning（channel.ts:326-333） |
| `checkGroupPolicy`（shared，bot.ts:3849） | `resolveGroupMessageGate`（message-gating.ts:129）+ `isGroupAllowed` | 准入仍用 shared checkGroupPolicy（disabled/allowlist），细粒度门控用新 gate（串行叠加，不替换） |
| `mentionedBot`（硬编码 true，parseGroupMessage bot.ts:1116） | `detectWasMentioned` + `resolveImplicitMention`（gateway.ts:1091/1116）+ gate.effectiveWasMentioned | fork 保留 mentionedBot=true 默认，新增 mentions[] 捕获让 ignoreOtherMentions/implicit 在数据存在时生效 |
| `GroupSubject`（=raw groupOpenid，buildInboundContext bot.ts:2959） | `resolveGroupName`（config.ts:176-179，configured name > openid.slice(0,8)） | port |
| （无）groupSystemPrompt channel | `resolveGroupIntroHint`（channel.ts:103-112）+ `resolveGroupPrompt`（config.ts:153-158，DEFAULT_GROUP_PROMPT CN anti-robot-spam PE）注入（gateway.ts:1203-1214） | port（InboundContext.GroupSystemPrompt? + finalizeInboundContext 注入） |
| （无）toolPolicy | `resolveToolPolicy`（config.ts:171）映射 via channel groups adapter（channel.ts:92-100: full→undefined / none→{allow:[],deny:[*]} / restricted→{allow:[]}） | port（一期 bot.ts 内自消费，二期 SDK adapter） |
| （无）ignoreOtherMentions/hasAnyMention | GroupConfig.ignoreOtherMentions（types.ts:51）+ message-gating Layer 1 + hasAnyMention | port（需前置扩展 parseGroupMessage 捕获 mentions[]） |

### 9.3 其他映射（汇总自各子系统 forkToUpstreamMap）

| Fork | 上游 | 映射 |
|---|---|---|
| `clientSecret`（inline only，config.ts:59） | `clientSecret`/`clientSecretFile`/`QQBOT_CLIENT_SECRET` env 三级回退（config.ts:267-281） | port 回退链；env 仅 default 账户 |
| `convertAudioToSilk`（ffmpeg-static+silk-wasm，send.ts:115-142） | `audioFileToSilkFile` 多层 fallback（audio-convert.ts:555-602） | 替换为 shared audioFileToSilkFile；移除 ffmpeg-static 硬依赖 |
| `[[tts:]]` 纯剥离正则（bot.ts:1427-1432） | reply-dispatcher.handleAudioPayload（reply-dispatcher.ts:205-237） | 升级为触发 TTS 合成 |
| `formatQQBotError`/`normalizeHttpErrorBody` 裸字符串（send.ts:248-277） | OUTBOUND_ERROR_CODES + resolveUserFacingMediaError（outbound.ts:170-205） | port |
| `sendFileQQBot` base64（send.ts:144-205） | chunkedUploadAndSend（outbound.ts:521-627）+ chunkedUploadC2C/Group | re-point，保留 refIdx |
| `uploadC2CMedia`/`uploadGroupMedia` url 透传（client.ts:446/475） | c2cUploadPrepare+partFinish+complete（api.ts:884-991） | port（整组） |
| `QQBotStreamingController`（streaming.ts:33） | StreamingController（streaming.ts:235） | 选择性采纳内部机制，不整体替换 |
| `RECONNECT_DELAYS_MS [1000,2000,5000,10000,20000,30000]`（monitor.ts:44） | `RECONNECT_DELAYS [1000,2000,5000,10000,30000,60000]`（gateway.ts:356） | 注意第 5/6 项不同 |
| `getAccessToken` 惰性 5min 阈值（client.ts:138-141） | 自适应 `min(5min, expiresIn/3)`（api.ts:151-153） | port 自适应 |
| `ResolvedQQBotAccount` 薄字段（types.ts:17-27） | 富字段含 clientSecret/secretSource/systemPrompt/imageServerBaseUrl（types.ts:19-33） | 可选扩展（不暴露 clientSecret，fork 经 resolveQQBotCredentials 单独传） |
| pkg id `qqbot`（openclaw.plugin.json:2） | `openclaw-qqbot`（openclaw.plugin.json:3） | 保留 fork id |
| npmSpec `@openclaw-china/qqbot`（package.json:28） | PKG_NAME `@tencent-connect/openclaw-qqbot` | port 时全改 |
| config key `qqbot-china`（config.ts:6） | `qqbot`（config.ts:185,...） | **保留 fork key + 读侧兼容层**（C1） |
| tsup 扁平 dist/index.js（package.json:75） | tsc 层级 dist/src/gateway.js|api.js|admin-resolver.js | postflight 适配 tsup |
| build `tsup`（package.json:84） | build `tsc || true`（package.json:27） | 保留 tsup |
| `register()` 三步（registerChinaSetupCli+showChinaInstallHint+registerChannel，index.ts:150-156） | register()（setQQBotRuntime+registerChannel+registerChannelTool+registerRemindTool，index.ts:11-16） | fork 多出 china-setup/install-hint，保留 |

## 10. 实施前置验证清单 (Definition-of-Ready)

### Phase 1 前置

- [x] **config key 决策已定**：保留 `qqbot-china` 权威 + 读侧兼容层（同时读 `qqbot`/`qqbot-china`），或一次性迁移脚本。文档化决策。
  - **决策（2026-06-13 落地）**：采用 R1/C1 推荐的「双键间接层」(b) 方案，不 touch 用户文件。`channels["qqbot-china"]` 保持权威（写入路径 `withQQBotChannelConfig`/onboarding/china-setup 仅写此键）；新增 `channels.qqbot` 作为**只读回退**。实现：`config.ts` 新增 `QQBOT_CONFIG_CHANNEL_ID_FALLBACK="qqbot"`；`resolveQQBotChannelConfig` 先读 `qqbot-china`，缺失时回落 `qqbot`（两键并存时 `qqbot-china` 胜）。覆盖测试见 `config.test.ts`（5 用例：权威命中 / 回退命中 / 并存时权威胜 / 两键皆无 / 非 object 值忽略）。
- [x] **`reload.configPrefixes` 与所读键匹配**：`QQBOT_CONFIG_PREFIXES` 已扩为 `["channels.qqbot-china","channels.qqbot"]`，`channel.ts:251` reload 同步覆盖两键，hot-reload 不断裂。`channel.test.ts` 断言已更新。
- [x] **fork-local `getDataDir()` 已建**：session-store 依赖 platform helper（`getQQBotDataDir`），fork 已在 ref-index-store.ts:34 内联相同约定——确认 re-inline 或加 helper。
  - **决策（2026-06-13 落地）**：采用「加 helper」方案。新增 `extensions/qqbot/src/platform.ts`，导出三个函数：`getHomeDir()`（robust 主目录：`os.homedir()` → `$HOME`/`%USERPROFILE%` → `os.tmpdir()`）、`qqbotDataDirPath(...subPaths)`（**纯路径**，`~/.openclaw/qqbot/...`，无 fs 副作用——供模块加载期路径常量使用，避免 eager 创建）、`getQQBotDataDir(...subPaths)`（路径 + `mkdirSync recursive`，**对齐上游契约**，`session-store.ts` 移植后 `getQQBotDataDir("sessions")` 可直引）。已将 `ref-index-store.ts`（`REF_INDEX_FILE`）与 `proactive.ts`（`DEFAULT_KNOWN_TARGETS_PATH`）的内联 `~/.openclaw/qqbot/data` 收敛到 `qqbotDataDirPath("data")`（纯路径，保持原有 lazy mkdir 行为不变）；`proactive.ts` 的 LEGACY 路径（`~/.openclaw/data/qqbot`，不同 base）保留字面量。**未改 `config.ts` 的 `DEFAULT_INBOUND_MEDIA_DIR`**（属 media 子系统 4.5，且避免在广泛 import 的 config 模块引入 eager 创建副作用）。测试见 `platform.test.ts`（5 用例，含真实 mkdir + 清理）。
- [x] **三处手抄 JSON Schema 同步机制已定**：抽取 `buildAccountJsonSchema()` 或从 Zod 生成，否则新增字段三处遗漏。
  - **决策（2026-06-13 落地）**：采用「集中常量」方案（不引入 `zod-to-json-schema` 依赖，避免 schema shape 变更风险）。新增 `extensions/qqbot/src/config-schema.ts` 导出 `buildQQBotAccountJsonSchema()` + `buildQQBotConfigJsonSchema()`，字段集镜像 `QQBotAccountSchema`（Zod，权威）。`index.ts` 与 `channel.ts` 的内联手抄 schema 已替换为 builder 调用（两处 TS 源合一）。`openclaw.plugin.json` 为静态 JSON 无法 import，改为**逐字对齐 builder 输出**（补齐此前缺失的 `c2cMarkdownSafeChunkByteLimit`），并由 `config.test.ts` 新增 **parity 测试**（断言 manifest 顶层 + account 层 property keys 与 builder 一致）锁死漂移。**同时修复了既有双向漂移**：`index.ts`/`channel.ts` 此前缺 `typingHeartbeatMode`/`typingHeartbeatIntervalMs`/`typingInputSeconds` 且 `maxFileSizeMB`/`mediaTimeoutMs` 约束过松；`openclaw.plugin.json` 此前缺 `c2cMarkdownSafeChunkByteLimit`——现在三处统一为 Zod 权威集。

### Phase 2 前置

- [ ] **`parseGroupMessage` 扩展已完成**：`QQInboundMessage`（types.ts:46-62）新增 `mentions?`/`refMsgIdx?`/`messageType?`/`msgElements?`，parse 函数（bot.ts:1096-1118）保留这些字段。否则 group gate 静默失效。
- [ ] **core 是否消费 `groups` adapter 已确认**：若不消费，`resolveToolPolicy` 须在 `dispatchToAgent` 内手动应用（一期自消费）。
- [ ] **groupSystemPrompt 注入通道已确认**：core 的 `finalizeInboundContext` 或 dispatch options 是否支持 extraSystemPrompt/GroupSystemPrompt 字段。
- [ ] **chunked 上传 API 客户端成组 port**：c2cUploadPrepare/partFinish/complete + 类型 + file-utils + platform helpers 全部就绪，re-point 前确认 ref-index/ASR/streaming 调用点完整。
- [ ] **slash 框架接入点已定**：`handleQQBotDispatch`（bot.ts:3863）顶部、fork abort（bot.ts:3962）之前；`isQQBotFastAbortCommandText` 路径保留测试通过。
- [ ] **RequestContext 作用域边界已确认**：`runWithRequestContext` 包裹「会执行 AI agent turn / tool execute」的异步链，跨 await 生效。

### Phase 3 前置

- [ ] **host moltbot/openclaw 版本 ≥3.22 已确认**：host 环境 `node -e "const m=require('openclaw/plugin-sdk/gateway-runtime'); console.log(typeof m.createOperatorApprovalsGatewayClient)"` 或检查 `node_modules/moltbot/dist/plugin-sdk/gateway-runtime.js`。**C5 partially**：symbol 可用性是 host 关注，非 fork-bundling。缺失 = approval 功能静默关闭（非硬阻塞），上游 loader 已容错。
- [ ] **`@openclaw-china/shared` 暴露 webhook-ingress API 已确认**：grep shared/src 确认无 `registerWebhookTarget`/`withResolvedWebhookRequestPipeline`/`createFixedWindowRateLimiter`/`createWebhookInFlightLimiter`。若无，webhook transport 须基于 `MoltbotPluginApi.registerHttpRoute` 重写（RR-5）。
- [ ] **`MoltbotPluginApi.registerHttpRoute`/`registerHttpHandler` 已扩**：照 wechat-mp/src/types.ts:590-619 先例。
- [ ] **STT provider 分发层已建**：dispatcher 按 provider 严格分流，Tencent 走 raw buffer（禁 convertSilkToWav），OpenAI 走 multipart（C4）。
- [ ] **shared audio 层已下沉**：`packages/shared/src/audio/audio-convert.ts` + `ffmpeg.ts` 移植完成，silk-wasm/mpg123-decoder 加入 shared package.json。
- [ ] **registerTool 面已打通**：`MoltbotPluginApi` 增加 `registerTool?`，与主仓对齐（阶段 0）。
- [ ] **api.ts inline-keyboard send 函数存在性已确认**：approval port 需 sendC2CMessageWithInlineKeyboard/sendGroupMessageWithInlineKeyboard，fork client.ts/outbound.ts 当前无——需 port。

### Phase 4 前置

- [ ] **fork 实际安装布局已实测**：openclaw-china 的 `findCli`/`switchPluginSourceToNpm` 行为目标，`~/.openclaw` 路径假设。
- [ ] **`checkUpgradeCompatibility` 白名单已复核**：最低框架版本（2026.3.2）、平台白名单（仅 darwin/linux，Windows 被排除），fork 部署目标是否需放宽。
- [ ] **`PLUGIN_IDS` 清理列表已补**：fork 历史包名（`@openclaw-china/qqbot` 早期命名）。
- [ ] **CLS 遥测中和方案已定**：默认 `CLS_ENABLED=false` 或重定向到 fork 自有端点。
- [ ] **upgradeMode 默认值已锁**：schema + resolve 双处 `doc`（非上游 `hot-reload`）。
- [ ] **postflight 适配 tsup 布局**：校验 `dist/index.js` 等扁平文件，非 `dist/src/gateway.js`。

## 11. 文件清单

### 11.1 Fork 侧待改造文件

| 文件（绝对路径） | 涉及子系统 | 改造类型 |
|---|---|---|
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/config.ts` | config(4.1)/group(4.7)/slash(4.3)/voice(4.6)/multi-account(4.8)/upgrade(4.12) | Zod schema 扩展 + 新增 resolve 辅助 |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/types.ts` | config(4.1)/approval(4.4)/group(4.7)/voice(4.6)/media(4.5) | additive 类型 + 新导出 |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/channel.ts` | config(4.1)/group(4.7)/approval(4.4)/transport(4.2)/multi-account(4.8)/upgrade(4.12) | configSchema 同步 + groups adapter + hooks + gateway 接线 |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/bot.ts` | slash(4.3)/approval(4.4)/media(4.5)/voice(4.6)/group(4.7)/multi-account(4.8)/streaming(4.9)/skills(4.11) | handleQQBotDispatch 接入 + resolveInbound 扩展 + buildInboundContext + shouldHandleMessage + dispatchToAgent + media 提取 |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/monitor.ts` | transport(4.2)/multi-account(4.8)/skills(4.11) | session-store 接入 + close-code 分支 + background token + uncaughtException + INTERACTION intent + RequestContext 包裹 + api primitives |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/client.ts` | transport(4.2)/media(4.5)/multi-account(4.8)/skills(4.11) | background token refresh + getPluginUserAgent + chunked upload API + types |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/outbound.ts` | approval(4.4)/media(4.5)/streaming(4.9) | shouldSuppressLocalPayloadPrompt + media tag 路由 + 错误码映射 |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/send.ts` | media(4.5)/voice(4.6) | chunked 上传 re-point + convertAudioToSilk 替换 |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/streaming.ts` | streaming(4.9) | 边界检测 + FlushController + StreamingPhase |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/runtime.ts` | slash(4.3) | PluginRuntime 扩展 config 字段（Phase 2） |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/index.ts` | config(4.1)/slash(4.3)/transport(4.2)/skills(4.11)/upgrade(4.12) | configSchema 同步 + registerTool + registerHttpRoute 扩展 + registerChinaSetupCli 保留 |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/openclaw.plugin.json` | config(4.1)/upgrade(4.12) | configSchema 同步 + capabilities + extensions |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/package.json` | media(4.5)/voice(4.6)/upgrade(4.12)/skills(4.11) | deps（移除 ffmpeg-static）+ bundledDependencies + scripts.postinstall + extensions + bin |
| `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/config.test.ts` | config(4.1) | 15 个新测试用例 |
| `/home/rainbow/Code/openclaw-china/packages/shared/src/index.ts` | voice(4.6) | export audio/ |
| `/home/rainbow/Code/openclaw-china/packages/shared/package.json` | voice(4.6) | silk-wasm + mpg123-decoder |
| `/home/rainbow/Code/openclaw-china/packages/shared/src/asr/index.ts` | voice(4.6) | transcribe() dispatcher |
| `/home/rainbow/Code/openclaw-china/packages/shared/src/asr/openai-stt.ts` | voice(4.6) | 新建 |

**Fork 侧新建文件**：
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/platform.ts`（transport 4.2）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/session-store.ts`（transport 4.2）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/transport/webhook-verify.ts`（transport 4.2）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/transport/webhook-transport.ts`（transport 4.2）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/utils/ssrf-guard.ts`（media 4.5）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/utils/chunked-upload.ts`（media 4.5）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/utils/file-utils.ts`（media 4.5）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/utils/outbound-errors.ts`（media 4.5）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/utils/upload-cache.ts`（media 4.5）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/utils/media-tags.ts`（media 4.5 / skills 4.10）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/utils/media-send.ts`（media 4.5）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/utils/pkg-version.ts`（slash 4.3 / upgrade 4.11）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/utils/platform.ts`（slash 4.3）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/update-checker.ts`（slash 4.3 / upgrade 4.11）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/slash-commands.ts` 或 `src/slash-commands/`（slash 4.3）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/slash-commands/logs.ts`、`clear-storage.ts`、`streaming.ts`、`group-allways.ts`、`approve.ts`、`upgrade.ts`（slash 4.3）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/message-gating.ts`（approval 4.4 / group 4.7）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/approval-handler.ts`（approval 4.4）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/approval-interaction.ts`（approval 4.4）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/admin-resolver.ts`（approval 4.4）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/group-config.ts`（group 4.7）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/group-history.ts`（group 4.7）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/group-gating-helpers.ts`（group 4.7）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/request-context.ts`（multi-account 4.8 / skills 4.10）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/deliver-debounce.ts`（streaming 4.9）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/stt.ts`（voice 4.6）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/tts.ts`（voice 4.6）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/credential-backup.ts`（slash 4.3）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/startup-greeting.ts`（slash 4.3）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/tools/remind.ts`（skills 4.10）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/src/tools/channel.ts`（skills 4.10）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/preload.cjs`（upgrade 4.11）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/scripts/link-sdk-core.cjs`、`postinstall-link-sdk.js`、`upgrade-via-npm.sh/.ps1`、`upgrade-via-source.sh`、`cleanup-legacy-plugins.sh`（upgrade 4.11）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/bin/qqbot-cli.js`（slash 4.3 / upgrade 4.11）
- `/home/rainbow/Code/openclaw-china/extensions/qqbot/skills/qqbot-remind/SKILL.md`、`qqbot-media/SKILL.md`、`qqbot-channel/SKILL.md`、`qqbot-upgrade/SKILL.md`（skills 4.10 / upgrade 4.11）
- `/home/rainbow/Code/openclaw-china/packages/shared/src/audio/audio-convert.ts`、`ffmpeg.ts`、`index.ts`（voice 4.6）

### 11.2 上游参考文件

路径前缀：`/home/rainbow/.claude/jobs/84cc979b/tmp/openclaw-qqbot-upstream/`

| 上游文件 | 参考 subsystem |
|---|---|
| `src/config.ts`、`src/types.ts`、`src/channel.ts`、`index.ts` | config(4.1) |
| `src/gateway.ts`、`src/session-store.ts`、`src/transport/webhook-transport.ts`、`src/transport/webhook-verify.ts`、`src/utils/platform.ts`、`src/api.ts` | transport(4.2) |
| `src/slash-commands.ts`、`src/update-checker.ts`、`src/startup-greeting.ts`、`src/credential-backup.ts`、`src/approval-handler.ts`、`src/utils/pkg-version.ts`、`bin/qqbot-cli.js` | slash(4.3) |
| `src/approval-handler.ts`、`src/admin-resolver.ts`、`src/message-gating.ts`、`src/known-users.ts` | approval(4.4) |
| `src/utils/chunked-upload.ts`、`src/utils/upload-cache.ts`、`src/utils/file-utils.ts`、`src/utils/ssrf-guard.ts`、`src/utils/media-tags.ts`、`src/utils/media-send.ts`、`src/utils/outbound-errors.ts`、`src/image-server.ts`、`src/outbound.ts`、`src/outbound-deliver.ts` | media(4.5) |
| `src/utils/audio-convert.ts`、`src/stt.ts`、`src/reply-dispatcher.ts`、`src/inbound-attachments.ts` | voice(4.6) |
| `src/group-history.ts`、`src/message-gating.ts` | group(4.7) |
| `src/request-context.ts`、`src/api.ts` | multi-account(4.8) |
| `src/streaming.ts`、`src/typing-keepalive.ts`、`src/deliver-debounce.ts` | streaming(4.9) |
| `src/tools/remind.ts`、`src/tools/channel.ts`、`src/utils/media-tags.ts`、`skills/qqbot-remind/SKILL.md`、`skills/qqbot-media/SKILL.md`、`skills/qqbot-channel/SKILL.md`、`skills/qqbot-channel/references/api_references.md` | skills(4.11) |
| `scripts/upgrade-via-npm.sh`、`scripts/upgrade-via-npm.ps1`、`scripts/upgrade-via-source.sh`、`scripts/cleanup-legacy-plugins.sh`、`scripts/postinstall-link-sdk.js`、`scripts/link-sdk-core.cjs`、`preload.cjs`、`package.json` | upgrade(4.12) |

## 12. 测试总策略

### 12.1 测试分层

| 层 | 目标 | 范围 |
|---|---|---|
| **单元（纯函数）** | 移植的纯逻辑模块零依赖验证 | `message-gating.ts`、`group-config.ts`、`group-history.ts`、`media-tags.ts`、`media-send.ts`、`ssrf-guard.ts`、`deliver-debounce.ts`、`request-context.ts`、`webhook-verify.ts`、`update-checker.ts`、`pkg-version.ts`、`chunked-upload` 哈希/协议 |
| **单元（mock）** | 依赖 client/fs/api 的逻辑验证 | `session-store.test.ts`（mock fs + 节流）、`monitor.test.ts`（mock WebSocket + client）、`client.test.ts`（mock httpPost + token）、`approval-handler.test.ts`（mock gateway-runtime + QQ API）、`webhook-transport.test.ts`（mock registerHttpRoute） |
| **集成（端到端 mock dispatch）** | fork 契约接线正确性 | `bot.group-gate.test.ts`、`bot.approval-gating.test.ts`、`extractQQBotReplyMedia` 端到端、slash 命令 dispatch、remind 冒烟 |
| **回归** | China 特性不被破坏 | 现有 `config.test.ts`、`bot.stop-command.test.ts`、`bot.streaming.test.ts`、`bot.c2c-markdown-transport.test.ts`、`bot.reply-final-only.test.ts`、`bot.known-targets.test.ts`、`bot.media-extraction.test.ts`、`markdown-images.test.ts`、`china-setup.test.ts`、`manifest.skills.test.ts` |

### 12.2 关键测试矩阵（跨子系统）

| 测试 | 验证目标 | 关联风险 |
|---|---|---|
| config key 读侧兼容层 | `channels["qqbot-china"]` 与 `channels.qqbot` 都能解析 | R1/C1 |
| historyLimit 不影响运行时 | 修改 historyLimit 默认值后行为不变 | R2/C2 |
| Tencent provider raw-buffer 路径 | convertSilkToWav **不**被调用，fetch 收到 application/octet-stream | R4/C4 |
| OpenAI provider WAV 路径 | convertSilkToWav 生成 .wav，multipart POST | R4/C4 |
| resolveGroupConfig 4 级链 + requireMention fallback | account.requireMention 作 defaultRequireMention fallback | R3/C3 |
| parseGroupMessage 扩展后 mentionedBot=true 默认 | 无 mentions 字段仍 pass，不引入 skip 回归 | RR-17 |
| matchSlashCommand 在 fork abort 之前 | `/stop`/`停止` 走 fork abort，`/bot-ping` 走 slash | RR-8 |
| resolveTarget 正则 qqbot-china 命中 | approval 请求不被丢弃 | RR-10 |
| background token 刷新用 shared httpPost | 非裸 fetch | RR-20 |
| upgradeMode 默认 doc | 非 hot-reload | RR-3 |
| upgrade-via-npm.sh 改写回归 | PKG_NAME/PLUGIN_ID/CLS/temp-config/postflight 全 fork 化 | RR-25/26 |
| streaming 全量 REPLACE 保留 | 移植 controller 骨架后 content_raw 仍全量 | RR-22 |

### 12.3 测试优先级（与 Phase 对齐）

- **Phase 1**：session-store.test.ts、monitor.test.ts（close-code/RESUME/background token/User-Agent/uncaughtException/op:11 回归）、client.test.ts、ssrf-guard.test.ts、config.test.ts（新字段 + 三处 Schema 一致性）。
- **Phase 2**：group-config.test.ts、message-gating.test.ts、group-history.test.ts、bot.group-gate.test.ts、media-tags.test.ts、media-send.test.ts、extractQQBotReplyMedia 端到端、streaming 边界/FlushController 测试、update-checker.test.ts。
- **Phase 3**：approval-handler.test.ts、approval-interaction.test.ts、admin-resolver.test.ts、bot.approval-gating.test.ts、webhook-verify.test.ts、webhook-transport.test.ts、request-context.test.ts、remind/media-tags/channel 工具测试、STT/TTS provider 测试。
- **Phase 4**：upgrade-via-npm.sh 改写回归、preload.cjs/postinstall 集成、china-setup 不受影响回归、发版兼容测试、deliver-debounce 测试。

### 12.4 回归保护原则

每个 phase 落地前，运行完整 China 回归套件（config.test.ts / bot.stop-command.test.ts / bot.streaming.test.ts / bot.c2c-markdown-transport.test.ts / bot.reply-final-only.test.ts / bot.known-targets.test.ts / bot.media-extraction.test.ts / markdown-images.test.ts / china-setup.test.ts / manifest.skills.test.ts）确认全绿。任何 China 特性回归必须在该 phase 标记完成前修复——**不可跨 phase 累积回归债**。
