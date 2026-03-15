import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ZoeConfig } from './types.js';

const DEFAULT_CONFIG_PATH = '.autobot/config.json';

function mustString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid config: ${key} must be a non-empty string`);
  }
  return value;
}

function mustStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw new Error(`Invalid config: ${key} must be a string array`);
  }
  return value;
}

function mustNumber(value: unknown, key: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Invalid config: ${key} must be a number`);
  }
  return value;
}

function mustStringMap(value: unknown, key: string): Record<string, string> {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid config: ${key} must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, v]) => typeof v !== 'string' || v.trim() === '')) {
    throw new Error(`Invalid config: ${key} must be a map of strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<ZoeConfig> {
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const config: ZoeConfig = {
    repoPath: path.resolve(mustString(parsed.repoPath, 'repoPath')),
    worktreeRoot: path.resolve(mustString(parsed.worktreeRoot, 'worktreeRoot')),
    mainBranch: mustString(parsed.mainBranch, 'mainBranch'),
    installCommand: typeof parsed.installCommand === 'string' ? parsed.installCommand : undefined,
    allowedAgents: mustStringArray(parsed.allowedAgents, 'allowedAgents'),
    agentLaunchCommands: mustStringMap(parsed.agentLaunchCommands, 'agentLaunchCommands'),
    uiAgent: typeof parsed.uiAgent === 'string' && parsed.uiAgent.trim() !== '' ? parsed.uiAgent : undefined,
    reviewerBotLogins: mustStringArray(parsed.reviewerBotLogins, 'reviewerBotLogins'),
    requiredApprovals: mustNumber(parsed.requiredApprovals, 'requiredApprovals'),
    uiPathGlobs: mustStringArray(parsed.uiPathGlobs, 'uiPathGlobs'),
    criticalTagPattern: mustString(parsed.criticalTagPattern, 'criticalTagPattern'),
    maxRetries: mustNumber(parsed.maxRetries, 'maxRetries'),
    pollIntervalMinutes: mustNumber(parsed.pollIntervalMinutes, 'pollIntervalMinutes'),
    registryPath: path.resolve(mustString(parsed.registryPath, 'registryPath')),
    historyPath: path.resolve(mustString(parsed.historyPath, 'historyPath')),
    retryDir: path.resolve(mustString(parsed.retryDir, 'retryDir')),
    lockPath: path.resolve(mustString(parsed.lockPath, 'lockPath'))
  };

  return config;
}
