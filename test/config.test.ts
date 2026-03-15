import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    repoPath: '/tmp/repo',
    worktreeRoot: '/tmp/worktrees',
    mainBranch: 'main',
    installCommand: '',
    allowedAgents: ['codex', 'gemini', 'claude'],
    agentLaunchCommands: {
      codex: 'codex -p "{prompt}"',
      gemini: 'gemini -p "{prompt}"',
      claude: 'claude -p "{prompt}"'
    },
    uiAgent: 'gemini',
    reviewerBotLogins: ['codex-reviewer[bot]', 'gemini-reviewer[bot]', 'claude-reviewer[bot]'],
    requiredApprovals: 3,
    uiPathGlobs: ['src/**/*.tsx'],
    criticalTagPattern: '\\[critical\\]',
    maxRetries: 3,
    pollIntervalMinutes: 10,
    registryPath: '.autobot/active-tasks.json',
    historyPath: '.autobot/task-history.jsonl',
    retryDir: '.autobot/retries',
    lockPath: '.autobot/check.lock',
    ...overrides
  };
}

async function writeConfigFile(config: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zoe-config-'));
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

describe('loadConfig strict trio validation', () => {
  test('accepts strict trio config', async () => {
    const configPath = await writeConfigFile(makeConfig());
    const loaded = await loadConfig(configPath);
    expect(loaded.allowedAgents).toEqual(['codex', 'gemini', 'claude']);
    expect(loaded.requiredApprovals).toBe(3);
  });

  test('rejects non-trio requiredApprovals', async () => {
    const configPath = await writeConfigFile(makeConfig({ requiredApprovals: 2 }));
    await expect(loadConfig(configPath)).rejects.toThrow(/requiredApprovals must be exactly 3/);
  });

  test('rejects missing launch command for trio member', async () => {
    const configPath = await writeConfigFile(
      makeConfig({
        agentLaunchCommands: {
          codex: 'codex -p "{prompt}"',
          gemini: 'gemini -p "{prompt}"'
        }
      })
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/agentLaunchCommands must contain exactly/);
  });

  test('rejects reviewer bot list that is not the canonical trio', async () => {
    const configPath = await writeConfigFile(
      makeConfig({ reviewerBotLogins: ['codex-reviewer[bot]', 'gemini-reviewer[bot]', 'other-reviewer[bot]'] })
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/reviewerBotLogins must contain exactly/);
  });
});
