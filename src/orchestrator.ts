import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyCiState, evaluatePullRequestGate, summarizeReviews } from './gates.js';
import { findPrByBranch, getPrChecks, getPrView, isPrMerged, shellEscape } from './gh.js';
import { computeRetryOutcome, isTerminalStatus } from './state.js';
import { appendHistory, getTask, loadRegistry, saveRegistry, upsertTask } from './store.js';
import {
  CommandRunner,
  RetryReason,
  TaskRecord,
  TaskRegistry,
  TaskStatus,
  ZoeConfig
} from './types.js';

export interface SpawnInput {
  id: string;
  agent: string;
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

export async function spawnTask(config: ZoeConfig, runner: CommandRunner, input: SpawnInput): Promise<CommandOutput> {
  validateSpawnInput(config, input);
  await access(input.promptFile);

  const registry = await loadRegistry(config.registryPath);
  if (getTask(registry, input.id)) {
    throw new Error(`Task already exists: ${input.id}`);
  }

  const branch = `feat/${toBranchSegment(input.id)}`;
  const worktree = path.join(config.worktreeRoot, input.id);
  const tmuxSession = `zoe-${toSessionSegment(input.id)}`;
  const now = Date.now();

  await mkdir(config.worktreeRoot, { recursive: true });
  await runner.run(
    `git -C ${shellEscape(config.repoPath)} worktree add ${shellEscape(worktree)} -b ${shellEscape(branch)} ${shellEscape(`origin/${config.mainBranch}`)}`
  );

  if (config.installCommand && config.installCommand.trim() !== '') {
    await runner.run(config.installCommand, { cwd: worktree });
  }

  const task: TaskRecord = {
    id: input.id,
    description: input.description,
    agent: input.agent,
    repo: path.basename(config.repoPath),
    branch,
    worktree,
    tmuxSession,
    promptFile: path.resolve(input.promptFile),
    status: 'running',
    retryCount: 0,
    startedAt: now,
    updatedAt: now,
    note: 'Spawned and started agent session.'
  };

  await launchAgentSession(config, runner, task);

  const nextRegistry = upsertTask(registry, task);
  await saveRegistry(config.registryPath, nextRegistry);

  return {
    updatedTasks: [task],
    messages: [
      `spawned:${task.id}`,
      `session:${task.tmuxSession}`,
      `branch:${task.branch}`
    ]
  };
}

export async function checkTasks(
  config: ZoeConfig,
  runner: CommandRunner,
  taskId?: string
): Promise<CommandOutput> {
  const registry = await loadRegistry(config.registryPath);
  const tasks = taskId ? registry.tasks.filter((task) => task.id === taskId) : registry.tasks;

  const messages: string[] = [];
  let nextRegistry: TaskRegistry = { tasks: [...registry.tasks] };
  const updatedTasks: TaskRecord[] = [];

  for (const task of tasks) {
    if (isTerminalStatus(task.status)) {
      continue;
    }

    const result = await checkSingleTask(config, runner, task);
    if (!result.changed) {
      continue;
    }

    nextRegistry = upsertTask(nextRegistry, result.task);
    updatedTasks.push(result.task);
    messages.push(...result.messages.map((msg) => `${task.id}:${msg}`));
  }

  if (updatedTasks.length > 0) {
    await saveRegistry(config.registryPath, nextRegistry);
  }

  return { updatedTasks, messages };
}

interface CheckTaskResult {
  changed: boolean;
  task: TaskRecord;
  messages: string[];
}

async function checkSingleTask(
  config: ZoeConfig,
  runner: CommandRunner,
  task: TaskRecord
): Promise<CheckTaskResult> {
  let nextTask = { ...task };
  const messages: string[] = [];

  const sessionAlive = await isSessionAlive(runner, task.tmuxSession);
  if (!sessionAlive) {
    return await handleActionableFailure(config, runner, nextTask, 'session_died', 'tmux session not found');
  }

  let pr = task.pr;
  if (!pr) {
    const listed = await findPrByBranch(runner, task.branch, config.repoPath);
    if (!listed) {
      nextTask = setTaskStatus(nextTask, 'running', 'Waiting for PR creation.');
      return {
        changed: hasTaskChanged(task, nextTask),
        task: nextTask,
        messages: ['waiting_for_pr']
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
    messages.push(`pr_found#${pr.number}`);
  }

  const fullPr = await getPrView(runner, pr.number, config.repoPath);
  if (!fullPr) {
    nextTask = setTaskStatus(nextTask, 'running', 'PR metadata temporarily unavailable.');
    return {
      changed: hasTaskChanged(task, nextTask),
      task: nextTask,
      messages: [...messages, 'pr_unavailable']
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
      task: nextTask,
      messages: [...messages, 'branch_not_synced']
    };
  }

  const ciState = classifyCiState(checks);
  if (ciState === 'pending') {
    nextTask = setTaskStatus(nextTask, 'waiting_ci', 'CI is still running.');
    return {
      changed: hasTaskChanged(task, nextTask),
      task: nextTask,
      messages: [...messages, 'ci_pending']
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
      task: nextTask,
      messages: [...messages, 'screenshot_missing']
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
      task: nextTask,
      messages: [...messages, 'waiting_bot_approvals']
    };
  }

  nextTask = setTaskStatus(
    nextTask,
    'ready_for_human',
    `PR #${fullPr.number} ready. CI passed, approvals ${gate.approvalCount}/${config.requiredApprovals}, retries ${nextTask.retryCount}.`
  );

  return {
    changed: hasTaskChanged(task, nextTask),
    task: nextTask,
    messages: [...messages, 'ready_for_human']
  };
}

async function handleActionableFailure(
  config: ZoeConfig,
  runner: CommandRunner,
  task: TaskRecord,
  reason: RetryReason,
  detail: string
): Promise<CheckTaskResult> {
  const outcome = computeRetryOutcome(task.retryCount, config.maxRetries, reason);
  const messages: string[] = [];

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
      task: blockedTask,
      messages: [`blocked:${reason}`]
    };
  }

  const deltaFile = await writeRetryDelta(config, task.id, outcome.nextRetryCount, reason, detail);
  const retryTask: TaskRecord = {
    ...task,
    retryCount: outcome.nextRetryCount,
    lastFailureReason: reason,
    note: `Auto-retry #${outcome.nextRetryCount} triggered by ${reason}.`,
    updatedAt: Date.now(),
    status: 'running'
  };

  await launchAgentSession(config, runner, retryTask, deltaFile);
  messages.push(`auto_retry:${reason}:attempt_${outcome.nextRetryCount}`);

  return {
    changed: true,
    task: retryTask,
    messages
  };
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

function summarizeFailingChecks(checks: Array<{ name: string; state: string }>): string {
  const failed = checks.filter((check) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(check.state));
  if (failed.length === 0) {
    return 'CI failed.';
  }

  return `CI failed checks: ${failed.map((check) => `${check.name}(${check.state})`).join(', ')}`;
}

function setTaskStatus(task: TaskRecord, status: TaskStatus, note: string): TaskRecord {
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

async function launchAgentSession(
  config: ZoeConfig,
  runner: CommandRunner,
  task: TaskRecord,
  deltaFile?: string
): Promise<void> {
  const template = config.agentLaunchCommands[task.agent];
  if (!template) {
    throw new Error(`Missing launch command template for agent: ${task.agent}`);
  }

  const prompt = await buildPrompt(task.promptFile, deltaFile);
  const command = renderLaunchCommand(template, {
    id: task.id,
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

async function buildPrompt(promptFile: string, deltaFile?: string): Promise<string> {
  const basePrompt = await readFile(promptFile, 'utf8');
  if (!deltaFile) {
    return basePrompt.trim();
  }

  const deltaPrompt = await readFile(deltaFile, 'utf8');
  return `${basePrompt.trim()}\n\n${deltaPrompt.trim()}`;
}

function validateSpawnInput(config: ZoeConfig, input: SpawnInput): void {
  if (!input.id || !input.agent || !input.description || !input.promptFile) {
    throw new Error('spawn requires --id, --agent, --description, --prompt-file');
  }

  if (!config.allowedAgents.includes(input.agent)) {
    throw new Error(`Agent ${input.agent} is not allowed.`);
  }

  if (!config.agentLaunchCommands[input.agent]) {
    throw new Error(`Missing launch command template for agent ${input.agent}.`);
  }
}

function toBranchSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function toSessionSegment(value: string): string {
  return toBranchSegment(value).slice(0, 40);
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

  const outcome = computeRetryOutcome(task.retryCount, config.maxRetries, 'manual');
  if (outcome.blocked) {
    const blocked = {
      ...task,
      status: 'blocked' as TaskStatus,
      note: `Manual retry denied: max retries reached (${config.maxRetries}).`,
      updatedAt: Date.now()
    };
    const updatedRegistry = upsertTask(registry, blocked);
    await saveRegistry(config.registryPath, updatedRegistry);
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
    updatedAt: Date.now()
  };

  await launchAgentSession(config, runner, nextTask, deltaPath);

  const updatedRegistry = upsertTask(registry, nextTask);
  await saveRegistry(config.registryPath, updatedRegistry);

  return {
    updatedTasks: [nextTask],
    messages: [`${nextTask.id}:manual_retry:${outcome.nextRetryCount}`]
  };
}

export async function cleanupTasks(
  config: ZoeConfig,
  runner: CommandRunner,
  input: CleanupInput
): Promise<CommandOutput> {
  const registry = await loadRegistry(config.registryPath);
  const remaining: TaskRecord[] = [];
  const archived: TaskRecord[] = [];
  const messages: string[] = [];

  for (const task of registry.tasks) {
    if (!isTerminalStatus(task.status)) {
      remaining.push(task);
      continue;
    }

    if (task.status === 'done' && task.pr?.number) {
      const merged = await isPrMerged(runner, task.pr.number, config.repoPath);
      if (!merged) {
        remaining.push(task);
        continue;
      }
    }

    archived.push(task);

    if (input.dryRun) {
      messages.push(`${task.id}:would_archive`);
      continue;
    }

    await appendHistory(config.historyPath, task);
    messages.push(`${task.id}:archived`);

    const remove = await runner.run(
      `git -C ${shellEscape(config.repoPath)} worktree remove --force ${shellEscape(task.worktree)}`,
      { allowFailure: true }
    );

    if (remove.exitCode !== 0) {
      await rm(task.worktree, { recursive: true, force: true });
      messages.push(`${task.id}:worktree_removed_fallback`);
    } else {
      messages.push(`${task.id}:worktree_removed`);
    }
  }

  if (!input.dryRun) {
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
  return registry.tasks.filter((task) => task.id === taskId);
}
