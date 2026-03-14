import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { checkTasks, spawnTask } from '../src/orchestrator.js';
import { CommandResult, CommandRunner, ZoeConfig } from '../src/types.js';

class MockRunner implements CommandRunner {
  public calls: string[] = [];
  private rules: Array<{ match: RegExp; result: CommandResult }> = [];

  when(match: RegExp, result: CommandResult): void {
    this.rules.push({ match, result });
  }

  async run(command: string): Promise<CommandResult> {
    this.calls.push(command);
    for (const rule of this.rules) {
      if (rule.match.test(command)) {
        return rule.result;
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
    allowedAgents: ['codex'],
    agentLaunchCommands: {
      codex: 'codex -p "{prompt}"'
    },
    reviewerBotLogins: ['codex-reviewer[bot]', 'gemini-reviewer[bot]', 'claude-reviewer[bot]'],
    requiredApprovals: 2,
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

describe('orchestrator integration', () => {
  let root: string;
  let config: ZoeConfig;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'zoe-'));
    config = await makeConfig(root);
    await mkdir(config.repoPath, { recursive: true });
  });

  test('spawn creates registry task and launches tmux', async () => {
    const promptFile = path.join(root, 'prompt.md');
    await writeFile(promptFile, 'build feature');

    const runner = new MockRunner();

    const result = await spawnTask(config, runner, {
      id: 'feat-custom-templates',
      agent: 'codex',
      description: 'Custom templates',
      promptFile
    });

    expect(result.messages).toContain('spawned:feat-custom-templates');
    expect(runner.calls.some((c) => c.includes('git -C'))).toBe(true);
    expect(runner.calls.some((c) => c.includes('tmux new-session'))).toBe(true);

    const saved = JSON.parse(await readFile(config.registryPath, 'utf8')) as { tasks: Array<{ id: string }> };
    expect(saved.tasks[0].id).toBe('feat-custom-templates');
  });

  test('check transitions task to ready_for_human when gate passes', async () => {
    const promptFile = path.join(root, 'prompt.md');
    await writeFile(promptFile, 'do task');

    const existing = {
      tasks: [
        {
          id: 't1',
          description: 'Task',
          agent: 'codex',
          repo: 'repo',
          branch: 'feat/t1',
          worktree: path.join(root, 'worktrees', 't1'),
          tmuxSession: 'zoe-t1',
          promptFile,
          status: 'running',
          retryCount: 0,
          startedAt: Date.now(),
          updatedAt: Date.now()
        }
      ]
    };
    await writeFile(config.registryPath, JSON.stringify(existing, null, 2));

    const runner = new MockRunner();
    runner.when(/tmux has-session/, { stdout: '', stderr: '', exitCode: 0 });
    runner.when(/gh pr list/, {
      stdout: JSON.stringify([{ number: 42, url: 'https://example/pr/42', state: 'OPEN', mergeStateStatus: 'CLEAN', body: 'x' }]),
      stderr: '',
      exitCode: 0
    });
    runner.when(/gh pr view 42 --json number,url,state,mergeStateStatus,body,isDraft,reviews,comments,files/, {
      stdout: JSON.stringify({
        number: 42,
        url: 'https://example/pr/42',
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        body: '![img](https://img)',
        isDraft: false,
        reviews: [
          { author: { login: 'codex-reviewer[bot]' }, state: 'APPROVED' },
          { author: { login: 'gemini-reviewer[bot]' }, state: 'APPROVED' }
        ],
        comments: [],
        files: [{ path: 'src/ui/button.tsx' }]
      }),
      stderr: '',
      exitCode: 0
    });
    runner.when(/gh pr checks 42/, {
      stdout: JSON.stringify([
        { name: 'lint', state: 'SUCCESS' },
        { name: 'test', state: 'SUCCESS' }
      ]),
      stderr: '',
      exitCode: 0
    });

    const result = await checkTasks(config, runner);
    expect(result.messages.some((m) => m.includes('ready_for_human'))).toBe(true);

    const saved = JSON.parse(await readFile(config.registryPath, 'utf8')) as { tasks: Array<{ status: string }> };
    expect(saved.tasks[0].status).toBe('ready_for_human');
  });

  test('check auto-retries on ci failure', async () => {
    const promptFile = path.join(root, 'prompt.md');
    await writeFile(promptFile, 'do task');

    const existing = {
      tasks: [
        {
          id: 't2',
          description: 'Task',
          agent: 'codex',
          repo: 'repo',
          branch: 'feat/t2',
          worktree: path.join(root, 'worktrees', 't2'),
          tmuxSession: 'zoe-t2',
          promptFile,
          pr: { number: 77, url: 'https://example/pr/77' },
          status: 'running',
          retryCount: 0,
          startedAt: Date.now(),
          updatedAt: Date.now()
        }
      ]
    };
    await writeFile(config.registryPath, JSON.stringify(existing, null, 2));

    const runner = new MockRunner();
    runner.when(/tmux has-session/, { stdout: '', stderr: '', exitCode: 0 });
    runner.when(/gh pr view 77 --json number,url,state,mergeStateStatus,body,isDraft,reviews,comments,files/, {
      stdout: JSON.stringify({
        number: 77,
        url: 'https://example/pr/77',
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
    runner.when(/gh pr checks 77/, {
      stdout: JSON.stringify([{ name: 'test', state: 'FAILURE' }]),
      stderr: '',
      exitCode: 0
    });
    runner.when(/tmux kill-session/, { stdout: '', stderr: '', exitCode: 1 });
    runner.when(/tmux new-session/, { stdout: '', stderr: '', exitCode: 0 });

    const result = await checkTasks(config, runner);
    expect(result.messages.some((m) => m.includes('auto_retry:ci_failed'))).toBe(true);

    const saved = JSON.parse(await readFile(config.registryPath, 'utf8')) as {
      tasks: Array<{ status: string; retryCount: number }>;
    };
    expect(saved.tasks[0].status).toBe('running');
    expect(saved.tasks[0].retryCount).toBe(1);
  });
});
