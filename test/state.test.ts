import { describe, expect, test } from 'vitest';
import { canTransition, computeRetryOutcome, isTerminalStatus } from '../src/state.js';

describe('state transitions', () => {
  test('allows valid transition', () => {
    expect(canTransition('running', 'waiting_ci')).toBe(true);
    expect(canTransition('waiting_reviews', 'ready_for_human')).toBe(true);
  });

  test('rejects invalid transition', () => {
    expect(canTransition('done', 'running')).toBe(false);
    expect(canTransition('blocked', 'ready_for_human')).toBe(false);
    expect(canTransition('superseded', 'running')).toBe(false);
  });
});

describe('retry policy', () => {
  test('retries until max', () => {
    expect(computeRetryOutcome(0, 3, 'ci_failed')).toEqual({
      nextStatus: 'running',
      shouldRetry: true,
      blocked: false,
      nextRetryCount: 1
    });
  });

  test('blocks after max', () => {
    expect(computeRetryOutcome(3, 3, 'critical_review')).toEqual({
      nextStatus: 'blocked',
      shouldRetry: false,
      blocked: true,
      nextRetryCount: 3
    });
  });

  test('treats superseded as terminal', () => {
    expect(isTerminalStatus('superseded')).toBe(true);
  });
});
