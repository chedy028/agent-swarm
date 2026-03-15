import { describe, expect, test } from 'vitest';
import { evaluatePullRequestGate } from '../src/gates.js';
import { GHPRChecks, GHPRView, ZoeConfig } from '../src/types.js';

const baseConfig: ZoeConfig = {
  repoPath: '/tmp/repo',
  worktreeRoot: '/tmp/worktrees',
  mainBranch: 'main',
  installCommand: 'pnpm install',
  allowedAgents: ['codex', 'claude', 'gemini'],
  agentLaunchCommands: { codex: 'codex -p "{prompt}"', claude: 'claude -p "{prompt}"', gemini: 'gemini -p "{prompt}"' },
  reviewerBotLogins: ['codex-reviewer[bot]', 'gemini-reviewer[bot]', 'claude-reviewer[bot]'],
  requiredApprovals: 3,
  uiPathGlobs: ['src/**/*.tsx'],
  criticalTagPattern: '\\[critical\\]',
  maxRetries: 3,
  pollIntervalMinutes: 10,
  registryPath: '/tmp/active.json',
  historyPath: '/tmp/history.jsonl',
  retryDir: '/tmp/retries',
  lockPath: '/tmp/check.lock'
};

function buildPr(overrides: Partial<GHPRView> = {}): GHPRView {
  return {
    number: 12,
    url: 'https://example/pr/12',
    state: 'OPEN',
    mergeStateStatus: 'CLEAN',
    body: '## Screenshots\n![ui](https://img)',
    isDraft: false,
    reviews: [
      { author: { login: 'codex-reviewer[bot]' }, state: 'APPROVED', body: 'ok' },
      { author: { login: 'gemini-reviewer[bot]' }, state: 'APPROVED', body: 'ok' },
      { author: { login: 'claude-reviewer[bot]' }, state: 'APPROVED', body: 'ok' }
    ],
    comments: [],
    files: [{ path: 'src/app/page.tsx' }],
    ...overrides
  };
}

const passingChecks: GHPRChecks[] = [
  { name: 'lint', state: 'SUCCESS' },
  { name: 'unit', state: 'SUCCESS' }
];

describe('gate evaluator', () => {
  test('passes when all requirements are met', () => {
    const gate = evaluatePullRequestGate(buildPr(), passingChecks, baseConfig);
    expect(gate.gatePassed).toBe(true);
    expect(gate.blockingReasons).toEqual([]);
  });

  test('fails when screenshot missing on ui change', () => {
    const gate = evaluatePullRequestGate(buildPr({ body: 'No screenshots' }), passingChecks, baseConfig);
    expect(gate.gatePassed).toBe(false);
    expect(gate.screenshotPassed).toBe(false);
    expect(gate.blockingReasons).toContain('screenshot_required');
  });

  test('fails on critical review', () => {
    const gate = evaluatePullRequestGate(
      buildPr({ comments: [{ body: '[critical] race condition', author: { login: 'foo' }, isMinimized: false }] }),
      passingChecks,
      baseConfig
    );
    expect(gate.gatePassed).toBe(false);
    expect(gate.criticalOpenCount).toBe(1);
  });

  test('fails with insufficient approvals', () => {
    const gate = evaluatePullRequestGate(
      buildPr({ reviews: [{ author: { login: 'codex-reviewer[bot]' }, state: 'APPROVED' }] }),
      passingChecks,
      baseConfig
    );
    expect(gate.gatePassed).toBe(false);
    expect(gate.approvalCount).toBe(1);
  });

  test('uses latest review state per bot', () => {
    const gate = evaluatePullRequestGate(
      buildPr({
        reviews: [
          { author: { login: 'codex-reviewer[bot]' }, state: 'APPROVED' },
          { author: { login: 'gemini-reviewer[bot]' }, state: 'APPROVED' },
          { author: { login: 'claude-reviewer[bot]' }, state: 'APPROVED' },
          { author: { login: 'gemini-reviewer[bot]' }, state: 'CHANGES_REQUESTED' }
        ]
      }),
      passingChecks,
      baseConfig
    );

    expect(gate.approvalCount).toBe(2);
    expect(gate.gatePassed).toBe(false);
  });
});
