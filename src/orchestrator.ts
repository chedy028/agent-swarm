import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyCiState, evaluatePullRequestGate, summarizeReviews } from './gates.js';
import { findPrByBranch, getPrChecks, getPrView, isPrMerged, shellEscape } from './gh.js';
import { computeRetryOutcome, isTerminalStatus } from './state.js';
import { appendHistory, getTask, loadRegistry, saveRegistry } from './store.js';
import {
  AgentName,
  CommandRunner,
  RetryReason,
  TaskRecord,
  TaskRegistry,
  TaskStatus,
  ZoeConfig
} from './types.js';

const AGENT_PRIORITY: AgentName[] = ['codex', 'gemini', 'claude'];

export interface SpawnInput {
  id: string;
  description: string;
  promptFile: string;
}

export interface RetryInput {
  taskId: string;
  reason: string;
  deltaFile?: string;
}

export interface CleanupInput {
  dryRun: boolean;
}

export interface CommandOutput {
  updatedTasks: TaskRecord[];
  messages: string[];
}

interface CheckTaskResult {
  changed: boolean;
  parent: TaskRecord;
  children: TaskRecord[];
  actionableMessages: string[];
}

interface CheckChildResult {
  changed: boolean;
  task: TaskRecord;
}

function isChildTask(task: TaskRecord): boolean {
  return task.kind === 'child';
}

function isParentTask(task: TaskRecord): boolean {
  return task.kind === 'parent';
}

function canonicalAgents(config: ZoeConfig): AgentName[] {
  const allowed = new Set(config.allowedAgents);
  return AGENT_PRIORITY.filter((agent) => allowed.has(agent));
}

function branchFor(taskId: string, agent: AgentName): string {
  return `feat/${toBranchSegment(taskId)}-${agent}`;
}

function worktreeFor(config: ZoeConfig, taskId: string, agent: AgentName): string {
  return path.join(config.worktreeRoot, `${taskId}-${agent}`);
}

function sessionFor(taskId: string, agent: AgentName): string {
  return `zoe-${toSessionSegment(taskId)}-${agent}`;
}

function childIdFor(taskId: string, agent: AgentName): string {
  return `${taskId}--${agent}`;
}

function setTaskStatus(task: TaskRecord, status: TaskStatus, note: string): TaskRecord {
  if (task.status === status && task.note === note) {
    return task;
  }

  return {
    ...task,
    status,
    note,
    updatedAt: Date.now()
  };
}

function hasTaskChanged(previous: TaskRecord, next: TaskRecord): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

async function isSessionAlive(runner: CommandRunner, session: string): Promise<boolean> {
  const result = await runner.run(`tmux has-session -t ${shellEscape(session)}`, { allowFailure: true });
  return result.exitCode === 0;
}

function summarizeFailingChecks(checks: Array<{ name: string; state: string }>): string {
  const failed = checks.filter((check) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(check.state));
  if (failed.length === 0) {
    return 'CI failed.';
  }

  return `CI failed checks: ${failed.map((check) => `${check.name}(${check.state})`).join(', ')}`;
}

async function buildPrompt(promptFile: string, deltaFile?: string): Promise<string> {
  const basePrompt = await readFile(promptFile, 'utf8');
  if (!deltaFile) {
    return basePrompt.trim();
  }

  const deltaPrompt = await readFile(deltaFile, 'utf8');
  return `${basePrompt.trim()}\n\n${deltaPrompt.trim()}`;
}

function renderLaunchCommand(template: string, variables: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
    const value = variables[key] ?? '';
    if (key === 'prompt') {
      return escapeForDoubleQuotedShell(value);
    }
    return value;
  });
}

function escapeForDoubleQuotedShell(value: string): string {
  return value.replace(/[\\"$`]/g, (ch) => `\\${ch}`).replace(/\n/g, ' ');
}

async function launchAgentSession(
  config: ZoeConfig,
  runner: CommandRunner,
  task: TaskRecord,
  deltaFile?: string
): Promise<void> {
  if (!task.agent || !task.worktree || !task.tmuxSession || !task.promptFile || !task.branch) {
    throw new Error(`Task ${task.id} is missing child execution metadata`);
  }

  const template = config.agentLaunchCommands[task.agent];
  if (!template) {
    throw new Error(`Missing launch command template for agent: ${task.agent}`);
  }

  const prompt = await buildPrompt(task.promptFile, deltaFile);
  const command = renderLaunchCommand(template, {
    id: task.id,
    parent_id: task.parentId ?? '',
    agent: task.agent,
    description: task.description,
    worktree: task.worktree,
    branch: task.branch,
    prompt,
    promptFile: task.promptFile,
    deltaFile: deltaFile ?? ''
  });

  await runner.run(`tmux kill-session -t ${shellEscape(task.tmuxSession)}`, { allowFailure: true });
  await runner.run(
    `tmux new-session -d -s ${shellEscape(task.tmuxSession)} -c ${shellEscape(task.worktree)} ${shellEscape(command)}`
  );
}

async function writeRetryDelta(
  config: ZoeConfig,
  taskId: string,
  attempt: number,
  reason: RetryReason,
  detail: string
): Promise<string> {
  await mkdir(config.retryDir, { recursive: true });
  const deltaPath = path.join(config.retryDir, `${taskId}-retry-${attempt}.md`);
  const contents = [
    '# Retry Delta',
    '',
    `Reason: ${reason}`,
    `Detail: ${detail}`,
    '',
    'Please fix the issue above with minimal changes.',
    'Constrain edits to files directly related to this failure.',
    'Run relevant tests/checks before updating the PR.'
  ].join('\n');

  await writeFile(deltaPath, `${contents}\n`, 'utf8');
  return deltaPath;
}

async function createChildTask(
  config: ZoeConfig,
  runner: CommandRunner,
  parentId: string,
  description: string,
  promptFile: string,
  agent: AgentName,
  now: number
): Promise<TaskRecord> {
  const branch = branchFor(parentId, agent);
  const worktree = worktreeFor(config, parentId, agent);
  const tmuxSession = sessionFor(parentId, agent);
  const id = childIdFor(parentId, agent);

  await runner.run(
    `git -C ${shellEscape(config.repoPath)} worktree add ${shellEscape(worktree)} -b ${shellEscape(branch)} ${shellEscape(`origin/${config.mainBranch}`)}`
  );

  if (config.installCommand && config.installCommand.trim() !== '') {
    await runner.run(config.installCommand, { cwd: worktree });
  }

  const task: TaskRecord = {
    id,
    kind: 'child',
    description,
    agent,
    parentId,
    repo: path.basename(config.repoPath),
    branch,
    worktree,
    tmuxSession,
    promptFile: path.resolve(promptFile),
    status: 'running',
    retryCount: 0,
    startedAt: now,
    updatedAt: now,
    note: `Spawned and started ${agent} session.`
  };

  await launchAgentSession(config, runner, task);
  return task;
}

function validateSpawnInput(input: SpawnInput): void {
  if (!input.id || !input.description || !input.promptFile) {
    throw new Error('spawn requires --id, --description, --prompt-file');
  }
}

export async function spawnTask(config: ZoeConfig, runner: CommandRunner, input: SpawnInput): Promise<CommandOutput> {
  validateSpawnInput(input);
  await access(input.promptFile);

  const registry = await loadRegistry(config.registryPath);
  if (getTask(registry, input.id)) {
    throw new Error(`Task already exists: ${input.id}`);
  }

  await mkdir(config.worktreeRoot, { recursive: true });

  const now = Date.now();
  const parent: TaskRecord = {
    id: input.id,
    kind: 'parent',
    description: input.description,
    childIds: [],
    repo: path.basename(config.repoPath),
    status: 'running',
    retryCount: 0,
    startedAt: now,
    updatedAt: now,
    note: 'Trio swarm spawned (codex, gemini, claude).'
  };

  const childTasks: TaskRecord[] = [];
  for (const agent of canonicalAgents(config)) {
    const child = await createChildTask(config, runner, input.id, input.description, input.promptFile, agent, now);
    childTasks.push(child);
  }

  parent.childIds = childTasks.map((task) => task.id);

  const mergedTasks = [...registry.tasks, parent, ...childTasks].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  await saveRegistry(config.registryPath, { tasks: mergedTasks });

  return {
    updatedTasks: [parent, ...childTasks],
    messages: [
      `spawned_parent:${parent.id}`,
      ...childTasks.map((child) => `spawned_child:${child.id}:agent=${child.agent}:session=${child.tmuxSession}:branch=${child.branch}`)
    ]
  };
}

async function handleActionableFailure(
  config: ZoeConfig,
  runner: CommandRunner,
  task: TaskRecord,
  reason: RetryReason,
  detail: string
): Promise<CheckChildResult> {
  const outcome = computeRetryOutcome(task.retryCount, config.maxRetries, reason);

  if (outcome.blocked) {
    const blockedTask = {
      ...task,
      status: 'blocked' as TaskStatus,
      lastFailureReason: reason,
      note: `Blocked after max retries (${config.maxRetries}). Last failure: ${detail}`,
      updatedAt: Date.now()
    };

    return {
      changed: true,
      task: blockedTask
    };
  }

  const deltaFile = await writeRetryDelta(config, task.id, outcome.nextRetryCount, reason, detail);
  const retryTask: TaskRecord = {
    ...task,
    retryCount: outcome.nextRetryCount,
    lastFailureReason: reason,
    note: `Auto-retry #${outcome.nextRetryCount} triggered by ${reason}.`,
    updatedAt: Date.now(),
    status: 'running',
    gatePassedAt: undefined
  };

  await launchAgentSession(config, runner, retryTask, deltaFile);

  return {
    changed: true,
    task: retryTask
  };
}

async function checkSingleChildTask(
  config: ZoeConfig,
  runner: CommandRunner,
  task: TaskRecord
): Promise<CheckChildResult> {
  let nextTask = { ...task };

  if (!nextTask.tmuxSession || !nextTask.branch) {
    return {
      changed: true,
      task: setTaskStatus(nextTask, 'blocked', 'Task metadata invalid: missing tmuxSession/branch.')
    };
  }

  if (nextTask.status === 'superseded' || nextTask.status === 'blocked' || nextTask.status === 'done' || nextTask.status === 'failed') {
    return { changed: false, task: nextTask };
  }

  const sessionAlive = await isSessionAlive(runner, nextTask.tmuxSession);
  if (!sessionAlive) {
    return await handleActionableFailure(config, runner, nextTask, 'session_died', 'tmux session not found');
  }

  let pr = nextTask.pr;
  if (!pr) {
    const listed = await findPrByBranch(runner, nextTask.branch, config.repoPath);
    if (!listed) {
      nextTask = setTaskStatus(nextTask, 'running', 'Waiting for PR creation.');
      return {
        changed: hasTaskChanged(task, nextTask),
        task: nextTask
      };
    }
    pr = {
      number: listed.number,
      url: listed.url,
      state: listed.state,
      mergeStateStatus: listed.mergeStateStatus,
      body: listed.body
    };
    nextTask.pr = pr;
  }

  const fullPr = await getPrView(runner, pr.number, config.repoPath);
  if (!fullPr) {
    nextTask = setTaskStatus(nextTask, 'running', 'PR metadata temporarily unavailable.');
    return {
      changed: hasTaskChanged(task, nextTask),
      task: nextTask
    };
  }

  const checks = await getPrChecks(runner, fullPr.number, config.repoPath);
  const gate = evaluatePullRequestGate(fullPr, checks, config);
  const reviewSummary = summarizeReviews(fullPr, config);

  nextTask.pr = {
    number: fullPr.number,
    url: fullPr.url,
    state: fullPr.state,
    mergeStateStatus: fullPr.mergeStateStatus,
    body: fullPr.body
  };
  nextTask.checks = {
    ciPassed: gate.ciPassed,
    checks: checks.map((check) => ({
      name: check.name,
      state: check.state,
      url: check.link
    }))
  };
  nextTask.reviewSummary = reviewSummary;

  if (!gate.branchSynced) {
    nextTask = setTaskStatus(nextTask, 'waiting_ci', 'Branch is not synced with main.');
    return {
      changed: hasTaskChanged(task, nextTask),
      task: nextTask
    };
  }

  const ciState = classifyCiState(checks);
  if (ciState === 'pending') {
    nextTask = setTaskStatus(nextTask, 'waiting_ci', 'CI is still running.');
    return {
      changed: hasTaskChanged(task, nextTask),
      task: nextTask
    };
  }

  if (ciState === 'fail') {
    return await handleActionableFailure(config, runner, nextTask, 'ci_failed', summarizeFailingChecks(checks));
  }

  if (gate.criticalOpenCount > 0) {
    return await handleActionableFailure(
      config,
      runner,
      nextTask,
      'critical_review',
      `${gate.criticalOpenCount} unresolved critical review findings.`
    );
  }

  if (!gate.screenshotPassed) {
    nextTask = setTaskStatus(nextTask, 'waiting_reviews', 'UI changed but screenshot is missing from PR body.');
    return {
      changed: hasTaskChanged(task, nextTask),
      task: nextTask
    };
  }

  if (gate.approvalCount < config.requiredApprovals) {
    nextTask = setTaskStatus(
      nextTask,
      'waiting_reviews',
      `Waiting for bot approvals (${gate.approvalCount}/${config.requiredApprovals}).`
    );
    return {
      changed: hasTaskChanged(task, nextTask),
      task: nextTask
    };
  }

  nextTask = setTaskStatus(
    nextTask,
    'ready_for_human',
    `PR #${fullPr.number} gate-passed. CI + reviews complete (${gate.approvalCount}/${config.requiredApprovals}).`
  );
  if (!nextTask.gatePassedAt) {
    nextTask.gatePassedAt = Date.now();
  }

  return {
    changed: hasTaskChanged(task, nextTask),
    task: nextTask
  };
}

function pickWinner(children: TaskRecord[]): TaskRecord | undefined {
  const candidates = children.filter((child) => child.gatePassedAt && child.status !== 'superseded');
  if (candidates.length === 0) {
    return undefined;
  }

  const rank = (agent?: AgentName): number => {
    if (!agent) {
      return Number.MAX_SAFE_INTEGER;
    }
    const idx = AGENT_PRIORITY.indexOf(agent);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };

  const sorted = [...candidates].sort((a, b) => {
    const aTime = a.gatePassedAt ?? Number.MAX_SAFE_INTEGER;
    const bTime = b.gatePassedAt ?? Number.MAX_SAFE_INTEGER;
    if (aTime !== bTime) {
      return aTime - bTime;
    }
    return rank(a.agent) - rank(b.agent);
  });

  return sorted[0];
}

async function markChildSuperseded(runner: CommandRunner, child: TaskRecord, winnerId: string): Promise<TaskRecord> {
  const superseded = setTaskStatus(child, 'superseded', `Superseded by winner task ${winnerId}.`);
  superseded.supersededBy = winnerId;
  if (superseded.tmuxSession) {
    await runner.run(`tmux kill-session -t ${shellEscape(superseded.tmuxSession)}`, { allowFailure: true });
  }
  return superseded;
}

function allChildrenBlocked(children: TaskRecord[]): boolean {
  return children.length > 0 && children.every((child) => child.status === 'blocked' || child.status === 'failed');
}

async function checkParentTask(
  config: ZoeConfig,
  runner: CommandRunner,
  parent: TaskRecord,
  children: TaskRecord[]
): Promise<CheckTaskResult> {
  let nextParent = { ...parent };
  const nextChildren = children.map((child) => ({ ...child }));
  const actionableMessages: string[] = [];
  let changed = false;

  if (nextParent.status === 'done' || nextParent.status === 'blocked') {
    return {
      changed: false,
      parent: nextParent,
      children: nextChildren,
      actionableMessages
    };
  }

  const childById = new Map(nextChildren.map((child) => [child.id, child]));

  if (nextParent.winnerChildId) {
    const winner = childById.get(nextParent.winnerChildId);
    if (!winner || !winner.pr?.number) {
      nextParent = setTaskStatus(nextParent, 'blocked', 'Winner metadata missing; manual intervention required.');
      changed = true;
      actionableMessages.push(`attention_required:${nextParent.id}:winner_metadata_missing`);
      return {
        changed,
        parent: nextParent,
        children: nextChildren,
        actionableMessages
      };
    }

    const merged = await isPrMerged(runner, winner.pr.number, config.repoPath);
    if (merged) {
      const now = Date.now();
      winner.status = 'done';
      winner.updatedAt = now;
      winner.completedAt = now;
      winner.note = `Merged PR #${winner.pr.number}.`;

      nextParent.status = 'done';
      nextParent.updatedAt = now;
      nextParent.completedAt = now;
      nextParent.note = `Winner PR #${winner.pr.number} merged.`;
      changed = true;
    } else {
      nextParent = setTaskStatus(nextParent, 'ready_for_human', `Winner selected (${winner.id}) awaiting merge.`);
      changed = changed || hasTaskChanged(parent, nextParent);
    }

    return {
      changed,
      parent: nextParent,
      children: nextChildren,
      actionableMessages
    };
  }

  for (let i = 0; i < nextChildren.length; i += 1) {
    const child = nextChildren[i];
    const checked = await checkSingleChildTask(config, runner, child);
    if (checked.changed) {
      nextChildren[i] = checked.task;
      changed = true;
    }
  }

  const winner = pickWinner(nextChildren);
  if (winner) {
    const now = Date.now();
    nextParent.winnerChildId = winner.id;
    nextParent.winnerPrNumber = winner.pr?.number;
    nextParent.winnerSelectedAt = now;
    nextParent.status = 'ready_for_human';
    nextParent.note = `Winner selected: ${winner.id}${winner.pr?.number ? ` (PR #${winner.pr.number})` : ''}.`;
    nextParent.updatedAt = now;

    for (let i = 0; i < nextChildren.length; i += 1) {
      const child = nextChildren[i];
      if (child.id === winner.id) {
        continue;
      }
      if (child.status === 'done' || child.status === 'superseded') {
        continue;
      }
      nextChildren[i] = await markChildSuperseded(runner, child, winner.id);
      changed = true;
    }

    changed = true;
    actionableMessages.push(`ready_for_human:${nextParent.id}:winner=${winner.id}:pr=${winner.pr?.number ?? '-'}`);

    return {
      changed,
      parent: nextParent,
      children: nextChildren,
      actionableMessages
    };
  }

  if (allChildrenBlocked(nextChildren)) {
    nextParent = setTaskStatus(nextParent, 'blocked', 'All trio agents blocked before a winner was selected.');
    changed = true;
    actionableMessages.push(`attention_required:${nextParent.id}:all_children_blocked`);
    return {
      changed,
      parent: nextParent,
      children: nextChildren,
      actionableMessages
    };
  }

  nextParent = setTaskStatus(nextParent, 'running', 'Trio swarm in progress.');
  changed = changed || hasTaskChanged(parent, nextParent);

  return {
    changed,
    parent: nextParent,
    children: nextChildren,
    actionableMessages
  };
}

export async function checkTasks(
  config: ZoeConfig,
  runner: CommandRunner,
  taskId?: string
): Promise<CommandOutput> {
  const registry = await loadRegistry(config.registryPath);
  const allTasks = registry.tasks;

  const parentTasks = allTasks.filter(isParentTask);
  const taskById = new Map(allTasks.map((task) => [task.id, task]));

  const selectedParentIds = new Set<string>();
  if (taskId) {
    const selected = taskById.get(taskId);
    if (!selected) {
      return { updatedTasks: [], messages: [] };
    }
    if (isParentTask(selected)) {
      selectedParentIds.add(selected.id);
    } else if (selected.parentId) {
      selectedParentIds.add(selected.parentId);
    }
  } else {
    for (const parent of parentTasks) {
      selectedParentIds.add(parent.id);
    }
  }

  const nextById = new Map(allTasks.map((task) => [task.id, { ...task }]));
  const updatedTasks: TaskRecord[] = [];
  const actionableMessages: string[] = [];

  for (const parentId of selectedParentIds) {
    const parent = nextById.get(parentId);
    if (!parent || !isParentTask(parent)) {
      continue;
    }

    const children = [...nextById.values()]
      .filter((task) => isChildTask(task) && task.parentId === parent.id)
      .sort(
        (a, b) =>
          AGENT_PRIORITY.indexOf((a.agent ?? 'claude') as AgentName) -
          AGENT_PRIORITY.indexOf((b.agent ?? 'claude') as AgentName)
      );

    const result = await checkParentTask(config, runner, parent, children);
    if (!result.changed) {
      continue;
    }

    nextById.set(parent.id, result.parent);
    updatedTasks.push(result.parent);

    for (const child of result.children) {
      nextById.set(child.id, child);
      if (hasTaskChanged(taskById.get(child.id) ?? child, child)) {
        updatedTasks.push(child);
      }
    }

    actionableMessages.push(...result.actionableMessages);
  }

  if (updatedTasks.length > 0) {
    const nextRegistry: TaskRegistry = {
      tasks: [...nextById.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
    };
    await saveRegistry(config.registryPath, nextRegistry);
  }

  return {
    updatedTasks,
    messages: actionableMessages
  };
}

function toBranchSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function toSessionSegment(value: string): string {
  return toBranchSegment(value).slice(0, 30);
}

export async function retryTask(config: ZoeConfig, runner: CommandRunner, input: RetryInput): Promise<CommandOutput> {
  if (!input.taskId || !input.reason) {
    throw new Error('retry requires --task-id and --reason');
  }

  const registry = await loadRegistry(config.registryPath);
  const task = getTask(registry, input.taskId);
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  if (task.kind !== 'child') {
    throw new Error('Manual retry is only supported for child tasks.');
  }

  if (task.status === 'superseded') {
    throw new Error(`Task ${task.id} is superseded and cannot be retried.`);
  }

  const outcome = computeRetryOutcome(task.retryCount, config.maxRetries, 'manual');
  if (outcome.blocked) {
    const blocked = {
      ...task,
      status: 'blocked' as TaskStatus,
      note: `Manual retry denied: max retries reached (${config.maxRetries}).`,
      updatedAt: Date.now()
    };
    const updatedTasks = registry.tasks.map((existing) => (existing.id === blocked.id ? blocked : existing));
    await saveRegistry(config.registryPath, { tasks: updatedTasks });
    return {
      updatedTasks: [blocked],
      messages: [`${task.id}:blocked:max_retries_reached`]
    };
  }

  const deltaPath =
    input.deltaFile && input.deltaFile.trim() !== ''
      ? path.resolve(input.deltaFile)
      : await writeRetryDelta(config, task.id, outcome.nextRetryCount, 'manual', input.reason);

  const nextTask: TaskRecord = {
    ...task,
    retryCount: outcome.nextRetryCount,
    status: 'running',
    note: `Manual retry #${outcome.nextRetryCount}: ${input.reason}`,
    lastFailureReason: `manual:${input.reason}`,
    updatedAt: Date.now(),
    gatePassedAt: undefined
  };

  await launchAgentSession(config, runner, nextTask, deltaPath);

  const updatedTasks = registry.tasks.map((existing) => (existing.id === nextTask.id ? nextTask : existing));
  await saveRegistry(config.registryPath, { tasks: updatedTasks });

  return {
    updatedTasks: [nextTask],
    messages: [`${nextTask.id}:manual_retry:${outcome.nextRetryCount}`]
  };
}

async function removeChildWorktree(config: ZoeConfig, runner: CommandRunner, child: TaskRecord, messages: string[]): Promise<void> {
  if (!child.worktree) {
    return;
  }

  const remove = await runner.run(
    `git -C ${shellEscape(config.repoPath)} worktree remove --force ${shellEscape(child.worktree)}`,
    { allowFailure: true }
  );

  if (remove.exitCode !== 0) {
    await rm(child.worktree, { recursive: true, force: true });
    messages.push(`${child.id}:worktree_removed_fallback`);
  } else {
    messages.push(`${child.id}:worktree_removed`);
  }
}

export async function cleanupTasks(
  config: ZoeConfig,
  runner: CommandRunner,
  input: CleanupInput
): Promise<CommandOutput> {
  const registry = await loadRegistry(config.registryPath);
  const messages: string[] = [];

  const parents = registry.tasks.filter(isParentTask);
  const toRemove = new Set<string>();
  const archived: TaskRecord[] = [];

  for (const parent of parents) {
    if (!isTerminalStatus(parent.status)) {
      continue;
    }

    if (parent.status === 'done' && parent.winnerPrNumber) {
      const merged = await isPrMerged(runner, parent.winnerPrNumber, config.repoPath);
      if (!merged) {
        continue;
      }
    }

    const children = registry.tasks.filter((task) => isChildTask(task) && task.parentId === parent.id);

    if (input.dryRun) {
      messages.push(`${parent.id}:would_archive`);
      continue;
    }

    await appendHistory(config.historyPath, parent);
    archived.push(parent);
    toRemove.add(parent.id);
    messages.push(`${parent.id}:archived`);

    for (const child of children) {
      await appendHistory(config.historyPath, child);
      archived.push(child);
      toRemove.add(child.id);
      await removeChildWorktree(config, runner, child, messages);
    }
  }

  if (!input.dryRun) {
    const remaining = registry.tasks.filter((task) => !toRemove.has(task.id));
    await saveRegistry(config.registryPath, { tasks: remaining });
  }

  return {
    updatedTasks: archived,
    messages
  };
}

export async function getStatus(config: ZoeConfig, taskId?: string): Promise<TaskRecord[]> {
  const registry = await loadRegistry(config.registryPath);
  if (!taskId) {
    return registry.tasks;
  }

  const selected = registry.tasks.find((task) => task.id === taskId);
  if (!selected) {
    return [];
  }

  if (selected.kind === 'parent') {
    return registry.tasks.filter((task) => task.id === selected.id || task.parentId === selected.id);
  }

  return registry.tasks.filter((task) => task.id === selected.id || task.id === selected.parentId);
}
