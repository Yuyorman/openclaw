# OpenClaw Safe Routing Phase 0-1 Implementation Plan

> 执行本计划时，使用 `executing-plans` 技能按任务顺序实施，每个任务先写失败测试，再做最小修改。

**目标：** 在不改变任何现有真实模型选择和 fallback 行为的前提下，实现可关闭的文本只读影子路由，并持久化任务契约、最小 checkpoint、能力快照和候选决策证据。

**架构：** Core 提供规范化数据、共享 SQLite 事实源、候选预览和状态转换服务；`extensions/safe-routing` 只提供配置、显式 CLI 试点入口和审计输出。本阶段不将安全门接入真实 `runWithModelFallback` 执行循环；Phase 2 在复用同一候选评估器的基础上接入 enforce。

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
- 实际运行版本：`2026.7.1-2 / 0790d9f`，影子功能验收后才安排构建和替换。
- 新分支：`feature/safe-routing-shadow-v1`。
- 新 worktree：`D:\\工作区\\Codex项目\\openclaw-safe-routing-shadow-v1`。
- 规范文档提交 `0d40b0c2` 和修正提交 `0c1dc60c` 在新 worktree 上单独 cherry-pick。

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

预期：分支为 `feature/safe-routing-shadow-v1`，包版本为 `2026.7.2`，无功能脏改动。

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
4. 基线未稳定前不进入 Task 1。

**Step 6: 提交**

如没有基线修复，本任务不产生提交。如有修复，按每个独立根因各产生一个提交，并在后续 safe-routing 提交中不重复该 diff。

---

### Task 1: 实现任务契约、规范化和 digest

**文件：**

- Create: `src/tasks/safety/contracts.ts`
- Create: `src/tasks/safety/contracts.test.ts`
- Reuse: `src/agents/stable-stringify.ts`
- Reuse: `src/infra/crypto-digest.ts` 或 Node `createHash`

**Step 1: 写失败测试**

测试以下行为：

- 完整契约规范化后字段顺序稳定。
- 同义输入产生相同 digest。
- modality、decision grade、risk class、delivery mode 和 data policy 的非法值被拒绝。
- `minEffectiveContextTokens` 和 `minOutputTokens` 必须是正整数。
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

使用现有 `stableStringify`，digest 格式固定为 `sha256:<64 lowercase hex>`。不增加通用 schema 框架或可配置抽象。

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

### Task 2: 增加受管任务安全状态和转换约束

**文件：**

- Modify: `src/tasks/task-registry.types.ts`
- Modify: `src/tasks/task-status.ts`
- Modify: `src/tasks/task-executor-policy.ts`
- Modify: `src/tasks/task-registry.ts`
- Modify: `src/tasks/task-registry.summary.ts`
- Create: `src/tasks/safety/state.ts`
- Create: `src/tasks/safety/transitions.ts`
- Create: `src/tasks/safety/transitions.test.ts`
- Modify tests: `src/tasks/task-executor-policy.test.ts`
- Modify tests: `src/tasks/task-status.test.ts`
- Modify tests: `src/tasks/task-registry.test.ts`

**Step 1: 写失败测试**

- `blocked` 是 active/non-terminal，不触发 terminal delivery 和 cleanup。
- 历史 `terminalOutcome=blocked` 仍是终态语义，不等于 `status=blocked`。
- 只有挂载 Safety State 的任务能进入新 `blocked`。
- `INDETERMINATE` 只能对应 `blocked/UNSAFE_RETRY`。
- `APPROVED` 必须绑定当前 checkpoint。
- Phase 1 服务拒绝创建 `deliveryMode=internal/formal` 的试点任务；底层状态校验同时保证 formal 任务没有 ACTIVE finalization 证明时不能进入 `succeeded`。
- `deliveryMode=none` 的影子任务可以在无 finalization 时正常结束。
- 旧 `rowVersion` 的更新被拒绝。

**Step 2: 运行测试确认失败**

```powershell
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/transitions.test.ts src/tasks/task-executor-policy.test.ts src/tasks/task-status.test.ts
```

**Step 3: 实现最小状态机**

导出类型和函数：

```ts
TaskSafetyState
TaskSafetyTransition
TaskSafetyTransitionError
validateTaskSafetyState(state, taskStatus, contract)
applyTaskSafetyTransition(current, transition)
```

不让插件或模型直接构造“下一状态”；它们只提交有限的 transition intent。

**Step 4: 运行定向测试**

```powershell
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/transitions.test.ts src/tasks/task-executor-policy.test.ts src/tasks/task-status.test.ts src/tasks/task-registry.test.ts
```

**Step 5: 提交**

```powershell
git add -- src/tasks/task-registry.types.ts src/tasks/task-status.ts src/tasks/task-executor-policy.ts src/tasks/task-registry.ts src/tasks/task-registry.summary.ts src/tasks/safety/state.ts src/tasks/safety/transitions.ts src/tasks/safety/transitions.test.ts src/tasks/task-executor-policy.test.ts src/tasks/task-status.test.ts src/tasks/task-registry.test.ts
git diff --cached --check
git commit -m "feat(tasks): add managed task safety states"
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

- 新建受管任务时，`task_runs`、`task_contracts`、`task_safety_state` 和首个最小 checkpoint 在同一事务提交。
- 任一 insert 失败时四类记录全部回滚；内存 registry 也不得出现幽灵任务。
- `task_safety_state.row_version` 使用 compare-and-swap，迟到写入不能覆盖新状态。
- 相同 `(task_id, sequence)` checkpoint 不能重复。
- capability snapshot 按 digest 复用，但已经引用的 snapshot 不原地改写。
- route attempt 必须引用存在的 task、checkpoint 和 snapshot。
- 旧任务不自动补写安全表；只有显式创建的受管任务进入新链路。

**Step 2: 增加最小 additive schema**

新增表：

```text
task_contracts
  task_id PK/FK task_runs
  schema_version, contract_json, contract_digest
  risk_class, review_required, delivery_mode
  routing_policy_version, created_at, updated_at

task_safety_state
  task_id PK/FK task_runs
  phase, execution_mode, completion, block_reason
  review, effect_safety
  current_checkpoint_id, reviewed_checkpoint_id
  evidence_complete, achieved_decision_grade
  row_version, created_at, updated_at

task_checkpoints
  checkpoint_id PK
  task_id FK task_runs, sequence
  contract_digest, input_digest, routing_policy_version
  capability_snapshot_ids_json, manifest_json
  created_at
  UNIQUE(task_id, sequence)

model_capability_snapshots
  snapshot_id PK
  provider, model, runtime_id
  verification_status, capabilities_json, evidence_json
  snapshot_digest UNIQUE, created_at, expires_at

model_route_attempts
  attempt_id PK
  task_id FK, checkpoint_id FK
  ordinal, provider, model, runtime_id
  capability_snapshot_id FK
  evaluation_mode, eligibility
  rejection_code, rejection_reason, would_select
  failure_domain_json, created_at
```

为 `(task_id, checkpoint_id, ordinal)`、`(provider, model, created_at)` 和状态查询建立必要索引。Phase 1 不建立 `effects`、`finalizations`、`delivery_outbox`，避免先造空壳事务。

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
getTaskSafetyState(taskId)
compareAndSetTaskSafetyState(...)
putCapabilitySnapshot(...)
appendRouteAttempts(...)
listRouteAttempts(taskId, checkpointId)
```

插件不得直接获取 Kysely handle。`createManagedTaskWithCheckpoint` 复用 task registry 的数据库事务；只有事务成功后才更新内存 registry。

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
- Modify if needed: `src/agents/model-fallback.types.ts`
- Reuse: `src/config/types.models.ts`
- Reuse: `src/agents/model-fallback.ts`

**Step 1: 写失败测试**

- 配置声明、运行时上限和观测证据汇总为一个 immutable snapshot。
- effective context/output limit 取已知约束中的最小值，不取最乐观值。
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

**Step 3: 运行定向测试**

```powershell
pnpm exec vitest run --config test/vitest/vitest.agents-core.config.ts src/agents/model-routing/capability-snapshot.test.ts src/agents/model-routing/candidate-admission.test.ts
pnpm check
```

**Step 4: 提交**

```powershell
git add -- src/agents/model-routing/capability-snapshot.ts src/agents/model-routing/capability-snapshot.test.ts src/agents/model-routing/candidate-admission.ts src/agents/model-routing/candidate-admission.test.ts src/agents/model-fallback.types.ts
git diff --cached --check
git commit -m "feat(agents): evaluate model capability snapshots"
```

---

### Task 5: 实现只读影子路由评估和审计写入

**文件：**

- Create: `src/agents/model-routing/shadow-evaluator.ts`
- Create: `src/agents/model-routing/shadow-evaluator.test.ts`
- Create: `src/agents/model-routing/route-attempt-observer.ts`
- Create: `src/tasks/safety/service.ts`
- Create: `src/tasks/safety/service.test.ts`
- Modify minimally: `src/agents/model-fallback.ts`

**Step 1: 写失败测试**

构造 A/B/C 候选：A 是当前 primary，B 能力不足，C 能力满足且故障域独立。验证：

- 当前真实选择仍是 A；影子输出只报告理论选择 C。
- 影子评估不得调用模型、工具或 provider health mutation。
- B 的每个拒绝理由有机器码和可读证据。
- 候选顺序、snapshot id、contract digest 和 routing policy version 全部落库。
- 同一完整解析后的 route target 在同一 task/checkpoint 默认只记一次评估；只有显式、安全且有策略依据的重试才允许新 attempt。
- 批量写 route attempts 失败时，不留下半条候选链。
- 当前配置若没有合格候选，输出 `WAITING_CAPABLE_MODEL` 的派生建议，但不改变真实任务路由。

**Step 2: 实现纯评估器**

复用现有导出的 `resolveModelCandidateChain` 构建当前候选顺序，新增：

```ts
evaluateShadowRoute({ contract, candidates, snapshots, policy })
recordShadowRouteEvaluation(...)
```

返回：

```ts
{
  currentSelection,
  theoreticalSelection,
  candidateDecisions,
  derivedBlockReason,
  policyVersion,
}
```

不要改 `runWithModelFallback`、不要捕获它的异常重试、不要替换其候选链。若为共享纯函数而调整 `model-fallback.ts`，必须保证现有调用签名和结果完全不变。

**Step 3: 实现 Core 安全服务**

`service.ts` 组合 TaskContract、snapshot resolver、shadow evaluator 和 store，但只暴露读/追加事实能力；禁止调用 live fallback 执行器。

**Step 4: 运行测试**

```powershell
pnpm exec vitest run --config test/vitest/vitest.agents-core.config.ts src/agents/model-routing/shadow-evaluator.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/service.test.ts
pnpm exec vitest run --config test/vitest/vitest.agents-core.config.ts src/agents/model-fallback.test.ts
pnpm check
```

**Step 5: 提交**

```powershell
git add -- src/agents/model-routing/shadow-evaluator.ts src/agents/model-routing/shadow-evaluator.test.ts src/agents/model-routing/route-attempt-observer.ts src/tasks/safety/service.ts src/tasks/safety/service.test.ts src/agents/model-fallback.ts
git diff --cached --check
git commit -m "feat(agents): add read-only shadow route evaluation"
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

插件侧只能调用：

```ts
createShadowTask(contract, inputDigest)
evaluateShadowRoute(taskId)
getShadowAudit(taskId)
```

验证：

- SDK 不暴露数据库 handle、任意 SQL、任意状态写入或 enforce API。
- `createShadowTask` 强制 `deliveryMode=none`，并创建首个 checkpoint。
- 非受管 task id、损坏契约或不存在 checkpoint 返回稳定错误码。
- 返回值不含 provider token、base URL credentials、会话正文或隐藏推理。
- API baseline 能检测意外导出扩大。

**Step 3: 实现适配层**

Runtime adapter 只转发到 Task 5 的 Core service。插件进程不得自行重新解析配置或复制路由逻辑。

**Step 4: 更新并核对 SDK API baseline**

```powershell
pnpm plugin-sdk:api:gen
pnpm plugin-sdk:api:check
pnpm check:architecture
pnpm check
```

检查生成 diff，只接受与 `safe-routing` 三个方法和相关类型直接对应的变化。

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
- 扩展不注册模型 tool，不监听普通聊天，不修改全局 fallback。

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
openclaw safe-routing shadow --contract <path> --json
```

行为：

1. 读取并校验契约文件。
2. Phase 1 只接受固定 task kind `safe-routing-readonly-shadow`，且配置 allowlist 必须显式包含它。
3. 创建 `deliveryMode=none` 的影子任务与 checkpoint。
4. 读取当前已解析模型链和能力快照，执行一次理论评估。
5. 输出 `taskId`、current selection、theoretical selection、rejections、snapshot verification status 和 policy version。

命令不得发起模型请求、工具调用、消息发送、导出或发布。

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

使用临时 SQLite 和假模型目录，覆盖：

1. 当前主模型 A 仍被真实路由选中。
2. A 的快照不满足契约，B 满足；影子审计报告理论选择 B，但真实路由不变。
3. 所有候选能力不足；报告 `CAPABLE_MODEL` 阻塞建议，任务可以以 `deliveryMode=none` 结束审计。
4. provider 未获数据策略批准；候选被拒绝。
5. 同一候选由别名解析到同一完整 route target；默认只产生一次 attempt。
6. CLI 重复读取审计不产生新 route attempts。
7. `mode=off` 全程零写入。

**Step 2: 执行定向回归**

```powershell
pnpm exec vitest run --config test/vitest/vitest.agents-core.config.ts src/agents/model-routing/capability-snapshot.test.ts src/agents/model-routing/candidate-admission.test.ts src/agents/model-routing/shadow-evaluator.test.ts src/agents/model-routing/shadow-evaluator.integration.test.ts src/agents/model-fallback.test.ts
pnpm exec vitest run --config test/vitest/vitest.tasks.config.ts src/tasks/safety/contracts.test.ts src/tasks/safety/transitions.test.ts src/tasks/safety/store.sqlite.test.ts src/tasks/safety/service.test.ts src/tasks/task-registry.store.sqlite.test.ts src/tasks/task-registry.test.ts
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
- 普通会话不会触发 safe-routing 扩展。
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

1. 记录构建 commit、OpenClaw 实际版本、配置文件 hash 和共享 SQLite 路径。
2. 停止 OpenClaw 后复制 `openclaw.sqlite` 及其 `-wal/-shm`（如存在）到带时间戳备份目录，再启动服务。
3. 首次部署保持 `mode=off`，确认普通会话、现有 fallback 和 task registry 回归正常。
4. 只把 `safe-routing-readonly-shadow` 加入 allowlist，并配置已批准 provider 列表。

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
- SQLite/CAS/事务测试稳定；
- 审计中无凭据、会话正文和隐藏思维过程。

### 回滚

1. 将扩展设为 `mode=off` 或移除扩展启用项。
2. 不删除 additive 数据表，不在运行中降级 schema；保留审计事实供复盘。
3. 如果代码回滚到不认识新表的旧版本，旧版本应忽略 additive tables；先用备份副本验证再切换。
4. 因 Phase 1 没有接管 live fallback，回滚不涉及恢复模型梯队或重放任务。

---

## 完成定义

Phase 0-1 只有在以下证据同时具备时才算完成：

- clean `origin/main` 基线及已知失败有可复现记录；
- TaskContract 可规范化、可 hash、非法能力要求会被拒绝；
- 受管任务的 contract/state/checkpoint 创建具备原子性；
- 多维状态的转换约束和 CAS 防迟到写入已测试；
- 能力快照区分 configured、observed、unverified、contradicted；
- 影子评估不调用 live fallback，不改变真实候选选择；
- 插件只获得窄口径 Core 服务，没有数据库直通；
- 扩展默认 `off`，Phase 1 不存在 `enforce` 配置；
- 所有新增定向测试通过，SQLite 定向测试连续三次通过；
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
