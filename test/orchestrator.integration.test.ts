import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { checkTasks, spawnTask } from '../src/orchestrator.js';
import { CommandResult, CommandRunner, TaskRecord, ZoeConfig } from '../src/types.js';

class MockRunner implements CommandRunner {
  public calls: string[] = [];
  private rules: Array<{ match: RegExp; handler: (command: string) => CommandResult }> = [];

  when(match: RegExp, result: CommandResult | ((command: string) => CommandResult)): void {
    const handler = typeof result === 'function' ? result : () => result;
    this.rules.push({ match, handler });
  }

  async run(command: string): Promise<CommandResult> {
    this.calls.push(command);
    for (const rule of this.rules) {
      if (rule.match.test(command)) {
        return rule.handler(command);
      }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

async function makeConfig(root: string): Promise<ZoeConfig> {
  const autobotDir = path.join(root, '.autobot');
  await mkdir(autobotDir, { recursive: true });

  const registryPath = path.join(autobotDir, 'active-tasks.json');
  await writeFile(registryPath, JSON.stringify({ tasks: [] }, null, 2));

  return {
    repoPath: path.join(root, 'repo'),
    worktreeRoot: path.join(root, 'worktrees'),
    mainBranch: 'main',
    installCommand: 'pnpm install',
    allowedAgents: ['codex', 'gemini', 'claude'],
    agentLaunchCommands: {
      codex: 'codex -p "{prompt}"',
      gemini: 'gemini -p "{prompt}"',
      claude: 'claude -p "{prompt}"'
    },
    reviewerBotLogins: ['codex-reviewer[bot]', 'gemini-reviewer[bot]', 'claude-reviewer[bot]'],
    requiredApprovals: 3,
    uiPathGlobs: ['src/**/*.tsx'],
    criticalTagPattern: '\\[critical\\]',
    maxRetries: 3,
    pollIntervalMinutes: 10,
    registryPath,
    historyPath: path.join(autobotDir, 'task-history.jsonl'),
    retryDir: path.join(autobotDir, 'retries'),
    lockPath: path.join(autobotDir, 'check.lock')
  };
}

function makeParentTask(id: string, startedAt: number): TaskRecord {
  return {
    id,
    kind: 'parent',
    description: 'Task',
    repo: 'repo',
    childIds: [`${id}--codex`, `${id}--gemini`, `${id}--claude`],
    status: 'running',
    retryCount: 0,
    startedAt,
    updatedAt: startedAt,
    note: 'Trio swarm in progress.'
  };
}

function makeChildTask(parentId: string, agent: 'codex' | 'gemini' | 'claude', startedAt: number): TaskRecord {
  return {
    id: `${parentId}--${agent}`,
    kind: 'child',
    parentId,
    description: 'Task',
    agent,
    repo: 'repo',
    branch: `feat/${parentId}-${agent}`,
    worktree: `/tmp/${parentId}-${agent}`,
    tmuxSession: `zoe-${parentId}-${agent}`,
    promptFile: '/tmp/prompt.md',
    status: 'running',
    retryCount: 0,
    startedAt,
    updatedAt: startedAt
  };
}

describe('orchestrator integration', () => {
  let root: string;
  let config: ZoeConfig;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'zoe-'));
    config = await makeConfig(root);
    await mkdir(config.repoPath, { recursive: true });
  });

  test('spawn creates one parent and three child tasks', async () => {
    const promptFile = path.join(root, 'prompt.md');
    await writeFile(promptFile, 'build feature');

    const runner = new MockRunner();

    const result = await spawnTask(config, runner, {
      id: 'feat-custom-templates',
      description: 'Custom templates',
      promptFile
    });

    expect(result.messages[0]).toBe('spawned_parent:feat-custom-templates');
    expect(result.messages.filter((line) => line.startsWith('spawned_child:')).length).toBe(3);

    const saved = JSON.parse(await readFile(config.registryPath, 'utf8')) as { tasks: TaskRecord[] };
    const parent = saved.tasks.find((task) => task.id === 'feat-custom-templates');
    const children = saved.tasks.filter((task) => task.parentId === 'feat-custom-templates');

    expect(parent?.kind).toBe('parent');
    expect(children.length).toBe(3);
    expect(new Set(children.map((task) => task.agent))).toEqual(new Set(['codex', 'gemini', 'claude']));

    const launches = runner.calls.filter((command) => command.includes('tmux new-session'));
    expect(launches.length).toBe(3);
  });

  test('check retries only the failed child', async () => {
    const now = Date.now();
    await writeFile('/tmp/prompt.md', 'retry task');
    const parent = makeParentTask('t-retry', now);
    const codex = { ...makeChildTask('t-retry', 'codex', now), pr: { number: 101, url: 'https://example/pr/101' } };
    const gemini = { ...makeChildTask('t-retry', 'gemini', now), pr: { number: 102, url: 'https://example/pr/102' } };
    const claude = { ...makeChildTask('t-retry', 'claude', now), pr: { number: 103, url: 'https://example/pr/103' } };

    await writeFile(config.registryPath, JSON.stringify({ tasks: [parent, codex, gemini, claude] }, null, 2));

    const runner = new MockRunner();
    runner.when(/tmux has-session/, { stdout: '', stderr: '', exitCode: 0 });

    runner.when(/gh pr view 101 --json number,url,state,mergeStateStatus,body,isDraft,reviews,comments,files/, {
      stdout: JSON.stringify({
        number: 101,
        url: 'https://example/pr/101',
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        body: 'no ui',
        isDraft: false,
        reviews: [],
        comments: [],
        files: [{ path: 'server/index.ts' }]
      }),
      stderr: '',
      exitCode: 0
    });
    runner.when(/gh pr checks 101/, {
      stdout: JSON.stringify([{ name: 'test', state: 'FAILURE' }]),
      stderr: '',
      exitCode: 0
    });

    const waitingPr = (number: number) => ({
      stdout: JSON.stringify({
        number,
        url: `https://example/pr/${number}`,
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        body: 'no ui',
        isDraft: false,
        reviews: [],
        comments: [],
        files: [{ path: 'server/index.ts' }]
      }),
      stderr: '',
      exitCode: 0
    });

    runner.when(/gh pr view 102 --json number,url,state,mergeStateStatus,body,isDraft,reviews,comments,files/, waitingPr(102));
    runner.when(/gh pr checks 102/, {
      stdout: JSON.stringify([{ name: 'test', state: 'IN_PROGRESS' }]),
      stderr: '',
      exitCode: 0
    });

    runner.when(/gh pr view 103 --json number,url,state,mergeStateStatus,body,isDraft,reviews,comments,files/, waitingPr(103));
    runner.when(/gh pr checks 103/, {
      stdout: JSON.stringify([{ name: 'test', state: 'IN_PROGRESS' }]),
      stderr: '',
      exitCode: 0
    });

    const result = await checkTasks(config, runner);
    expect(result.messages).toEqual([]);

    const saved = JSON.parse(await readFile(config.registryPath, 'utf8')) as { tasks: TaskRecord[] };
    const codexAfter = saved.tasks.find((task) => task.id === 't-retry--codex');
    const geminiAfter = saved.tasks.find((task) => task.id === 't-retry--gemini');
    const claudeAfter = saved.tasks.find((task) => task.id === 't-retry--claude');

    expect(codexAfter?.retryCount).toBe(1);
    expect(codexAfter?.status).toBe('running');
    expect(geminiAfter?.retryCount).toBe(0);
    expect(claudeAfter?.retryCount).toBe(0);

    const launches = runner.calls.filter((command) => command.includes('tmux new-session'));
    expect(launches.length).toBe(1);
  });

  test('first fully-passing child becomes winner and others are superseded', async () => {
    const now = Date.now();
    const parent = makeParentTask('t-winner', now);
    const codex = { ...makeChildTask('t-winner', 'codex', now), pr: { number: 201, url: 'https://example/pr/201' } };
    const gemini = { ...makeChildTask('t-winner', 'gemini', now), pr: { number: 202, url: 'https://example/pr/202' } };
    const claude = { ...makeChildTask('t-winner', 'claude', now), pr: { number: 203, url: 'https://example/pr/203' } };
    await writeFile(config.registryPath, JSON.stringify({ tasks: [parent, codex, gemini, claude] }, null, 2));

    const runner = new MockRunner();
    runner.when(/tmux has-session/, { stdout: '', stderr: '', exitCode: 0 });

    runner.when(/gh pr view 201 --json number,url,state,mergeStateStatus,body,isDraft,reviews,comments,files/, {
      stdout: JSON.stringify({
        number: 201,
        url: 'https://example/pr/201',
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        body: 'no ui',
        isDraft: false,
        reviews: [
          { author: { login: 'codex-reviewer[bot]' }, state: 'APPROVED' },
          { author: { login: 'gemini-reviewer[bot]' }, state: 'APPROVED' },
          { author: { login: 'claude-reviewer[bot]' }, state: 'APPROVED' }
        ],
        comments: [],
        files: [{ path: 'server/index.ts' }]
      }),
      stderr: '',
      exitCode: 0
    });
    runner.when(/gh pr checks 201/, {
      stdout: JSON.stringify([{ name: 'lint', state: 'SUCCESS' }, { name: 'test', state: 'SUCCESS' }]),
      stderr: '',
      exitCode: 0
    });

    const pendingPr = (number: number) => ({
      stdout: JSON.stringify({
        number,
        url: `https://example/pr/${number}`,
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        body: 'no ui',
        isDraft: false,
        reviews: [],
        comments: [],
        files: [{ path: 'server/index.ts' }]
      }),
      stderr: '',
      exitCode: 0
    });
    runner.when(/gh pr view 202 --json number,url,state,mergeStateStatus,body,isDraft,reviews,comments,files/, pendingPr(202));
    runner.when(/gh pr checks 202/, {
      stdout: JSON.stringify([{ name: 'test', state: 'IN_PROGRESS' }]),
      stderr: '',
      exitCode: 0
    });
    runner.when(/gh pr view 203 --json number,url,state,mergeStateStatus,body,isDraft,reviews,comments,files/, pendingPr(203));
    runner.when(/gh pr checks 203/, {
      stdout: JSON.stringify([{ name: 'test', state: 'IN_PROGRESS' }]),
      stderr: '',
      exitCode: 0
    });

    const result = await checkTasks(config, runner);
    expect(result.messages).toEqual(['ready_for_human:t-winner:winner=t-winner--codex:pr=201']);

    const saved = JSON.parse(await readFile(config.registryPath, 'utf8')) as { tasks: TaskRecord[] };
    const parentAfter = saved.tasks.find((task) => task.id === 't-winner');
    const codexAfter = saved.tasks.find((task) => task.id === 't-winner--codex');
    const geminiAfter = saved.tasks.find((task) => task.id === 't-winner--gemini');
    const claudeAfter = saved.tasks.find((task) => task.id === 't-winner--claude');

    expect(parentAfter?.status).toBe('ready_for_human');
    expect(parentAfter?.winnerChildId).toBe('t-winner--codex');
    expect(codexAfter?.status).toBe('ready_for_human');
    expect(geminiAfter?.status).toBe('superseded');
    expect(claudeAfter?.status).toBe('superseded');
  });

  test('parent and winner move to done only after merge', async () => {
    const now = Date.now();
    const parent: TaskRecord = {
      ...makeParentTask('t-merge', now),
      status: 'ready_for_human',
      winnerChildId: 't-merge--codex',
      winnerPrNumber: 301,
      winnerSelectedAt: now,
      note: 'Winner selected: t-merge--codex (PR #301).'
    };
    const codex: TaskRecord = {
      ...makeChildTask('t-merge', 'codex', now),
      status: 'ready_for_human',
      pr: { number: 301, url: 'https://example/pr/301' },
      gatePassedAt: now
    };
    const gemini: TaskRecord = { ...makeChildTask('t-merge', 'gemini', now), status: 'superseded' };
    const claude: TaskRecord = { ...makeChildTask('t-merge', 'claude', now), status: 'superseded' };

    await writeFile(config.registryPath, JSON.stringify({ tasks: [parent, codex, gemini, claude] }, null, 2));

    const runner = new MockRunner();
    runner.when(/gh pr view 301 --json mergedAt/, {
      stdout: JSON.stringify({ mergedAt: '2026-03-15T12:00:00Z' }),
      stderr: '',
      exitCode: 0
    });

    const result = await checkTasks(config, runner);
    expect(result.messages).toEqual([]);

    const saved = JSON.parse(await readFile(config.registryPath, 'utf8')) as { tasks: TaskRecord[] };
    const parentAfter = saved.tasks.find((task) => task.id === 't-merge');
    const winnerAfter = saved.tasks.find((task) => task.id === 't-merge--codex');

    expect(parentAfter?.status).toBe('done');
    expect(winnerAfter?.status).toBe('done');
  });

  test('parent is blocked and actionable when all children are blocked', async () => {
    const now = Date.now();
    const parent = makeParentTask('t-blocked', now);
    const codex: TaskRecord = { ...makeChildTask('t-blocked', 'codex', now), status: 'blocked' };
    const gemini: TaskRecord = { ...makeChildTask('t-blocked', 'gemini', now), status: 'blocked' };
    const claude: TaskRecord = { ...makeChildTask('t-blocked', 'claude', now), status: 'blocked' };

    await writeFile(config.registryPath, JSON.stringify({ tasks: [parent, codex, gemini, claude] }, null, 2));

    const runner = new MockRunner();
    const result = await checkTasks(config, runner);

    expect(result.messages).toEqual(['attention_required:t-blocked:all_children_blocked']);

    const saved = JSON.parse(await readFile(config.registryPath, 'utf8')) as { tasks: TaskRecord[] };
    const parentAfter = saved.tasks.find((task) => task.id === 't-blocked');
    expect(parentAfter?.status).toBe('blocked');
  });
});
