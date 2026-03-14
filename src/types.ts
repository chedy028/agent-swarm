export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_ci'
  | 'waiting_reviews'
  | 'ready_for_human'
  | 'done'
  | 'failed'
  | 'blocked';

export type RetryReason = 'session_died' | 'ci_failed' | 'critical_review' | 'manual';

export interface PRInfo {
  number: number;
  url: string;
  state?: string;
  mergeStateStatus?: string;
  body?: string;
}

export interface CheckSummary {
  ciPassed: boolean;
  checks: Array<{
    name: string;
    state: string;
    url?: string;
  }>;
}

export interface ReviewSummary {
  approvalCount: number;
  criticalOpenCount: number;
  approvalsByLogin: string[];
}

export interface GateResult {
  gatePassed: boolean;
  blockingReasons: string[];
  ciPassed: boolean;
  approvalCount: number;
  criticalOpenCount: number;
  screenshotPassed: boolean;
  branchSynced: boolean;
}

export interface TaskRecord {
  id: string;
  description: string;
  agent: string;
  repo: string;
  branch: string;
  worktree: string;
  tmuxSession: string;
  promptFile: string;
  status: TaskStatus;
  retryCount: number;
  startedAt: number;
  updatedAt: number;
  pr?: PRInfo;
  checks?: CheckSummary;
  reviewSummary?: ReviewSummary;
  lastFailureReason?: string;
  completedAt?: number;
  note?: string;
}

export interface TaskRegistry {
  tasks: TaskRecord[];
}

export interface ZoeConfig {
  repoPath: string;
  worktreeRoot: string;
  mainBranch: string;
  installCommand?: string;
  allowedAgents: string[];
  agentLaunchCommands: Record<string, string>;
  reviewerBotLogins: string[];
  requiredApprovals: number;
  uiPathGlobs: string[];
  criticalTagPattern: string;
  maxRetries: number;
  pollIntervalMinutes: number;
  registryPath: string;
  historyPath: string;
  retryDir: string;
  lockPath: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(command: string, options?: { cwd?: string; allowFailure?: boolean }): Promise<CommandResult>;
}

export interface GHPRChecks {
  name: string;
  state: string;
  link?: string;
}

export interface GHReview {
  author?: {
    login?: string;
  };
  state?: string;
  body?: string;
}

export interface GHComment {
  author?: {
    login?: string;
  };
  body?: string;
  isMinimized?: boolean;
}

export interface GHFile {
  path: string;
}

export interface GHPRView {
  number: number;
  url: string;
  state?: string;
  mergeStateStatus?: string;
  body?: string;
  isDraft?: boolean;
  reviews?: GHReview[];
  comments?: GHComment[];
  files?: GHFile[];
}

export interface TaskCheckContext {
  task: TaskRecord;
  pr?: GHPRView;
  checks?: GHPRChecks[];
  sessionAlive: boolean;
}

export interface RetryOutcome {
  nextStatus: TaskStatus;
  shouldRetry: boolean;
  blocked: boolean;
  nextRetryCount: number;
}
