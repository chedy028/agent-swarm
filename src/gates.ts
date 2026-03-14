import { GHPRChecks, GHPRView, GateResult, ReviewSummary, ZoeConfig } from './types.js';

const NON_BLOCKING_CHECK_STATES = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split('**')
    .map((part) => part.split('*').map(escapeRegExp).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(filePath));
}

function hasScreenshotMarkdown(body: string): boolean {
  return /!\[[^\]]*\]\([^\)]+\)/.test(body);
}

function isCriticalText(body: string | undefined, criticalPattern: RegExp): boolean {
  if (!body) {
    return false;
  }
  const hasCritical = criticalPattern.test(body);
  const resolved = /\[resolved\]/i.test(body);
  return hasCritical && !resolved;
}

export function summarizeReviews(pr: GHPRView, config: ZoeConfig): ReviewSummary {
  const botSet = new Set(config.reviewerBotLogins.map((login) => login.toLowerCase()));
  const approvalsByLogin = new Set<string>();
  const criticalPattern = new RegExp(config.criticalTagPattern, 'i');

  for (const review of pr.reviews ?? []) {
    const login = review.author?.login?.toLowerCase();
    if (!login || !botSet.has(login)) {
      continue;
    }

    if (review.state === 'APPROVED') {
      approvalsByLogin.add(login);
    }
  }

  let criticalOpenCount = 0;
  for (const review of pr.reviews ?? []) {
    if (isCriticalText(review.body, criticalPattern)) {
      criticalOpenCount += 1;
    }
  }

  for (const comment of pr.comments ?? []) {
    if (comment.isMinimized) {
      continue;
    }
    if (isCriticalText(comment.body, criticalPattern)) {
      criticalOpenCount += 1;
    }
  }

  return {
    approvalCount: approvalsByLogin.size,
    approvalsByLogin: [...approvalsByLogin].sort(),
    criticalOpenCount
  };
}

export function evaluatePullRequestGate(pr: GHPRView, checks: GHPRChecks[], config: ZoeConfig): GateResult {
  const reviewSummary = summarizeReviews(pr, config);

  const ciPassed = checks.length > 0 && checks.every((check) => NON_BLOCKING_CHECK_STATES.has(check.state));
  const branchSynced = !pr.isDraft && !['DIRTY', 'BEHIND', 'UNKNOWN'].includes(pr.mergeStateStatus ?? 'UNKNOWN');

  const changedFiles = pr.files?.map((file) => file.path) ?? [];
  const requiresScreenshot = changedFiles.some((file) => matchesAnyGlob(file, config.uiPathGlobs));
  const screenshotPassed = !requiresScreenshot || hasScreenshotMarkdown(pr.body ?? '');

  const blockingReasons: string[] = [];
  if (!branchSynced) {
    blockingReasons.push('branch_not_synced');
  }
  if (!ciPassed) {
    blockingReasons.push('ci_not_passed');
  }
  if (reviewSummary.approvalCount < config.requiredApprovals) {
    blockingReasons.push('insufficient_bot_approvals');
  }
  if (reviewSummary.criticalOpenCount > 0) {
    blockingReasons.push('critical_review_open');
  }
  if (!screenshotPassed) {
    blockingReasons.push('screenshot_required');
  }

  return {
    gatePassed:
      branchSynced &&
      ciPassed &&
      reviewSummary.approvalCount >= config.requiredApprovals &&
      reviewSummary.criticalOpenCount === 0 &&
      screenshotPassed,
    blockingReasons,
    ciPassed,
    approvalCount: reviewSummary.approvalCount,
    criticalOpenCount: reviewSummary.criticalOpenCount,
    screenshotPassed,
    branchSynced
  };
}

export function classifyCiState(checks: GHPRChecks[]): 'pass' | 'fail' | 'pending' {
  if (checks.length === 0) {
    return 'pending';
  }

  const states = new Set(checks.map((check) => check.state));
  if ([...states].some((state) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(state))) {
    return 'fail';
  }

  if ([...states].every((state) => NON_BLOCKING_CHECK_STATES.has(state))) {
    return 'pass';
  }

  return 'pending';
}
