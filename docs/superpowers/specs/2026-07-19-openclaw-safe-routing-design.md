# OpenClaw 安全模型路由与可审计交付设计

- 日期：2026-07-19
- 状态：设计已确认，待实施计划
- 路线：Core 最小强制门 + 任务策略插件
- 首个试点：文本、只读、低风险、影子路由

## 1. 目标

1. fallback 候选必须满足任务契约，不得静默损失上下文、模态、工具、结构化输出或 runtime 能力。
2. 模型失败后，只有在确认没有重放风险时才能切换候选。
3. 外部动作先持久化记录再执行；结果不确定时不得盲目重试。
4. 任务生命周期、完成范围、降级模式、阻塞原因、复核状态和副作用安全状态分开表达。
5. 正式终结必须同时通过完成度、复核、证据、决策等级和副作用安全门禁。
6. 所有路由、切换、阻塞、对账和正式交付都有稳定的审计证据。

## 2. 非目标

- 首期不修改当前 `primary/fallbacks`。
- 不对全部普通会话强制开启安全路由。
- 第一期不强制接管图片、音频、视频或超长上下文切换。
- 不通过工具名或输出文本猜测外部副作用。
- 不建设第二套任务库、SQLite、出站队列或发送 worker。
- 不存储模型隐藏思维过程、凭据、token、API key 或完整普通会话副本。
- 不承诺跨外部平台的绝对 exactly-once；目标是本地原子事务、at-least-once 调度及幂等/远端对账。

## 3. 架构和所有权

采用混合路线：Core 只实现不可绕过的通用执行门，任务契约、风险、复核和路由策略由任务插件管理。

### 3.1 Core

- fallback 候选能力准入接口。
- 实际 runtime、鉴权目标和故障域观测接口。
- 模型失败后的重放安全熔断。
- 工具副作用声明协议及 Effect Ledger 执行包装。
- 受管任务的 fail-closed 终结门。
- finalization 与现有交付队列的同事务绑定。
- 交付 worker 发送前的 finalization 二次校验。

### 3.2 任务策略插件

- `TaskContract` 的创建和规范化。
- 风险等级、最低决策等级和复核要求。
- 模型能力快照、证据来源和影子路由。
- 检查点、证据完整性和复核工作流。
- 对外状态与徽标派生。
- 试点任务准入和功能开关。

### 3.3 Provider、Runtime、Tool 和 Channel

- Provider/Runtime 提供能力声明、端点、runtime 和故障域事实。
- Tool 声明副作用策略、规范化 intent、回执提取和对账方法。
- Channel 继续拥有实际发送、unknown-send reconciliation 和平台回执。

## 4. 激活与兼容性

```ts
type TaskSafetyContext = {
  taskId: string;
  contractDigest: string;
  checkpointId: string;
  routingPolicyVersion: string;
  mode: "shadow" | "enforce";
};
```

`TaskSafetyContext` 只能由受信任的任务协调器构造，不接受模型输出、提示词或工具参数内的同名字段。

普通会话没有该上下文时，候选链、auth profile rotation、fallback 错误分类、普通回复和渠道发送均保持现状。

任务插件配置：

```ts
safeRouting: {
  mode: "off" | "shadow" | "enforce";
  allowedTaskKinds: string[];
}
```

默认 `mode = "off"` 且 `allowedTaskKinds = []`。

## 5. 任务契约

```ts
type PersistedTaskContract = {
  schemaVersion: 1;
  taskId: string;
  requiredCapabilities: {
    modalities: Array<"text" | "image">;
    minEffectiveContextTokens: number;
    minOutputTokens: number;
    toolCalling: boolean;
    structuredOutput: boolean;
    runtimeIds?: string[];
    dataPolicy: "local-only" | "approved-providers";
  };
  minimumDecisionGrade: "draft" | "analysis" | "decision" | "final";
  riskClass: "low" | "medium" | "high";
  reviewRequired: boolean;
  allowedToolPolicyId: string;
  deliveryMode: "none" | "internal" | "formal";
  routingPolicyVersion: string;
};
```

持久化时规范化 JSON 并保存 SHA-256 digest。检查点、复核、finalization 和交付均绑定该 digest。

`minEffectiveContextTokens` 是实际运行预算，runtime 使用开放 ID 列表，决策等级属于任务治理策略。能力未验证不等于支持。`deliveryMode=none` 只保存审计事实，`internal` 仅允许内部任务状态/结果投影，`formal` 必须走 finalization 和现有持久交付队列。

## 6. 数据和状态模型

所有表写入现有共享 `state/openclaw.sqlite`，使用 Kysely 和现有迁移机制。

### 6.1 复用 `task_runs`

`task_runs.status` 继续作为唯一生命周期事实，新增非终态 `blocked`：

```ts
type TaskStatus =
  | "queued"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost";
```

新的 `status=blocked` 是可恢复的非终态，仅用于挂载 `task_safety_state` 的受管任务。现有 `terminalOutcome=blocked` 仍保留为历史终态结果，不表示等待恢复。

### 6.2 `task_safety_state`

新增一对一表，不重复保存 phase：

```text
task_id                    TEXT PRIMARY KEY
execution_mode             TEXT NOT NULL
completion                 TEXT NOT NULL
block_reason               TEXT
review_state               TEXT NOT NULL
effect_safety              TEXT NOT NULL
current_checkpoint_id      TEXT
reviewed_checkpoint_id     TEXT
approved_review_id         TEXT
evidence_complete          INTEGER NOT NULL DEFAULT 0
achieved_decision_grade    TEXT
row_version                INTEGER NOT NULL DEFAULT 1
updated_at                 INTEGER NOT NULL
```

```text
execution_mode = NORMAL | DEGRADED
completion     = NONE | PARTIAL | COMPLETE
block_reason   = CAPABLE_MODEL | REVIEW | UNSAFE_RETRY | null
review_state   = NOT_REQUIRED | REQUIRED | IN_REVIEW | APPROVED | REJECTED
effect_safety  = CLEAN | COMMITTED | INDETERMINATE | RECONCILED
```

### 6.3 目标表

| 表 | 用途 | 阶段 |
|---|---|---|
| `task_contracts` | 任务契约、风险和所需能力 | Phase 1 |
| `task_safety_state` | 完成度、降级、阻塞、复核和副作用安全 | Phase 1 |
| `model_capability_snapshots` | 不可变能力声明和探针结果 | Phase 1 |
| `model_route_attempts` | 候选过滤、切换和故障域审计 | Phase 1 |
| `task_checkpoints` | Phase 1 保存最小只读检查点，Phase 2 启用可续跑交接语义 | Phase 1 |
| `effects` | 非交付类外部动作账本 | Phase 3 |
| `task_reviews` | 独立复核记录 | Phase 4 |
| `finalizations` | 正式终结门禁快照 | Phase 5 |

不新增 `provider_health`。动态健康状态复用现有鉴权冷却数据，当次解析结果写入 `model_route_attempts`。

### 6.4 状态不变式

```text
[对存在 task_safety_state 的受管任务]
task_runs.status = blocked <=> block_reason 非空
effect_safety = INDETERMINATE => blocked/UNSAFE_RETRY
review_state = APPROVED => reviewed_checkpoint_id = current_checkpoint_id
task_runs.status = succeeded
  => completion = COMPLETE
  => evidence_complete = true
  => review_state in (NOT_REQUIRED, APPROVED)
  => effect_safety in (CLEAN, RECONCILED)
  => deliveryMode = formal 时存在 ACTIVE finalization
```

状态只能通过 Core 转换服务更新，使用 `row_version` CAS 防止迟到结果覆盖新状态。`DEGRADED` 只是执行模式，不改写完成度或复核状态。

### 6.5 检查点

`task_checkpoints` 保存契约 digest、已完成步骤、规范化消息或 transcript 指针、工具结果 schema/hash、源文件指纹、证据 digest、未完成事项、已明示假设、策略版本和能力快照 ID。不保存隐藏思维过程。

## 7. 能力快照与真实路由目标

保持 `ModelCandidate = { provider, model }` 作为身份。能力快照区分 `declared | catalog | observed | verified | contradicted | unverified`。

```ts
type ResolvedRouteTarget = {
  provider: string;
  model: string;
  authProfileRef?: string;
  runtimeId: string;
  endpointId?: string;
  capabilitySnapshotId: string;
  failureDomain: {
    upstream?: string;
    quotaPool?: string;
    gateway?: string;
    region?: string;
    modelFamily?: string;
  };
};
```

`authProfileRef` 使用稳定非秘密 ID 或哈希，不落鉴权材料。

## 8. 候选能力门

```ts
type CandidateAdmissionDecision =
  | {
      outcome: "eligible";
      capabilitySnapshotId: string;
      resolvedRuntimeId: string;
    }
  | {
      outcome: "ineligible";
      code:
        | "MODALITY"
        | "CONTEXT"
        | "OUTPUT"
        | "TOOLS"
        | "STRUCTURED_OUTPUT"
        | "RUNTIME"
        | "DATA_POLICY"
        | "DECISION_GRADE"
        | "CAPABILITY_UNVERIFIED";
      reason: string;
    };

type ModelCandidateAdmission = {
  mode: "shadow" | "enforce";
  evaluate(params: {
    safety: TaskSafetyContext;
    candidate: ModelCandidate;
    effectiveContextTokens: number;
    runtimeId: string;
    attempt: number;
  }): Promise<CandidateAdmissionDecision>;
};
```

接入顺序：

```text
构建候选链
-> 解析候选 runtime/harness
-> Capability Gate
-> 鉴权池可用性与冷却检查
-> 模型调用
```

`shadow` 只记录；`enforce + ineligible` 不调用该候选。全部候选不合格时产生 `NoCapableModelError`，任务转为 `blocked/CAPABLE_MODEL`。能力不足不记为 provider 故障。

解析后通过 `ResolvedAttemptObserver` 记录实际 runtime、auth profile、端点和故障域。第一阶段只观测，不重写现有 auth profile rotation。

## 9. fallback 重放熔断

```ts
type ReplaySafetyDecision =
  | { outcome: "safe" }
  | {
      outcome: "unsafe";
      reason: "COMMITTED_EFFECT" | "INDETERMINATE_EFFECT" | "NONREPLAYABLE_TOOL";
      effectId?: string;
    };

type AttemptReplayGuard = {
  evaluate(params: {
    safety: TaskSafetyContext;
    provider: string;
    model: string;
    attempt: number;
  }): Promise<ReplaySafetyDecision>;
};
```

保留现有 `canFallbackAfterError` 兼容性。受管任务在模型尝试失败后，先读取当前 checkpoint 的 Effect Ledger，再由 Replay Guard 判断。只有 `safe` 才能进入下一候选；`unsafe` 立即转为 `blocked/UNSAFE_RETRY`。

## 10. 工具副作用协议

```ts
type ToolEffectDescriptor = {
  policy: "none" | "idempotent" | "reconcilable" | "nonreplayable";
  buildCanonicalIntent?: (args: unknown) => {
    target: string;
    canonicalIntent: unknown;
  };
  extractReceipt?: (result: unknown) => { remoteReceipt?: string };
  reconcile?: (effect: EffectRecord) => Promise<
    | { status: "committed"; receipt?: string }
    | { status: "not_committed" }
    | { status: "unresolved"; retryable: boolean }
  >;
};
```

执行顺序：

```text
before_tool_call
-> 解析 ToolEffectDescriptor
-> 写 PREPARED
-> 执行工具
-> 提取回执
-> COMMITTED / FAILED / INDETERMINATE
-> after_tool_call
```

规则：

- `none`：不写 effect。
- `idempotent`：只能在稳定幂等键保护下重试。
- `reconcilable`：结果未知时必须先对账。
- `nonreplayable`：开始执行后结果未知即熔断。
- 未声明的写工具、`exec` 和 MCP 默认按 `nonreplayable` 处理。
- 恢复时，超过租约仍为 `PREPARED` 的记录转成 `INDETERMINATE`。
- `idempotencyKey` 有唯一约束；相同 key 与不同 `intentHash` 的组合被拒绝。

正式交付继续使用现有 `delivery_queue_entries` 作为事实源，不在 `effects` 中复制平行发送状态。

## 11. 复核和原子终结

复核必须绑定 checkpoint ID、契约 digest、证据 digest、rubric digest、复核模型/runtime/能力快照和复核决定。复核器独立读取原始证据，不能仅读上一模型的结论。

```ts
type FinalizationRequest = {
  safety: TaskSafetyContext;
  achievedDecisionGrade: "draft" | "analysis" | "decision" | "final";
  evidenceDigest: string;
  deliveryIntentHash: string;
};

type FinalizationResult =
  | { outcome: "created"; finalizationId: string }
  | {
      outcome: "blocked";
      reason:
        | "INCOMPLETE"
        | "REVIEW_REQUIRED"
        | "STALE_REVIEW"
        | "UNSAFE_EFFECT"
        | "INSUFFICIENT_GRADE"
        | "EVIDENCE_INCOMPLETE"
        | "STALE_CHECKPOINT";
    };
```

Core 在同一 SQLite 事务中重读状态与版本、验证 checkpoint/复核/副作用/决策等级/证据，插入 `finalizations`，插入带 `finalization_id` 的现有交付队列记录，将任务改为 `succeeded`，然后提交。任一步失败整体回滚。

`delivery_queue_entries` 增加：

```text
task_id               TEXT
finalization_id       TEXT
idempotency_key_hash  TEXT
intent_hash           TEXT
```

发送 worker 在平台 I/O 前确认 finalization 仍为 ACTIVE、task/checkpoint/intentHash 一致、不存在更新 finalization，且 effect safety 不是 INDETERMINATE。尚未开始发送时可安全使记录失效；已进入发送窗口时必须进入现有 unknown-send reconciliation。

## 12. 结构化终止类型

```text
NoCapableModelError                   -> blocked/CAPABLE_MODEL
UnsafeReplayError                    -> blocked/UNSAFE_RETRY
EffectReconciliationRequiredError    -> blocked/UNSAFE_RETRY
TaskReviewRequiredError              -> blocked/REVIEW
StaleCheckpointError
FinalizationRejectedError
```

禁止通过匹配错误字符串驱动安全状态。

## 13. 错误路由矩阵

| 事件 | 候选处理 | fallback/状态 |
|---|---|---|
| 能力不满足或强制能力未验证 | 跳过 | 检查下一候选；全部不合格则 `blocked/CAPABLE_MODEL` |
| 额度耗尽 | 先走现有 auth rotation | 账号池耗尽后切故障域 |
| 429/rate limit | 冷却当前模型或账号池 | 允许 |
| 401/鉴权失败 | 隔离实际 auth target | 允许切其他账号池或 provider |
| model not found | 隔离精确 provider/model | 允许并持久告警 |
| provider/gateway unavailable | 标记当次故障域 | 跨故障域 |
| 超时且无副作用 | 记录超时 | 允许 |
| 超时且有不确定副作用 | 停止 | `blocked/UNSAFE_RETRY` |
| 已提交副作用但无提交后 checkpoint | 保留现场 | `blocked/UNSAFE_RETRY` |
| 上下文超限 | 重算有效预算 | 仅允许真正满足契约的候选 |
| runtime/harness 不兼容 | 跳过 | 全部不兼容则 `blocked/CAPABLE_MODEL` |
| 数据策略不允许 provider | 调用前跳过 | 无合规候选则 `blocked/CAPABLE_MODEL` |
| 未分类错误 | 先执行 Replay Guard | 无副作用时可切，否则停止 |

同一路由目标以 `provider + model + authProfileRef + runtimeId + endpoint/failureDomain` 判定，不得只用 provider/model 去重。同一 task/checkpoint 内每个真实路由目标默认最多尝试一次；仅当 Replay Guard 确认安全且策略明确允许时才能增加次数。

## 14. 首个影子试点

任务类型固定为 `safe-routing-readonly-shadow`，准入为 `riskClass=low`、`modalities=[text]`、`reviewRequired=false`、`minimumDecisionGrade=draft`、`deliveryMode=none`。

只允许 `read/list/stat/search` 类只读工具，禁止 `exec/write/edit/delete/message/browser-action/mcp-mutation`。

试点：

- 不切换真实模型，不改变候选顺序。
- 不接管主会话，不发送、导出或发布。
- 只计算“候选是否满足、理论上会选谁”。
- 只写 TaskContract、Safety State、最小只读 checkpoint、能力快照和 route attempts。
- 输出内部审计报告；未验证能力显示 `unverified`。

## 15. 能力探针

探针分为：

1. 声明检查：模型目录、配置、provider adapter、runtime/harness。
2. 最小在线探针：简短文本、结构化 JSON、无副作用工具调用、最小输出上限验证。
3. 后续独立探针：图片、长上下文、大输出、渠道对账能力。

一次小请求不能证明长上下文或大输出支持。实际观测与配置冲突时标记 `contradicted`，强制门禁使用较小值。

## 16. 代码落点

预计修改：

```text
src/agents/model-fallback.types.ts
src/agents/model-fallback.ts
src/auto-reply/reply/followup-runner.ts
src/agents/embedded-agent-runner/
src/plugins/hook-types.ts
src/tasks/task-registry.types.ts
src/tasks/task-registry.store.sqlite.ts
src/infra/outbound/delivery-queue-storage.ts
src/infra/outbound/delivery-queue-recovery.ts
src/state/openclaw-state-schema.sql
```

预计新增：

```text
src/agents/model-routing/
  candidate-admission.ts
  capability-snapshot.ts
  route-attempt-observer.ts

src/tasks/safety/
  contracts.ts
  state.ts
  transitions.ts
  checkpoints.ts
  reviews.ts
  finalization.ts

src/agents/tool-effects/
  descriptor.ts
  ledger.ts
  recovery.ts
  replay-guard.ts
```

任务策略插件只调用公开服务，不直接访问 SQLite。

## 17. 完整执行链

```text
受管任务创建
-> 写 TaskContract + 初始 Safety State
-> 创建 checkpoint
-> 构建 fallback 候选
-> Capability Gate
-> 解析 auth/runtime/failure domain
-> 模型执行
-> 工具调用由 Effect Ledger 包裹
-> 失败时 Replay Guard
-> 形成 COMPLETE/PARTIAL
-> 按策略建立独立复核
-> 复核绑定当前 checkpoint
-> Core Finalization Gate
-> 同事务写 finalization + delivery queue
-> delivery worker 二次校验
-> 平台发送
-> 可靠回执或 unknown-send reconciliation
```

## 18. 测试设计

### 18.1 单元测试

- 能力完全满足时通过，任一强制能力未验证时拒绝。
- shadow 只记录，enforce 不调用不合格候选。
- 全部候选不合格产生 `NoCapableModelError`。
- 非法状态组合无法写入，CAS 拒绝迟到结果。
- 审计不泄露鉴权材料，canonical intent 稳定。
- 相同幂等键与不同 intentHash 的组合被拒绝。

### 18.2 fallback 集成测试

使用假 provider A（满足能力但 quota）、B（能力不足）、C（满足能力且成功）。验收 A 只执行一次、B 不发生模型调用、C 成功接手，且 route attempts 顺序与原因完整。

同时覆盖 runtime 不兼容、图片缺失、上下文不足、401 隔离、同故障域、未分类错误和普通会话兼容性。

### 18.3 Effect Ledger 故障注入

覆盖 PREPARED 前崩溃、PREPARED 后但外部调用前崩溃、远端成功但写 COMMITTED 前崩溃、COMMITTED 后但写 checkpoint 前崩溃、对账超时。

核心验收：远端已经成功而本地结果未知时，不会产生第二次相同外部动作。

### 18.4 Finalization 测试

- COMPLETE 但待复核、旧 checkpoint 复核、INDETERMINATE effect、证据不完整或决策等级不足时拒绝。
- finalization 或队列写入失败时两者均不存在。
- 两个 worker 并发时只有一个取得发送资格。
- 平台发送后崩溃时进入 unknown-send reconciliation。
- 旧 finalization 的记录在尚未发送时失效。

## 19. 分阶段实施

### Phase 0：基线与能力快照

固定源码和部署版本，建独立 worktree，核对模型、provider、runtime、鉴权池和端点，输出能力快照，不修改 fallback。

### Phase 1：影子能力门

只创建 `task_contracts`、`task_safety_state`、`task_checkpoints`、`model_capability_snapshots`、`model_route_attempts`。其中 checkpoint 仅记录规范化输入 digest、契约 digest、策略版本和能力快照引用，不启用跨模型续跑。普通任务行为必须零变化，影子判断不得改变候选，且关闭开关必须立即恢复原行为。

### Phase 2：真实文本能力门与可续跑检查点

仅启用只读低风险任务。不合格模型调用次数为零；全链不可用时准确进入 `CAPABLE_MODEL`。在 Phase 1 最小 checkpoint 上增加可移交消息投影、工具结果指针、源指纹、已完成步骤和未完成事项，再启用跨模型续跑。

### Phase 3：Effect Ledger

先接入一个有模拟远端和对账接口的工具。故障注入通过前不接真实外部动作。

### Phase 4：多维状态和独立复核

只有 Core 状态服务可修改 Safety State；旧复核不能批准新 checkpoint；复核器独立读原始证据。

### Phase 5：原子终结与交付

finalization 与现有 delivery queue 同事务写入。未对账副作用、旧检查点、旧复核和旧 finalization 都不能发送当前成果。

### Phase 6：受控模型梯队

只为完成探针和故障域验证的模型建链。先文本低风险，图片链独立验收，高风险任务保持高能力模型和异质复核。

## 20. 部署与回滚

当前已知：

```text
源码检出：2026.7.2 / a1376194
实际运行：2026.7.1-2 / 0790d9f
```

实施前必须确定唯一开发/部署基线，从目标提交建立独立 worktree，不在当前 `wip/subagent-health-v1` 脏分支施工。部署前保存配置和 `state/openclaw.sqlite` 一致性快照，并验证旧二进制对新 schema 的兼容性。

先以 `mode=off` 部署，再仅开放影子任务类型。

回滚：

```text
一级：safeRouting.mode = off
二级：回滚二进制和插件，并在需要时恢复部署前 SQLite 快照
```

数据库迁移只允许新增表、列和索引；试点期不删除、不重写现有任务和交付事实。

## 21. 观测、安全与上线红线

指标至少包括：

```text
candidate_eligible_total
candidate_rejected_total{reason}
shadow_route_difference_total
fallback_stopped_unsafe_total
tasks_waiting_capable_model
effects_indeterminate
finalization_rejected_total{reason}
delivery_reconciliation_unresolved
```

对用户显示“主状态 + 徽标”，例如 `WAITING_REVIEW` 和 `PARTIAL · DEGRADED`。

审计表不保存凭据、OAuth refresh material 或隐藏思维过程。回执和工具结果由所有者声明结构化脱敏。数据策略不允许的 provider 在模型调用前被拒绝。

以下条件全部满足前，不启用真实模型切换：

- 影子判断可重现且证据完整。
- 普通会话和普通任务行为零变化。
- 关闭开关有效。
- 目标分支的定向测试基线干净。
- Windows SQLite 文件锁和测试清理问题已修复或形成确定基线。
- 部署版本、数据库迁移和回滚流程已演练。

## 22. 最终保证

> 模型不可用时，任务可以切换、部分继续或明确阻塞；但不会丢失状态、盲目重放外部动作，也不会把降级产出伪装成正式结论。
