# OpenClaw Safe Routing Phase 0-1 Implementation Plan

> 执行本计划时，使用 `executing-plans` 技能按任务顺序实施，每个任务先写失败测试，再做最小修改。

**目标：** 在不改变任何现有真实模型选择和 fallback 行为的前提下，实现可关闭的文本只读影子路由，并持久化任务契约、最小 checkpoint、能力快照和候选决策证据。

**架构：** Core 提供规范化数据、共享 SQLite 事实源、候选预览和只读观测适配器；`extensions/safe-routing` 驻留在活网关，通过现有 typed hook 被动收集实际模型调用，并通过 gateway method 提供显式 CLI 控制/查询。本阶段不将安全门接入真实 `runWithModelFallback` 执行循环；Phase 2 在复用同一候选评估器的基础上接入 enforce。

**Core 例外边界：** 这是用户已批准的专项 Core 补丁，但 Phase 1 只新增事实存储、租约 CAS、网关内只读适配和窄 SDK；不扩展 `TaskStatus`，不改 live fallback，不改 gateway/protocol/UI，不接 Effect Ledger 或正式交付。每个 Core 文件都必须在提交说明中记录上游冲突面和后续移除条件。

**技术栈：** TypeScript、Node.js SQLite、Kysely、Vitest、OpenClaw Plugin SDK、现有 `resolveModelCandidateChain`。

**设计依据：** `docs/superpowers/specs/2026-07-19-openclaw-safe-routing-design.md`

---

## 1. 实施包分解

| 实施包 | 范围 | 启用条件 |
|---|---|---|
| A | Phase 0-1：基线、契约、最小 checkpoint、能力快照、影子路由 | 本计划详细实施 |
| B | Phase 2：真实候选能力门和可续跑 checkpoint | A 稳定运行一周且影子决策验证通过 |
| C | Phase 3：Effect Ledger 和 Replay Guard | B 的真实只读切换验收通过 |
| D | Phase 4：完整状态门禁和独立复核 | C 的故障注入全部通过 |
| E | Phase 5：原子 finalization 与现有 delivery queue 绑定 | D 的旧 checkpoint/旧复核阻断通过 |
| F | Phase 6：受控文本、图片和高风险模型梯队 | E 的并发、崩溃和对账验收通过 |

实施包 B-F 各自使用独立规范、计划和用户批准，不在本计划中预写未经验证的代码细节。

## 2. 实施基线和分支策略

- 功能开发基线：`origin/main@2e2366b6d394e5e4300642155759a2ab62db7816`，包版本 `2026.7.2`。
- 当前 WIP 集成分支：`wip/subagent-health-v1`，不在其脏工作区中实施 Core 功能。
- 实际运行版本：npm-global `2026.7.1-2 / 0790d9f`；该对象当前不在仓库中，未完成来源和差异审计前不得替换。
- 新分支：`feature/safe-routing-shadow-v1`。
- 新 worktree：`D:\\工作区\\Codex项目\\openclaw-safe-routing-shadow-v1`。
- 规范文档提交 `0d40b0c2` 和修正提交 `0c1dc60c` 在新 worktree 上单独 cherry-pick。
- 设计取证快照为 `a1376194`，仅作事实来源，不作为开发基线；它比 `2e2366b6` 多出的 15 个 subagent-health 提交不进入本分支。

---

### Task 0: 建立干净 worktree 和可信测试基线

**文件：**

- 不修改功能代码。
- 只在新 worktree 中安装依赖、运行测试和保存终端证据。

**Step 1: 验证目标路径不存在**

```powershell
Resolve-Path 'D:\\工作区\\Codex项目' | Select-Object -ExpandProperty Path
Test-Path 'D:\\工作区\\Codex项目\\openclaw-safe-routing-shadow-v1'
```

预期：容器目录解析成功，目标 worktree 路径不存在。如已存在，停止并先查明所有者，不删除或覆盖。

**Step 2: 建立独立 worktree**

```powershell
$sourceRepo = 'D:\\工作区\\Codex项目\\openclaw-core'
$targetWorktree = 'D:\\工作区\\Codex项目\\openclaw-safe-routing-shadow-v1'
$planPath = 'docs/superpowers/plans/2026-07-19-openclaw-safe-routing-phase-0-1-implementation.md'
$planCommit = git -C $sourceRepo log -1 --format=%H -- $planPath
if (-not $planCommit) { throw 'Implementation plan commit was not found' }
git -C $sourceRepo worktree add -b feature/safe-routing-shadow-v1 $targetWorktree 2e2366b6d394e5e4300642155759a2ab62db7816
git -C $targetWorktree cherry-pick 0d40b0c2 0c1dc60c $planCommit
```

**Step 3: 验证工作区身份**

```powershell
git status --short --branch
git rev-parse --show-toplevel
node -p "require('./package.json').version"
```

预期：分支为 `feature/safe-routing-shadow-v1`，包版本为 `2026.7.2`，无功能脏改动。若目标是 npm-global 生产影子试点，先停止并取得 `0790d9f` 的源码/构建来源；在此之前只允许隔离测试网关。

**Step 4: 安装依赖并运行定向基线**

```powershell
pnpm install --frozen-lockfile
pnpm exec vitest run --config test/vitest/vitest.agents-core.config.ts src/agents/model-fallback.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/task-registry.store.test.ts src/tasks/task-executor-policy.test.ts
pnpm exec vitest run --config test/vitest/vitest.infra.config.ts src/infra/outbound/delivery-queue.recovery.test.ts
pnpm db:kysely:check
pnpm lint:kysely
```

每个 Vitest 命令单独顺序执行，不用聚合项目对同一文件重复运行。

**Step 5: 处理基线失败**

如仍复现 `MissingAgentHarnessError`、SQLite `EBUSY/EPERM` 或 teardown 清理失败：

1. 先确认在干净 `origin/main` 基线上可复现。
2. 将修复做成独立前置提交，不与 safe-routing 功能混合。
3. 对 SQLite 测试连续运行三次，确认不是偶然绿。
4. 基线未稳定前不进入 Task 1；若 clean-base 与设计取证快照存在行为差异，记录差异并以 `2e2366b6` 的实测结果为准。

**Step 6: 提交**

如没有基线修复，本任务不产生提交。如有修复，按每个独立根因各产生一个提交，并在后续 safe-routing 提交中不重复该 diff。

---

### Task 1: 实现任务契约、规范化和 digest

**文件：**

- Create: `src/tasks/safety/contracts.ts`
- Create: `src/tasks/safety/contracts.test.ts`
- Reuse: `src/agents/stable-stringify.ts`
- Reuse: `src/infra/crypto-digest.ts` 的 `sha256Hex`

**Step 1: 写失败测试**

测试以下行为：

- 完整契约规范化后字段顺序稳定。
- 同义输入产生相同 digest。
- modality、decision grade、risk class、delivery mode 和 data policy 的非法值被拒绝。
- `minContextWindowTokens` 和 `minOutputTokens` 必须是正整数。
- `runtimeIds` 和 modalities 去重、排序并且不保存空字符串。
- digest 不包含运行时、创建时间或随机值。

**Step 2: 运行测试确认失败**

```powershell
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/contracts.test.ts
```

预期：因模块尚未存在或导出缺失而失败。

**Step 3: 实现最小契约模块**

导出：

```ts
TaskCapabilityRequirements
PersistedTaskContract
NormalizedTaskContract
normalizeTaskContract(input)
digestTaskContract(contract)
```

使用现有 `stableStringify` 和 `sha256Hex`，digest 格式固定为 `sha256:<64 lowercase hex>`。不增加通用 schema 框架或可配置抽象。

**Step 4: 运行测试**

```powershell
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/contracts.test.ts
pnpm check
```

**Step 5: 提交**

```powershell
git add -- src/tasks/safety/contracts.ts src/tasks/safety/contracts.test.ts
git diff --cached --check
git commit -m "feat(tasks): define safe routing task contracts"
```

---

### Task 2: 接入网关内只读观测租约和 typed hook 关联

**文件：**

- Create: `src/tasks/safety/observation-lease.ts`
- Create: `src/tasks/safety/observation-lease.test.ts`
- Create: `src/agents/model-routing/observed-attempt.ts`
- Create: `src/agents/model-routing/observed-attempt.test.ts`
- Reuse without modification: `src/plugins/hook-types.ts`
- Reuse without modification: `src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.ts`

**Step 1: 写失败测试**

- 观测租约只能由 gateway method 创建，拥有短 TTL、单次消费和 contract/config digest 绑定。
- 普通会话没有租约时，`model_call_started` / `model_call_ended` 只经过现有空检查，不写安全路由事实。
- 活网关收到匹配的 `model_call_started` 后，以 CAS 绑定首个 `runId/callId`；并发调用不能抢占。
- started/ended 缺配对、进程中断、租约过期或配置指纹变化时，观测为 `partial`，不得进入一致率分母。
- 事件中没有证据的 auth profile、runtime、endpoint、cooldown 和 failure domain 均为 `unverified`。
- 观测处理不得调用 `resolveAuthProfileOrder`，不得清理或改变 cooldown/order，也不得改变模型选择。

**Step 2: 实现最小关联器**

实现只读数据结构：

```ts
ObservationLease
ObservedModelAttempt
createObservationLease(...)
consumeObservationLease(...)
correlateModelCallEvent(...)
```

租约绑定只保存 `sha256(taskId + sessionKey)` 任务域 hash，不保存原始 session key。事件字段沿用现有 typed hook 已提供的 `runId`、`callId`、provider、model、api、transport 和 context window 事实。

**Step 3: 运行定向测试**

```powershell
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/observation-lease.test.ts
pnpm exec vitest run --config test/vitest/vitest.agents-core.config.ts src/agents/model-routing/observed-attempt.test.ts
pnpm exec vitest run --config test/vitest/vitest.plugins.config.ts src/plugins/wired-hooks-llm.test.ts
```

**Step 4: 提交**

```powershell
git add -- src/tasks/safety/observation-lease.ts src/tasks/safety/observation-lease.test.ts src/agents/model-routing/observed-attempt.ts src/agents/model-routing/observed-attempt.test.ts
git diff --cached --check
git commit -m "feat(safe-routing): correlate gateway model observations"
```

---

### Task 3: 建立 Phase 1 SQLite 事实表和原子创建事务

**文件：**

- Modify: `src/state/openclaw-state-schema.sql`
- Regenerate: `src/state/openclaw-state-schema.generated.ts`
- Regenerate: `src/state/openclaw-state-db.generated.d.ts`
- Create: `src/tasks/safety/store.types.ts`
- Create: `src/tasks/safety/store.sqlite.ts`
- Create: `src/tasks/safety/store.sqlite.test.ts`
- Modify: `src/tasks/task-registry.store.types.ts`
- Modify: `src/tasks/task-registry.store.sqlite.ts`
- Modify: `src/tasks/task-registry.ts`
- Modify tests: `src/tasks/task-registry.store.sqlite.test.ts`

**Step 1: 写失败测试**

- 新建影子任务时，`task_runs`、`task_contracts` 和首个最小 checkpoint 在同一事务提交。
- 任一 insert 失败时三类记录全部回滚；内存 registry 也不得出现幽灵任务。
- 相同 `(task_id, sequence)` checkpoint 不能重复。
- observation lease 的 TTL、单次消费和 `bound_run_id/bound_call_id` 使用 checkpoint row version CAS，迟到或并发绑定必须失败。
- capability snapshot 按 digest 复用，但已经引用的 snapshot 不原地改写。
- route attempt 必须引用存在的 task、checkpoint 和 snapshot。
- 旧任务不自动补写安全表；只有显式创建的影子任务进入新链路。

**Step 2: 增加最小 additive schema**

新增表：

```text
task_contracts
  task_id PK/FK task_runs
  schema_version, contract_json, contract_digest
  risk_class, review_required, delivery_mode
  routing_policy_version, created_at, updated_at

task_checkpoints
  checkpoint_id PK
  task_id FK task_runs, sequence
  contract_digest, input_digest, routing_policy_version
  capability_snapshot_ids_json, manifest_json
  observation_lease_id, lease_expires_at, lease_state
  bound_run_id, bound_call_id, row_version
  created_at
  UNIQUE(task_id, sequence)

model_capability_snapshots
  snapshot_id PK
  provider, model, runtime_id NULLABLE
  verification_status, capabilities_json, evidence_json
  snapshot_digest UNIQUE, created_at, expires_at

model_route_attempts
  attempt_id PK
  task_id FK, checkpoint_id FK
  ordinal, provider, model, runtime_id NULLABLE
  run_id NULLABLE, call_id NULLABLE
  capability_snapshot_id FK
  evaluation_mode, eligibility
  rejection_code, rejection_reason, would_select
  auth_profile_ref NULLABLE, endpoint_id NULLABLE
  failure_domain_json, observation_completeness, created_at
```

为 `(task_id, checkpoint_id, ordinal)`、`(provider, model, created_at)` 和观测关联查询建立必要索引。Phase 1 不建立 `task_safety_state`、`effects`、`finalizations`、`delivery_outbox`，避免先造空壳状态和事务。

**Step 3: 生成 Kysely 类型并检查漂移**

```powershell
pnpm db:kysely:gen
pnpm db:kysely:check
pnpm lint:kysely
```

**Step 4: 实现单一 Core store 入口**

实现：

```ts
createManagedTaskWithCheckpoint(...)
getTaskContract(taskId)
putCapabilitySnapshot(...)
appendRouteAttempts(...)
listRouteAttempts(taskId, checkpointId)
```

插件不得直接获取 Kysely handle。`createManagedTaskWithCheckpoint` 复用 task registry 的数据库事务；只有事务成功后才更新内存 registry。Phase 1 不扩展 `TaskStatus`、gateway/protocol/UI 映射或状态转换服务。

**Step 5: 运行定向测试并做 Windows 稳定性验证**

```powershell
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/store.sqlite.test.ts src/tasks/task-registry.store.sqlite.test.ts src/tasks/task-registry.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/store.sqlite.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/store.sqlite.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/store.sqlite.test.ts
pnpm db:kysely:check
pnpm lint:kysely
```

SQLite 定向测试必须连续三次通过；出现 `EBUSY/EPERM` 时先修复资源释放和测试隔离，不把重跑成功当成稳定通过。

**Step 6: 提交**

```powershell
git add -- src/state/openclaw-state-schema.sql src/state/openclaw-state-schema.generated.ts src/state/openclaw-state-db.generated.d.ts src/tasks/safety/store.types.ts src/tasks/safety/store.sqlite.ts src/tasks/safety/store.sqlite.test.ts src/tasks/task-registry.store.types.ts src/tasks/task-registry.store.sqlite.ts src/tasks/task-registry.ts src/tasks/task-registry.store.sqlite.test.ts
git diff --cached --check
git commit -m "feat(state): persist safe routing shadow facts"
```

---

### Task 4: 生成不可变能力快照并执行候选准入判断

**文件：**

- Create: `src/agents/model-routing/capability-snapshot.ts`
- Create: `src/agents/model-routing/capability-snapshot.test.ts`
- Create: `src/agents/model-routing/candidate-admission.ts`
- Create: `src/agents/model-routing/candidate-admission.test.ts`
- Reuse: `src/config/types.models.ts`
- Reuse without modification: `src/agents/model-fallback.ts`

**Step 1: 写失败测试**

- 配置声明、运行时上限和观测证据汇总为一个 immutable snapshot。
- 静态 context window/output limit 取已知约束中的最小值，不取最乐观值；不读取动态累计 token usage。
- 配置与观测冲突时标记 `contradicted`，并采用更保守值。
- 未经探针证明的 structured output、tool calling、runtime 或 modality 标记 `unverified`。
- 契约要求的字段为 unknown/unverified/contradicted 且不能证明满足时，候选被拒绝。
- `dataPolicy=approved-providers` 时，不在 allowlist 的 provider 被拒绝。
- snapshot digest 对相同事实稳定，证据或约束变化时 digest 改变。
- `decisionGrade` 不伪装成模型固有参数；由本地授权策略计算并写入快照证据。

**Step 2: 实现最小能力数据结构**

```ts
CapabilityValue<T> = {
  value?: T;
  verification: "configured" | "observed" | "unverified" | "contradicted";
  evidence: CapabilityEvidence[];
}

ModelCapabilitySnapshot
CandidateAdmissionDecision
buildCapabilitySnapshot(...)
evaluateCandidateAdmission(contract, snapshot, policy)
```

Phase 1 首批只支持 `text`、`image` 两种 modality；`audio` 契约可以被解析，但没有已验证候选时必须拒绝。不要把 provider 名称或“同档模型”当作能力证据。

Phase 1 admission 只返回静态窗口、模态、工具、结构化输出和数据策略判断；不填充 `resolvedRuntimeId`、auth target 或 failure domain，相关字段必须显式为 `unverified`。这些字段的真实解析属于 Phase 2 live loop observer。

**Step 3: 运行定向测试**

```powershell
pnpm exec vitest run --config test/vitest/vitest.agents-core.config.ts src/agents/model-routing/capability-snapshot.test.ts src/agents/model-routing/candidate-admission.test.ts
pnpm check
```

**Step 4: 提交**

```powershell
git add -- src/agents/model-routing/capability-snapshot.ts src/agents/model-routing/capability-snapshot.test.ts src/agents/model-routing/candidate-admission.ts src/agents/model-routing/candidate-admission.test.ts
git diff --cached --check
git commit -m "feat(agents): evaluate model capability snapshots"
```

---

### Task 5: 在活网关内评估理论准入并写入模型级审计

**文件：**

- Create: `src/agents/model-routing/shadow-evaluator.ts`
- Create: `src/agents/model-routing/shadow-evaluator.test.ts`
- Create: `src/agents/model-routing/route-attempt-observer.ts`
- Create: `src/tasks/safety/service.ts`
- Create: `src/tasks/safety/service.test.ts`
- Reuse without modification: `src/agents/model-fallback.ts`
- Reuse without modification: `src/plugins/hook-types.ts`

**Step 1: 写失败测试**

构造 A/B/C 候选：A 是当前真实选择，B 能力不足，C 理论上满足。验证：

- 活网关当前真实调用仍是 A；理论评估只报告 C，不改变候选顺序或执行。
- evaluator 使用活网关当前进程的 plugin registry、环境和配置；独立进程的 registry 结果不能冒充 live 真值。
- evaluator 不调用模型、工具、`resolveAuthProfileOrder` 或任何 provider health mutation。
- B 的每个拒绝理由有机器码和可读证据；静态 context window 不读取动态累计 token usage。
- `model_call_started` / `model_call_ended` 事件能关联到租约、task/checkpoint 和 route attempt；缺配对时标记 `partial`。
- auth profile、runtime、endpoint、cooldown 和 failure domain 没有事件证据时标为 `unverified`。
- 同一模型级 `(provider, model)` 在同一 task/checkpoint 默认只记一次；完整 route-target 去重和一次尝试限制推迟 Phase 2。
- 批量写 route attempts 失败时，不留下半条候选链。

**Step 2: 实现网关内纯评估器和观测适配器**

复用现有导出的 `resolveModelCandidateChain` 构建当前模型级候选顺序，但只在活网关服务中调用。新增：

```ts
evaluateShadowRoute({ contract, candidates, snapshots, policy })
recordObservedModelAttempt(...)
```

返回理论选择、候选准入决定、拒绝原因、观测完整性和 policy version。`model-fallback.ts` 不因复用该导出而修改；不要捕获 live fallback 异常、替换候选链或自行调用会改变冷却状态的解析器。

**Step 3: 实现 Core 安全服务和 gateway method 适配**

`service.ts` 组合 TaskContract、当前进程 resolver、shadow evaluator、观测租约和 store，只暴露窄口径的创建租约、评估和审计查询。普通任务没有租约时只经过 hook 空检查，不写事实。插件不得直接获取 Kysely handle，也不得在 CLI 进程复制路由逻辑。

**Step 4: 运行测试**

```powershell
pnpm exec vitest run --config test/vitest/vitest.agents-core.config.ts src/agents/model-routing/shadow-evaluator.test.ts src/agents/model-routing/observed-attempt.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/service.test.ts
pnpm exec vitest run --config test/vitest/vitest.plugins.config.ts src/plugins/wired-hooks-llm.test.ts
pnpm check
```

**Step 5: 提交**

```powershell
git add -- src/agents/model-routing/shadow-evaluator.ts src/agents/model-routing/shadow-evaluator.test.ts src/agents/model-routing/route-attempt-observer.ts src/tasks/safety/service.ts src/tasks/safety/service.test.ts
git diff --cached --check
git commit -m "feat(agents): add gateway shadow route observation"
```

---

### Task 6: 通过 Plugin SDK 暴露窄口径影子服务

**文件：**

- Create: `packages/plugin-sdk/src/safe-routing.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Regenerate: `docs/.generated/plugin-sdk-api-baseline.json`
- Regenerate: `docs/.generated/plugin-sdk-api-baseline.jsonl`
- Regenerate: `docs/.generated/plugin-sdk-api-baseline.sha256`
- Modify: Core plugin runtime service adapter files discovered during implementation
- Create/Modify: corresponding Plugin SDK and runtime adapter tests

**Step 1: 先定位现有服务注入模式**

```powershell
rg -n "registerCli|plugin-sdk|services:" packages/plugin-sdk src extensions -g "*.ts"
```

沿用现有命名、生命周期和错误边界，不创建第二套插件容器。

**Step 2: 写失败测试**

插件侧只能调用活网关提供的窄口径服务：

```ts
createShadowObservationLease(contract, sessionKey)
evaluateShadowRouteInGateway(leaseId)
getShadowAudit(taskId)
```

验证：

- SDK 不暴露数据库 handle、任意 SQL、任意状态写入或 enforce API。
- `createShadowObservationLease` 强制 `deliveryMode=none`，创建首个最小 checkpoint，并设置短 TTL/单次消费。
- 非受管 task id、损坏契约或不存在 checkpoint 返回稳定错误码。
- gateway method 必须在活网关进程执行；CLI 进程不得自行加载 registry、auth store 或 provider health。
- 返回值不含 provider token、base URL credentials、会话正文或隐藏推理。
- API baseline 能检测意外导出扩大。

**Step 3: 实现适配层**

Runtime adapter 只转发到 Task 5 的 Core service。插件进程不得自行重新解析配置或复制路由逻辑；Phase 1 不暴露 enforce 或状态转换 API。

**Step 4: 更新并核对 SDK API baseline**

```powershell
pnpm plugin-sdk:api:gen
pnpm plugin-sdk:api:check
pnpm check:architecture
pnpm check
```

检查生成 diff，只接受与 `safe-routing` 三个只读方法和相关类型直接对应的变化。

**Step 5: 提交**

```powershell
git status --short
git add -- packages/plugin-sdk/src/safe-routing.ts packages/plugin-sdk/src/index.ts docs/.generated/plugin-sdk-api-baseline.json docs/.generated/plugin-sdk-api-baseline.jsonl docs/.generated/plugin-sdk-api-baseline.sha256
```

再把 Step 1 定位到的 runtime adapter 和对应测试逐个用完整路径加入，不得使用 `git add src`、`git add packages/plugin-sdk` 或其他目录级 pathspec。然后检查并提交：

```powershell
git diff --cached --name-only
git diff --cached --check
git commit -m "feat(plugin-sdk): expose safe routing shadow service"
```

---

### Task 7: 新增显式、默认关闭的 safe-routing 扩展 CLI

**文件：**

- Create: `extensions/safe-routing/openclaw.plugin.json`
- Create: `extensions/safe-routing/package.json`
- Create: `extensions/safe-routing/index.ts`
- Create: `extensions/safe-routing/src/config.ts`
- Create: `extensions/safe-routing/src/config.test.ts`
- Create: `extensions/safe-routing/src/cli.ts`
- Create: `extensions/safe-routing/src/cli.test.ts`
- Create: `extensions/safe-routing/README.md`
- Modify only if required by workspace package discovery: `pnpm-lock.yaml`

**Step 1: 确保 sparse checkout 包含新扩展路径**

```powershell
git sparse-checkout add extensions/safe-routing
```

如果当前 worktree 不是 sparse checkout，则跳过；不要因此扩大到全部现有 extensions。

**Step 2: 写失败测试**

- 配置只接受 `mode: off | shadow`；Phase 1 不暴露 `enforce`。
- 默认 `mode=off`、`allowedTaskKinds=[]`，因此安装本身不接管任何任务。
- `approvedProviders` 缺失或 `allowedTaskKinds` 不含固定的 `safe-routing-readonly-shadow` 时拒绝运行。
- `mode=off` 不创建 task、checkpoint、snapshot 或 route attempt。
- CLI 输出 JSON 稳定、可审计，不输出密钥、会话正文或 provider 私有配置。
- 扩展只注册 gateway method 和显式 CLI，不注册模型 tool，不监听普通聊天，不修改全局 fallback。

**Step 3: 实现扩展清单和配置 schema**

Phase 1 最小配置：

```ts
{
  mode: "off" | "shadow";
  allowedTaskKinds: string[];
  approvedProviders: string[];
}
```

不增加自定义排序权重、故障重试次数或角色梯队配置；这些要等探针证据和 enforce 阶段再定。

**Step 4: 实现显式 CLI**

命令：

```powershell
openclaw safe-routing shadow --contract <path> --session <session-key> --json
```

行为：

1. 读取并校验契约文件，确认 `deliveryMode=none`。
2. Phase 1 只接受固定 task kind `safe-routing-readonly-shadow`，且配置 allowlist 必须显式包含它。
3. 通过认证 gateway method 在活网关创建短 TTL、单次消费的 observation lease 和最小 checkpoint。
4. 由活网关读取当前进程 registry/config、执行理论评估，并在下一次匹配的 model-call hook 上关联实际调用。
5. CLI 只查询并输出 `taskId`、current selection、theoretical selection、rejections、observation completeness、snapshot verification status 和 policy version。

命令本身不得发起模型请求、工具调用、消息发送、导出或发布；它也不得在 CLI 进程内重新解析 auth order、cooldown 或 provider health。

**Step 5: 运行扩展测试**

```powershell
pnpm exec vitest run --config test/vitest/vitest.plugins.config.ts extensions/safe-routing/src/config.test.ts extensions/safe-routing/src/cli.test.ts
pnpm plugin-sdk:api:check
pnpm check:architecture
pnpm check
```

**Step 6: 提交**

```powershell
git add -- extensions/safe-routing/openclaw.plugin.json extensions/safe-routing/package.json extensions/safe-routing/index.ts extensions/safe-routing/src/config.ts extensions/safe-routing/src/config.test.ts extensions/safe-routing/src/cli.ts extensions/safe-routing/src/cli.test.ts extensions/safe-routing/README.md
git diff --cached --check
git commit -m "feat(safe-routing): add explicit shadow routing CLI"
```

只有 package discovery 确实改变 lockfile 且 diff 仅涉及本扩展时，才单独显式加入 `pnpm-lock.yaml`。

---

### Task 8: 完成 Phase 1 端到端验收和审计说明

**文件：**

- Create: `src/agents/model-routing/shadow-evaluator.integration.test.ts`
- Create/Modify: `extensions/safe-routing/src/cli.integration.test.ts`
- Modify: `extensions/safe-routing/README.md`
- Modify: this implementation plan only to record verified deviations, if any

**Step 1: 写端到端测试场景**

使用临时 SQLite、假模型目录和可控的 gateway hook harness，覆盖：

1. 当前主模型 A 仍被真实路由选中。
2. A 的快照不满足契约，B 满足；影子审计报告理论选择 B，但真实路由不变。
3. 所有候选能力不足；报告 `CAPABLE_MODEL` 派生建议，影子任务仍按现有生命周期结束，不写 `blocked`。
4. provider 未获数据策略批准；候选被拒绝。
5. 活网关 registry/config 与离线 CLI 进程不同；CLI 结果仍以网关事实为准，离线 what-if 标记 live 字段 `unverified`。
6. 同一模型级 `(provider, model)` 在同一 lease/checkpoint 默认只产生一次 observation；完整 route-target 去重留到 Phase 2。
7. CLI 重复读取审计不产生新 route attempts。
8. `mode=off` 全程零写入，普通会话只经过 hook 空检查。

**Step 2: 执行定向回归**

```powershell
pnpm exec vitest run --config test/vitest/vitest.agents-core.config.ts src/agents/model-routing/capability-snapshot.test.ts src/agents/model-routing/candidate-admission.test.ts src/agents/model-routing/shadow-evaluator.test.ts src/agents/model-routing/shadow-evaluator.integration.test.ts src/agents/model-fallback.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/contracts.test.ts src/tasks/safety/observation-lease.test.ts src/tasks/safety/store.sqlite.test.ts src/tasks/safety/service.test.ts src/tasks/task-registry.store.sqlite.test.ts src/tasks/task-registry.test.ts
pnpm exec vitest run --config test/vitest/vitest.plugins.config.ts extensions/safe-routing/src/config.test.ts extensions/safe-routing/src/cli.test.ts extensions/safe-routing/src/cli.integration.test.ts
```

**Step 3: 执行仓库门禁**

```powershell
pnpm check
pnpm check:architecture
pnpm db:kysely:check
pnpm lint:kysely
pnpm plugin-sdk:api:check
pnpm test:fast
```

如果 `pnpm test:fast` 有与本分支无关的基线失败，保存完整命令、失败用例和 clean-base 对照；不得将其描述为通过。所有本次新增或修改覆盖到的定向测试必须通过。

**Step 4: 做行为不变证明**

用测试和 diff 同时确认：

- `runWithModelFallback` 的 live candidate selection、重试和异常行为没有变化。
- `openclaw.json` 的 primary/fallback 配置未变。
- 普通会话只经过 safe-routing hook 的空检查，不创建租约、不写事实、不改变候选或交付。
- 扩展默认关闭；只在显式 CLI + allowlist 条件下写 shadow facts。
- 数据库新增内容只有规范化契约、hash、能力/策略证据和路由审计，不含隐藏思维过程或会话正文。

**Step 5: 更新 README 中的运行与回滚说明**

列出：启用前备份、显式影子命令、审计查询、`mode=off` 回滚、已知 `unverified` 能力和 Phase 1 禁区。

**Step 6: 提交**

```powershell
git add -- src/agents/model-routing/shadow-evaluator.integration.test.ts extensions/safe-routing/src/cli.integration.test.ts extensions/safe-routing/README.md
git diff --cached --check
git commit -m "test(safe-routing): verify phase 1 shadow routing"
```

---

## Phase 1 启用、观察与回滚

### 启用前

1. 记录构建 commit、OpenClaw 实际版本、配置文件 hash、共享 SQLite 路径和受影响 agent 的 `openclaw-agent.sqlite` 路径。
2. 在隔离测试网关复制相关 SQLite 文件及其 `-wal/-shm`（如存在）到带时间戳备份目录，再启动服务。
3. 因 `0790d9f` 当前无法解析，Phase 1 不替换 npm-global 生产二进制；生产试点须先完成来源/差异审计并另行批准。
4. 首次启动保持 `mode=off`，确认普通会话、现有 fallback 和 task registry 回归正常。
5. 只把 `safe-routing-readonly-shadow` 加入 allowlist，并配置已批准 provider 列表。

### 小范围影子试点

首批输入只允许低风险、无工具、无外部发送的文本契约。每个试点都保留：

- contract digest、input digest、checkpoint id；
- 当前链与理论链；
- 每个候选能力快照、验证状态和拒绝原因；
- routing policy version；
- CLI 输出和对应数据库审计行。

Phase 1 不以“理论选择更好”为成功标准，而以以下硬指标验收：

- live 路由零变化；
- shadow 事实完整且可复现；
- 能力未知时拒绝而非猜测；
- `mode=off` 零写入；
- SQLite 事务、观测租约 CAS 和 typed hook 关联测试稳定；
- 审计中无凭据、会话正文和隐藏思维过程。

### 回滚

1. 将扩展设为 `mode=off` 或移除扩展启用项。
2. 不删除 additive 数据表，不在运行中降级 schema；保留审计事实供复盘。
3. 如果代码回滚到不认识新表的旧版本，旧版本应忽略 Phase 1 additive tables；先用备份副本验证再切换。
4. 因 Phase 1 没有接管 live fallback，回滚不涉及恢复模型梯队或重放任务。

---

## 完成定义

Phase 0-1 只有在以下证据同时具备时才算完成：

- clean `origin/main` 基线及已知失败有可复现记录；
- TaskContract 可规范化、可 hash、非法能力要求会被拒绝；
- 影子任务的 contract/checkpoint 创建具备原子性；
- 观测租约和首个 run/call 关联使用 CAS 防迟到/并发覆盖；
- 能力快照区分 configured、observed、unverified、contradicted；
- 影子评估只在活网关读取当前 registry/config，不调用 live fallback，不改变真实候选选择；
- 插件只获得窄口径 Core 服务，没有数据库直通；
- 扩展默认 `off`，Phase 1 不存在 `enforce` 配置；
- 所有新增定向测试通过，SQLite 定向测试连续三次通过，partial 观测不进入一致率分母；
- `pnpm check`、架构、Kysely 和 Plugin SDK 门禁通过，或有 clean-base 对照证明的存量失败记录；
- 没有扩充文本或图片 fallback 链，没有接管普通会话，没有正式交付能力。

完成后才进入 Phase 2：接入真实候选调度的 enforce 开关、故障分类和 provider quarantine；在此之前不实施副作用账本，更不开放正式交付。

---

## 后续阶段入口门槛

- **Phase 2（enforce 路由 + 可恢复 checkpoint）：** 至少完成一组经探针验证的低风险文本候选；shadow 与人工判定一致率、拒绝原因准确率达到预定门槛；live path 有一键关闭和对照测试。
- **Phase 3（Effect Ledger）：** 先接模拟或可查询回执的低风险工具；证明 `PREPARED → INDETERMINATE` 后不会自动重放。
- **Phase 4（完整状态门禁与独立复核）：** 复核必须绑定当前 checkpoint、契约和证据 digest；复核代理独立读取原始证据。
- **Phase 5（原子终结与交付）：** `effects` 对账、checkpoint 绑定复核、finalization 和现有 delivery queue 必须作为一个整体设计和验收。
- **Phase 6（角色梯队）：** 只纳入能力、鉴权、额度池和故障域均经过探针验证的候选；图片链和高风险任务单独启用。
