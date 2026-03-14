import { CommandRunner, GHPRChecks, GHPRView } from './types.js';

function parseJsonArray<T>(raw: string): T[] {
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function parseJsonObject<T>(raw: string): T | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as T;
}

export async function findPrByBranch(
  runner: CommandRunner,
  branch: string,
  repoPath?: string
): Promise<GHPRView | undefined> {
  const cmd = `gh pr list --head ${shellEscape(branch)} --json number,url,state,mergeStateStatus,body,isDraft`;
  const result = await runner.run(cmd, { allowFailure: true, cwd: repoPath });
  if (result.exitCode !== 0) {
    return undefined;
  }

  const prs = parseJsonArray<GHPRView>(result.stdout);
  return prs[0];
}

export async function getPrView(
  runner: CommandRunner,
  prNumber: number,
  repoPath?: string
): Promise<GHPRView | undefined> {
  const cmd = `gh pr view ${prNumber} --json number,url,state,mergeStateStatus,body,isDraft,reviews,comments,files`;
  const result = await runner.run(cmd, { allowFailure: true, cwd: repoPath });
  if (result.exitCode !== 0) {
    return undefined;
  }

  return parseJsonObject<GHPRView>(result.stdout);
}

export async function getPrChecks(runner: CommandRunner, prNumber: number, repoPath?: string): Promise<GHPRChecks[]> {
  const cmd = `gh pr checks ${prNumber} --json name,state,link`;
  const result = await runner.run(cmd, { allowFailure: true, cwd: repoPath });
  if (result.exitCode !== 0) {
    return [];
  }

  return parseJsonArray<GHPRChecks>(result.stdout);
}

export async function isPrMerged(runner: CommandRunner, prNumber: number, repoPath?: string): Promise<boolean> {
  const cmd = `gh pr view ${prNumber} --json mergedAt`;
  const result = await runner.run(cmd, { allowFailure: true, cwd: repoPath });
  if (result.exitCode !== 0) {
    return false;
  }

  const parsed = parseJsonObject<{ mergedAt?: string }>(result.stdout);
  return !!parsed?.mergedAt;
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
