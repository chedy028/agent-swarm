import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentName, ZoeConfig } from './types.js';

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

function isAgentName(value: string): value is AgentName {
  return value === 'codex' || value === 'gemini' || value === 'claude';
}

function mustAgentArray(value: unknown, key: string): AgentName[] {
  const agents = mustStringArray(value, key);
  if (agents.some((agent) => !isAgentName(agent))) {
    throw new Error(`Invalid config: ${key} contains unsupported agent`);
  }
  return agents as AgentName[];
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

  const uiAgentRaw = typeof parsed.uiAgent === 'string' && parsed.uiAgent.trim() !== '' ? parsed.uiAgent : undefined;
  if (uiAgentRaw && !isAgentName(uiAgentRaw)) {
    throw new Error('Invalid config: uiAgent contains unsupported agent');
  }
  const uiAgent = uiAgentRaw as AgentName | undefined;

  const config: ZoeConfig = {
    repoPath: path.resolve(mustString(parsed.repoPath, 'repoPath')),
    worktreeRoot: path.resolve(mustString(parsed.worktreeRoot, 'worktreeRoot')),
    mainBranch: mustString(parsed.mainBranch, 'mainBranch'),
    installCommand: typeof parsed.installCommand === 'string' ? parsed.installCommand : undefined,
    allowedAgents: mustAgentArray(parsed.allowedAgents, 'allowedAgents'),
    agentLaunchCommands: mustStringMap(parsed.agentLaunchCommands, 'agentLaunchCommands'),
    uiAgent,
    reviewerBotLogins: mustStringArray(parsed.reviewerBotLogins, 'reviewerBotLogins'),
    requiredApprovals: mustNumber(parsed.requiredApprovals, 'requiredApprovals'),
    uiPathGlobs: mustStringArray(parsed.uiPathGlobs, 'uiPathGlobs'),
    criticalTagPattern: mustString(parsed.criticalTagPattern, 'criticalTagPattern'),
    maxRetries: mustNumber(parsed.maxRetries, 'maxRetries'),
    pollIntervalMinutes: mustNumber(parsed.pollIntervalMinutes, 'pollIntervalMinutes'),
    registryPath: path.resolve(mustString(parsed.registryPath, 'registryPath')),
    historyPath: path.resolve(mustString(parsed.historyPath, 'historyPath')),
    findingLogPath: path.resolve(mustString(parsed.findingLogPath, 'findingLogPath')),
    retryDir: path.resolve(mustString(parsed.retryDir, 'retryDir')),
    lockPath: path.resolve(mustString(parsed.lockPath, 'lockPath'))
  };

  validateStrictTrioConfig(config);
  return config;
}

function validateStrictTrioConfig(config: ZoeConfig): void {
  const expectedAgents: AgentName[] = ['codex', 'gemini', 'claude'];
  const expectedReviewers = ['codex-reviewer[bot]', 'gemini-reviewer[bot]', 'claude-reviewer[bot]'];

  assertExactSet(config.allowedAgents, expectedAgents, 'allowedAgents');
  assertExactSet(Object.keys(config.agentLaunchCommands), expectedAgents, 'agentLaunchCommands');
  assertExactSet(config.reviewerBotLogins.map((login) => login.toLowerCase()), expectedReviewers, 'reviewerBotLogins');

  if (config.requiredApprovals !== 3) {
    throw new Error('Invalid config: requiredApprovals must be exactly 3');
  }

  if (config.pollIntervalMinutes !== 10) {
    throw new Error('Invalid config: pollIntervalMinutes must be exactly 10');
  }
}

function assertExactSet(actual: string[], expected: string[], key: string): void {
  if (actual.length !== expected.length) {
    throw new Error(`Invalid config: ${key} must contain exactly ${expected.join(', ')}`);
  }

  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);

  for (const value of expectedSet) {
    if (!actualSet.has(value)) {
      throw new Error(`Invalid config: ${key} must contain exactly ${expected.join(', ')}`);
    }
  }
}
