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

**已核实的基线豁免清单（2026-07-22，`feature/safe-routing-shadow-v1` 首次执行 Task 0 时确认）**

在零功能代码改动的干净 `2e2366b6` 基线上，以下三类失败已确认与 safe-routing 无关、连续验证 2-3 次结果一致（非偶发）：

1. `src/agents/model-fallback.test.ts` › `runWithModelFallback` › `lets configured CLI runtimes bypass stale provider auth cooldowns` — `MissingAgentHarnessError: Requested agent harness "claude-cli" is not registered.`。该用例依赖的 harness 注册/发现机制在此环境未生效；根因未完全查明，可能是缺少显式 `registerAgentHarness` 调用，也可能依赖真实外部 `claude` CLI 二进制。
2. `src/tasks/task-registry.store.test.ts` › `task-registry store runtime` 下这 7 个用例：`rejects corrupt persisted task rows during sqlite restore`、`drops invalid requester origins during sqlite restore`、`persists executor and requester agent ids in sqlite task rows`、`persists requester origin atomically when creating sqlite tasks`、`prunes stale sqlite delivery state while retaining current rows`、`prunes large sqlite snapshots without binding every task id at once`、`reopens after the shared state database is closed`——均为 `EBUSY: resource busy or locked, unlink '...openclaw.sqlite(-wal)'`。
3. `src/infra/outbound/delivery-queue.recovery.test.ts` 套件级失败（39/39 单测断言全部通过，只有 `afterAll` 清理阶段失败）：`EPERM, Permission denied: ...openclaw-dq-suite-<random>`，来自 `delivery-queue.test-helpers.ts` 的 `installDeliveryQueueTmpDirHooks()`。已实测在其 `fs.rmSync` 加 `maxRetries`/`retryDelay` 不能解决——连续 3 次仍 100% 复现同一报错，说明根因更可能是某个资源句柄（例如 `openOpenClawStateDatabase` 打开的连接）在清理前未释放，而非纯瞬时 OS 锁；未定位到确切持有者。

以上三项是**目前唯一**获得豁免的基线失败。一次基线运行只有在失败集合与上述三项逐条一致（相同文件、相同用例名、相同错误类型）时才算"稳定"，可以进入 Task 1。出现任何额外失败、或上述某一项的错误类型/失败用例范围发生变化，均不在本次豁免范围内，必须重新按上面 1-4 步处理（确认可复现→尝试独立修复→连续三次验证→未修复不进 Task 1），不能默认套用本条豁免。三项根因都在 safe-routing 之外的共享测试基础设施里（agent harness 注册机制、SQLite/文件句柄生命周期），不在本计划范围内修复；如后续要修，应作为完全独立于 safe-routing 的工作，不占用 Task 0-8 的任何提交。

**Step 6: 提交**

如没有基线修复，本任务不产生功能代码提交。如有修复，按每个独立根因各产生一个提交，并在后续 safe-routing 提交中不重复该 diff。若只是把上面"已核实的基线豁免清单"写入本计划文档（未修复任何代码），作为一次独立的 `docs:` 提交记录豁免范围，同样不与后续 safe-routing 功能提交混合。

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

本任务只实现可注入 store 的租约/关联领域逻辑，不在此任务直接依赖 SQLite 或 gateway method。Task 3 接入持久化，Task 5/6 接入活网关和鉴权；在这些任务完成前，不宣称端到端观测已经成立。

**Step 1: 写失败测试**

- 观测租约只能由经过鉴权的 gateway method 创建，拥有短 TTL、单次消费和 contract/config/plugin-registry/candidate-chain digest 绑定。
- 普通会话没有租约时，`model_call_started` / `model_call_ended` 只经过现有空检查，不写安全路由事实。
- 活网关收到匹配的 `model_call_started` 后，以 CAS 绑定首个 `runId/callId`；并发调用不能抢占。
- Phase 1 只统计经过 embedded-agent model diagnostic dispatch 的调用；没有该 typed hook 覆盖的通用 `runWithModelFallback` 调用标记 `observationCoverage=out-of-scope`，不进入分母。
- started/ended 缺配对、进程中断、租约过期或任一快照 digest 变化时，观测为 `partial`；observer 异步写入失败标记 `unavailable`；二者均不得进入一致率分母。
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

租约接口接收服务端可解析的 `sessionRef`，不接收原始 session key。gateway 必须验证调用者拥有该 session，或具备显式 `operator.write`（`operator.admin` 按 `src/gateway/method-scopes.ts` 的 `authorizeOperatorScopesForRequiredScope` 既有规则始终隐含满足，不必单独解释），再签发一次性 lease token；共享库只保存 session binding digest 和 token digest。调用者身份必须来自网关连接层已认证的上下文，不得由调用者自己传入的 `sessionRef` 自证（具体形态见 Task 6 Step 2 的 `callerScope`）。事件字段沿用现有 typed hook 已提供的 `runId`、`callId`、provider、model、api、transport 和 context window 事实。

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
- Modify tests: `src/tasks/task-registry.store.test.ts`

**Step 1: 写失败测试**

- 新建影子任务时，`task_runs`、`task_contracts` 和首个最小 checkpoint 在同一事务提交。
- 任一 insert 失败时三类记录全部回滚；内存 registry 也不得出现幽灵任务。
- 相同 `(task_id, sequence)` checkpoint 不能重复。
- observation lease 的 `bound_run_id/bound_call_id` 绑定和 `token_consumed_at` 单次消费标记各自使用 checkpoint `row_version` CAS 独立保护，迟到或并发的绑定/消费尝试必须失败；两者是独立事实，消费 token 不得使 lease 提前失去被后续真实调用绑定的资格（TTL 内仍可绑定）。
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
  config_digest, plugin_registry_digest, candidate_chain_digest
  capability_snapshot_ids_json, manifest_json
  observation_lease_id, lease_expires_at, lease_state
  session_binding_digest, lease_token_digest, token_consumed_at
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
  failure_domain_json, observation_completeness, observation_coverage
  observer_error_code, created_at
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
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/store.sqlite.test.ts src/tasks/task-registry.store.test.ts src/tasks/task-registry.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/store.sqlite.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/store.sqlite.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/store.sqlite.test.ts
pnpm db:kysely:check
pnpm lint:kysely
```

SQLite 定向测试必须连续三次通过；出现 `EBUSY/EPERM` 时先修复资源释放和测试隔离，不把重跑成功当成稳定通过。

**Step 6: 提交**

```powershell
git add -- src/state/openclaw-state-schema.sql src/state/openclaw-state-schema.generated.ts src/state/openclaw-state-db.generated.d.ts src/tasks/safety/store.types.ts src/tasks/safety/store.sqlite.ts src/tasks/safety/store.sqlite.test.ts src/tasks/task-registry.store.types.ts src/tasks/task-registry.store.sqlite.ts src/tasks/task-registry.ts src/tasks/task-registry.store.test.ts
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
- Create: `src/agents/model-routing/route-attempt-observer.test.ts`
- Create: `src/tasks/safety/service.ts`
- Create: `src/tasks/safety/service.test.ts`
- Reuse without modification: `src/agents/model-fallback.ts`
- Reuse without modification: `src/plugins/hook-types.ts`

**Step 1: 写失败测试**

构造 A/B/C 候选：A 是当前真实选择，B 能力不足，C 理论上满足。验证：

- 活网关当前真实调用仍是 A；理论评估只报告 C，不改变候选顺序或执行。
- evaluator 使用活网关当前进程的 plugin registry、环境和配置；独立进程的 registry 结果不能冒充 live 真值。
- lease、evaluator 和首个 hook 关联必须绑定同一 config/plugin-registry/candidate-chain digest；任一变化标记 `partial`，不得进入一致率分母。
- evaluator 不调用模型、工具、`resolveAuthProfileOrder` 或任何 provider health mutation。
- B 的每个拒绝理由有机器码和可读证据；静态 context window 不读取动态累计 token usage。
- `model_call_started` / `model_call_ended` 事件能关联到租约、task/checkpoint 和 route attempt；缺配对时标记 `partial`，observer 写入失败标记 `unavailable`，未经过 hook dispatch 的调用标记 `out-of-scope`。
- auth profile、runtime、endpoint、cooldown 和 failure domain 没有事件证据时标为 `unverified`。
- 同一模型级 `(provider, model)` 在同一 task/checkpoint 默认只记一次；完整 route-target 去重和一次尝试限制推迟 Phase 2。
- 批量写 route attempts 失败时，不留下半条候选链。
- `route-attempt-observer.ts` 是独立的适配层，其 fire-and-forget 行为不被 `shadow-evaluator.test.ts`（纯评估逻辑）或 Task 2 `observed-attempt.test.ts`（只读关联数据结构）覆盖，须在 `route-attempt-observer.test.ts` 里单独断言：写入失败转 `unavailable`；started/ended 正确配对；重复 ended 事件幂等（不重复写入或重复计数）；进程中断遗留的租约在下次读取时呈现为 `partial`；错误事件不留下半条 route attempt；provider/model/runId/callId 字段映射完整；异步写入失败不产生未处理 promise rejection。

**Step 2: 实现网关内纯评估器和观测适配器**

复用现有导出的 `resolveModelCandidateChain` 构建当前模型级候选顺序，但只在活网关服务中调用。新增：

```ts
evaluateShadowRoute({ contract, candidates, snapshots, policy })
recordObservedModelAttempt(...)
```

返回理论选择、候选准入决定、拒绝原因、观测完整性和 policy version。`model-fallback.ts` 不因复用该导出而修改；不要捕获 live fallback 异常、替换候选链或自行调用会改变冷却状态的解析器。

**Step 3: 实现 Core 安全服务和 gateway method 适配**

`service.ts` 组合 TaskContract、当前进程 resolver、shadow evaluator、观测租约和 store，只暴露窄口径的创建租约、评估和审计查询；这三个方法在 `service.ts` 内部就地校验 `callerScope`（对象级授权细节见 Task 6 Step 2），不假定上层调用者已经检查过。普通任务没有租约时只经过 hook 空检查，不写事实。插件不得直接获取 Kysely handle，也不得在 CLI 进程复制路由逻辑。

**Step 4: 运行测试**

```powershell
pnpm exec vitest run --config test/vitest/vitest.agents-core.config.ts src/agents/model-routing/shadow-evaluator.test.ts src/agents/model-routing/route-attempt-observer.test.ts src/agents/model-routing/observed-attempt.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/service.test.ts
pnpm exec vitest run --config test/vitest/vitest.plugins.config.ts src/plugins/wired-hooks-llm.test.ts
pnpm check
```

**Step 5: 提交**

```powershell
git add -- src/agents/model-routing/shadow-evaluator.ts src/agents/model-routing/shadow-evaluator.test.ts src/agents/model-routing/route-attempt-observer.ts src/agents/model-routing/route-attempt-observer.test.ts src/tasks/safety/service.ts src/tasks/safety/service.test.ts
git diff --cached --check
git commit -m "feat(agents): add gateway shadow route observation"
```

---

### Task 6: 通过 Plugin SDK 暴露窄口径影子服务

**文件：**

- Create: `src/plugin-sdk/safe-routing.ts`
- Create: `src/plugin-sdk/safe-routing.test.ts`
- Create: `packages/plugin-sdk/src/safe-routing.ts`
- Modify: `packages/plugin-sdk/package.json`（facade 包 exports 手工维护；`rg -n "packages/plugin-sdk/package\.json" scripts -g "*.mjs"` 核验过没有脚本会同步或覆盖这个字段，需手动新增 `safe-routing` 条目）
- Modify: `src/plugins/contracts/extension-package-project-boundaries.test.ts`（`packages/plugin-sdk/package.json` 的 `exports` 字段目前只有这个测试的逐条硬编码 `expect` 校验。`plugin-sdk:api:gen/check` 只校验 canonical entrypoint 列表对应的 `src/plugin-sdk/<entry>.ts` TypeScript API surface，不读取任何 package.json；根 `package.json` 的 exports 由 `plugin-sdk:sync-exports`/`check-exports` 单独校验。这是三道互不重叠的门禁，漏加这个测试文件时，facade 包里 `safe-routing` 条目缺失或写错不会被其余两道发现；但这三道门禁都只校验类型/导出面，不校验运行时授权语义，那部分的断言归属见下方 `safe-routing.test.ts`）
- Modify: `scripts/lib/plugin-sdk-entrypoints.json`
- Regenerate: root `package.json` Plugin SDK exports via `pnpm plugin-sdk:sync-exports`
- Regenerate: `docs/.generated/plugin-sdk-api-baseline.json`
- Regenerate: `docs/.generated/plugin-sdk-api-baseline.jsonl`
- Regenerate: `docs/.generated/plugin-sdk-api-baseline.sha256`
- Modify: Core plugin runtime service adapter files discovered during implementation（含 Task 5 `service.ts` 内落实的 `callerScope` 校验；若 Step 1 定位到需要单独的 gateway method 注册文件，一并列出并新增对应 `.test.ts`）
- Create/Modify: corresponding Plugin SDK and runtime adapter tests——`src/plugin-sdk/safe-routing.test.ts` 覆盖 Step 2 列出的全部安全语义断言，不得只靠 facade exports 测试或 API baseline 兜底

**Step 1: 先定位现有服务注入模式**

本仓库当前是 cone 模式 sparse-checkout（`git sparse-checkout list` 核验过只含 `apps/packages/patches/scripts/src/test/ui`，不含 `extensions`）：下面这条 `rg` 会静默漏搜 `extensions/`，Step 4 的 `extension-package-project-boundaries.test.ts` 也会因此 `ENOENT`（已实测复现）。先执行 `git sparse-checkout add extensions`（或改用完整检出）把 `extensions/` materialize 出来，再跑本步和 Step 4。

```powershell
rg -n "registerCli|plugin-sdk|services:" packages/plugin-sdk src extensions -g "*.ts"
```

沿用现有命名、生命周期和错误边界，不创建第二套插件容器；同时确认 `src/gateway/server-methods/cron-caller-scope.ts` 的既有模式（`readCronCallerScope(client: GatewayClient) → CronCallerScope`，从可信连接对象派生调用者身份，而非从客户端参数派生）——Step 2 的 `callerScope` 沿用同一模式，不发明新的鉴权中间层。gateway method 本身按 `extensions/safe-routing` 里的既有注册方式由扩展自己注册（`method-scopes.ts` 的 `getPluginRegistryState()?.activeRegistry?.gatewayMethodDescriptors` 已经通用支持插件注册方法的 scope 校验），`callerScope` 只是扩展的方法 handler 读取分发时已经可用的连接身份后自己组装的值，不新增 core `src/gateway/server-methods/*` 文件，不改 `packages/gateway-protocol/` 或核心分发基础设施——符合本计划开头「不改 gateway/protocol/UI」的 Core 例外边界。

**Step 2: 写失败测试**

插件侧只能调用活网关提供的窄口径服务：

```ts
createShadowObservationLease(contract, sessionRef, callerScope): { leaseId, leaseToken }
evaluateShadowRouteInGateway(leaseId, leaseToken)
getShadowAudit(taskId, callerScope)
```

`leaseId` 对应 schema 里的 `observation_lease_id`，是非密的查找/关联标识，可安全记日志；`leaseToken` 是一次性 bearer 密钥，网关只持久化 `lease_token_digest`（Task 3 schema），从不落盘明文。两者职责不同，不得合并成同一个值。

`callerScope` 是网关连接层派生并传入的可信调用者身份，沿用既有 `readCronCallerScope(client: GatewayClient) → CronCallerScope` 模式（`src/gateway/server-methods/cron-caller-scope.ts`），至少包含调用者的 `sessionKey`（判断 session 归属用）和已认证的 operator scopes。`sessionRef`/`taskId` 是调用者自己传入的参数，不能自证身份——`callerScope` 必须由 gateway method 分发层从当前连接对象派生后传入，插件或 CLI 不得自行构造，Core service 也不得在缺少 `callerScope` 时放行。`evaluateShadowRouteInGateway` 不单独接收 `callerScope`：合法未消费的 `leaseToken` 本身就是凭证（只能来自已经过 `callerScope` 校验的 `createShadowObservationLease` 调用），不必再重复派生一次调用者身份去做 operator scope 判断。

`leaseToken` 的一次性消费只终结这个 bearer 凭证自身的可重放性（写入 Task 3 schema 新增的 `token_consumed_at`），用来阻止同一 token 被重复呈现来重复触发理论评估；它与 `lease_state` 是两条独立生命周期，消费 token 不改写、也不提前终止 `lease_state` 描述的观测绑定生命周期（等待绑定 → 收到匹配 `model_call_started` 后由 Task 2/5 的 hook 路径 CAS 绑定 `bound_run_id/bound_call_id` → 配对 `model_call_ended` 后完成，或因过期/未配对/digest 漂移转 `partial`）。理论评估调用消费的是 token，不是 lease；真实调用到达时，无论 token 是否已消费，lease 只要未过期、尚未被绑定，就必须仍可被 CAS 绑定。

验证：

- SDK 不暴露数据库 handle、任意 SQL、任意状态写入或 enforce API。
- `createShadowObservationLease` 强制 `deliveryMode=none`，创建首个最小 checkpoint，并设置短 TTL/单次消费。
- gateway method 必须用 `callerScope` 验证 session 所有权，或具备显式 `operator.write`（`operator.admin` 按 `src/gateway/method-scopes.ts` 的 `authorizeOperatorScopesForRequiredScope` 既有规则始终隐含满足）；CLI 不得传递原始 session key，只传 session reference 并接收一次性 `leaseToken`。
- `evaluateShadowRouteInGateway` 必须同时校验 `leaseToken`：网关对呈现的 token 摘要后与 `lease_token_digest` 比对，仅凭 `leaseId` 不能触发评估；`leaseToken` 呈现一次后即写入 `token_consumed_at` 并失效，重复呈现返回稳定错误码，不得把 `leaseId` 当作可重放凭证；这次消费不写入、也不依赖 `lease_state`，不得影响该 lease 后续被真实 `model_call_started` CAS 绑定的资格（两条独立生命周期，见上）。
- `getShadowAudit` 在网关内用 `callerScope` 做对象级授权：普通调用者只能读取绑定到自己 session 的 task（`callerScope.sessionKey` 与 task 绑定 session 一致），operator 需要显式 `operator.read`（`operator.write`/`operator.admin` 按既有规则隐含满足 read）；跨 session 查询一律拒绝，且「无权访问」与「task 不存在」的错误码和响应耗时不可区分，不得通过错误差异枚举 task id。
- 非受管 task id、损坏契约或不存在 checkpoint 返回稳定错误码。
- gateway method 必须在活网关进程执行；CLI 进程不得自行加载 registry、auth store 或 provider health。
- 返回值不含 provider token、base URL credentials、会话正文或隐藏推理；`leaseToken` 本身也不得出现在日志、错误正文或 `getShadowAudit` 返回值里。
- API baseline 能检测意外导出扩大。
- `extension-package-project-boundaries.test.ts` 的「keeps plugin-sdk package types generated from the package build」用例新增两条断言：`packageJson.exports?.["./safe-routing"]?.types` 指向 `./dist/src/plugin-sdk/safe-routing.d.ts`，`packageJson.exports?.["./safe-routing"]?.default` 指向 `./src/safe-routing.ts`（facade 包 exports 共 64 个条目，现有断言只对其中 29 个做抽样校验，且都只查 `types`，对 `default` 缺失/写错/指错目标没有覆盖；本任务新增的这条不重复这个盲区，但不回头补齐其余条目，那是既有缺口不在本任务范围内）。这是目前唯一验证 facade 包 `exports` 字段的测试，但它只校验类型声明是否存在，不能替代下面这条运行时授权语义测试。
- 上面列出的安全语义——token 重放拒绝、跨 session 创建/查询拒绝、`operator.read` 不能创建/评估、返回值不泄漏 `leaseToken`、Core service 不能在缺少 `callerScope` 时被绕过调用——必须在 `src/plugin-sdk/safe-routing.test.ts` 里逐条断言；API baseline 和 facade exports 测试都只覆盖类型面，不覆盖运行时授权行为，不能互相替代或兜底。

**Step 3: 实现适配层**

Runtime adapter 只转发到 Task 5 的 Core service。插件进程不得自行重新解析配置或复制路由逻辑；Phase 1 不暴露 enforce 或状态转换 API。

**Step 4: 同步根 package.json exports 并核对 SDK API baseline**

```powershell
pnpm plugin-sdk:sync-exports
pnpm plugin-sdk:check-exports
pnpm plugin-sdk:api:gen
pnpm plugin-sdk:api:check
pnpm exec vitest run src/plugin-sdk/safe-routing.test.ts
pnpm exec vitest run src/plugins/contracts/extension-package-project-boundaries.test.ts
pnpm check:architecture
pnpm check
```

`plugin-sdk:sync-exports`／`plugin-sdk:check-exports`（`scripts/sync-plugin-sdk-exports.mjs`）读取 `scripts/lib/plugin-sdk-entrypoints.json` 生成/校验根 `package.json` 的 `exports`；`pnpm check` 不会间接跑这一步（`scripts/check.mjs` 里唯一相关项是 `lint:extensions:no-plugin-sdk-wildcard-reexports`，与 exports 同步无关），改了 `entrypoints.json` 后必须显式先跑这两条，否则根 `package.json` 可能没同步就进入后续步骤。

检查生成 diff，只接受与 `safe-routing` 三个只读方法和相关类型直接对应的变化。

`plugin-sdk:api:gen/check` 每次都从 `src/plugin-sdk/*.ts` 现有源码用 TS 编译器重新生成完整 baseline，只把哈希与已提交的 `.sha256` 比对，不读取 gitignored 的 `.json/.jsonl`；干净检出、这两个文件不存在时 `--check` 照常工作，drift 会显式 `exit 1` 并提示运行 `pnpm plugin-sdk:api:gen`，不会静默跳过。这条链路只校验 canonical entrypoint 对应的 TypeScript API surface，不读取任何 package.json；根 `package.json` 的 `exports` 由上面的 `plugin-sdk:sync-exports`/`check-exports` 校验，facade 包 `packages/plugin-sdk/package.json` 的 `exports` 字段则靠 `extension-package-project-boundaries.test.ts` 断言单独验证——三道门禁各管一段，互不替代。

**Step 5: 提交**

```powershell
git status --short
git add -- src/plugin-sdk/safe-routing.ts src/plugin-sdk/safe-routing.test.ts packages/plugin-sdk/src/safe-routing.ts packages/plugin-sdk/package.json src/plugins/contracts/extension-package-project-boundaries.test.ts scripts/lib/plugin-sdk-entrypoints.json package.json docs/.generated/plugin-sdk-api-baseline.sha256
```

`docs/.generated/plugin-sdk-api-baseline.json` 和 `.jsonl` 命中 `.gitignore`（`docs/.generated/*.json` / `*.jsonl`），只有 `.sha256` 受版本控制，不要把前两者加入 `git add`。

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
openclaw safe-routing shadow --contract <path> --session-ref <opaque-session-ref> --json
```

行为：

1. 读取并校验契约文件，确认 `deliveryMode=none`。
2. Phase 1 只接受固定 task kind `safe-routing-readonly-shadow`，且配置 allowlist 必须显式包含它。
3. 通过认证 gateway method 在活网关验证 session 所有权或显式 `operator.write`（`operator.admin` 隐含满足，见 Task 6 Step 2），创建短 TTL、单次消费的 observation lease 和最小 checkpoint；CLI 不传原始 session key，只传 `sessionRef`——`callerScope` 由网关连接层派生，CLI 的 `--session-ref` 参数不能自证身份。
4. 由活网关读取当前进程 registry/config、执行理论评估，并在下一次匹配的 model-call hook 上关联实际调用。
5. CLI 只查询并输出 `taskId`、current selection、theoretical selection、rejections、observation completeness/coverage、snapshot verification status 和 policy version。

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
5. 活网关 registry/config/candidate-chain digest 与离线 CLI 进程不同；CLI 结果仍以网关事实为准，离线 what-if 标记 live 字段 `unverified`。
6. 未经过 embedded-agent model diagnostic hook 的通用 fallback 调用标记 `out-of-scope`，不进入一致率分母；observer 写入失败标记 `unavailable`。
7. 同一模型级 `(provider, model)` 在同一 lease/checkpoint 默认只产生一次 observation；完整 route-target 去重留到 Phase 2。
8. CLI 重复读取审计不产生新 route attempts；越权 session lease 被拒绝。
9. `mode=off` 全程零写入，普通会话只经过 hook 空检查。

**Step 2: 执行定向回归**

```powershell
pnpm exec vitest run --config test/vitest/vitest.agents-core.config.ts src/agents/model-routing/capability-snapshot.test.ts src/agents/model-routing/candidate-admission.test.ts src/agents/model-routing/shadow-evaluator.test.ts src/agents/model-routing/shadow-evaluator.integration.test.ts src/agents/model-fallback.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/contracts.test.ts src/tasks/safety/observation-lease.test.ts src/tasks/safety/store.sqlite.test.ts src/tasks/safety/service.test.ts src/tasks/task-registry.store.test.ts src/tasks/task-registry.test.ts
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
- 观测租约的 token 单次消费（`token_consumed_at`）和首个 run/call 绑定（`bound_run_id/bound_call_id`）分别使用 CAS 防迟到/并发覆盖，且两者是独立事实——消费 token 不提前终止 lease 的绑定资格；
- lease、理论评估和首个 hook 关联绑定同一 config/plugin-registry/candidate-chain digest；变化时样本被排除；
- 能力快照区分 configured、observed、unverified、contradicted；
- hook 覆盖范围、partial/unavailable/out-of-scope 样本和一致率分母有明确审计记录；
- 影子评估只在活网关读取当前 registry/config，不调用 live fallback，不改变真实候选选择；
- 插件只获得窄口径 Core 服务，没有数据库直通；
- 扩展默认 `off`，Phase 1 不存在 `enforce` 配置；
- 所有新增定向测试通过，SQLite 定向测试连续三次通过，partial/unavailable/out-of-scope 观测不进入一致率分母；
- `pnpm check`、架构、Kysely 和 Plugin SDK 门禁通过，或有 clean-base 对照证明的存量失败记录；
- 没有扩充文本或图片 fallback 链，没有接管普通会话，没有正式交付能力。

完成后才进入 Phase 2：接入真实候选调度的 enforce 开关、故障分类和 provider quarantine；在此之前不实施副作用账本，更不开放正式交付。

---

## 实施期间已验证的偏差（Task 0-8 全部完成后补记）

- **Task 3**：租约的 SQLite 持久化没有走计划预测的独立表，而是发现 `task_checkpoints` 行本身已经带有全部租约字段（`observation_lease_id`/`lease_state`/... ），`insert` 语义等价于对既有 checkpoint 行的 UPDATE；因此没有改 `task-registry.store.*` 任何文件，只在 `task-registry.ts` 加了 13 行 `persistOverride` 钩子。
- **Task 5/7**：`SafeRoutingServiceDeps` 里"当前进程 resolver"最初设计成由调用方（扩展）自行拼装，实测发现扩展只能碰 plugin-sdk 窄口径，够不到 `resolveModelCandidateChain`/插件注册表——改为 Core 侧 `createLiveSafeRoutingServiceDeps()` 工厂，扩展只传 `approvedProviders`。
- **Task 7**：真实调用观测（`model_call_started`/`model_call_ended`）一度被误判为"需要改 Core 公开 API 才能订阅"；深入排查后确认 `api.on(hookName, handler)`（`registerTypedHook` 的公开别名）本来就支持这两个 hook 名——`extensions/workboard` 早就用同一机制订阅别的事件——最终零 Core 改动，只在 `extensions/safe-routing/index.ts` 加了两个 `api.on` 订阅 + service.ts 第四个窄口径方法 `recordObservedModelAttemptInGateway`。
- **Task 7 Step 5 / Task 8 Step 2**：两处测试命令原文写的 `vitest.plugins.config.ts` 对 `extensions/` 目录不生效（该 config 的 `dir`/`include` 只扫 `src/plugins/**`），实际覆盖 `extensions/**/*.test.ts` 的是 `vitest.extensions.config.ts`；本仓库当时是 sparse-checkout 且不含 `extensions/`，落地时补了 `git sparse-checkout add extensions` 和 `git sparse-checkout add docs`（后者是因为 `docs/.generated/plugin-sdk-api-baseline.sha256` 也不在原有 sparse 范围内）。
- **`pnpm check`** 的 `database-first legacy-store guard` 一项在补上 `extensions/` 到 sparse-checkout 后由失败转为通过——此前的失败是该检查在不完整工作树下的误报，不是代码问题。
- **`pnpm test:fast`**：跑过一次（`vitest.unit.config.ts`），10+ 分钟仍未跑完被 stall 检测杀掉，暴露 74 处失败用例，全部分布在与本分支完全无关的子系统（`skills/*`、`crestodian/*`、`context-engine/*`、`commitments/*`、`node-host/*` 等）；输出里 grep 不到任何 `safe-routing`/`model-routing`/`tasks/safety` 相关命中。未做完整 clean-base 对照跑（单次即耗时且未跑完，成本过高），按结构性证据（零主题重叠 + 完全不相干子系统 + 该分片本身有 stall 问题）判定为环境存量缺口，不视为本分支引入的回归。

---

## 后续阶段入口门槛

- **Phase 2（enforce 路由 + 可恢复 checkpoint）：** 至少完成一组经探针验证的低风险文本候选；shadow 与人工判定一致率、拒绝原因准确率达到预定门槛；live path 有一键关闭和对照测试。
- **Phase 3（Effect Ledger）：** 先接模拟或可查询回执的低风险工具；证明 `PREPARED → INDETERMINATE` 后不会自动重放。
- **Phase 4（完整状态门禁与独立复核）：** 复核必须绑定当前 checkpoint、契约和证据 digest；复核代理独立读取原始证据。
- **Phase 5（原子终结与交付）：** `effects` 对账、checkpoint 绑定复核、finalization 和现有 delivery queue 必须作为一个整体设计和验收。
- **Phase 6（角色梯队）：** 只纳入能力、鉴权、额度池和故障域均经过探针验证的候选；图片链和高风险任务单独启用。
