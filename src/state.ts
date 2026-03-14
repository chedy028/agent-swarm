import { RetryOutcome, RetryReason, TaskStatus } from './types.js';

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ['running', 'failed', 'blocked'],
  running: ['running', 'waiting_ci', 'waiting_reviews', 'ready_for_human', 'done', 'failed', 'blocked'],
  waiting_ci: ['waiting_ci', 'waiting_reviews', 'ready_for_human', 'done', 'failed', 'blocked'],
  waiting_reviews: ['waiting_reviews', 'ready_for_human', 'done', 'failed', 'blocked'],
  ready_for_human: ['ready_for_human', 'done', 'failed', 'blocked'],
  done: ['done'],
  failed: ['failed'],
  blocked: ['blocked']
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid status transition: ${from} -> ${to}`);
  }
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'blocked';
}

export function computeRetryOutcome(
  retryCount: number,
  maxRetries: number,
  reason: RetryReason
): RetryOutcome {
  if (reason === 'manual') {
    const nextRetryCount = retryCount + 1;
    const blocked = nextRetryCount > maxRetries;
    return {
      nextStatus: blocked ? 'blocked' : 'running',
      shouldRetry: !blocked,
      blocked,
      nextRetryCount: blocked ? retryCount : nextRetryCount
    };
  }

  const nextRetryCount = retryCount + 1;
  const blocked = nextRetryCount > maxRetries;

  return {
    nextStatus: blocked ? 'blocked' : 'running',
    shouldRetry: !blocked,
    blocked,
    nextRetryCount: blocked ? retryCount : nextRetryCount
  };
}
