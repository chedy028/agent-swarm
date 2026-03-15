import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type FindingVerdict = 'correct' | 'incorrect' | 'needs_fix' | 'improvement';
export type FindingStatus = 'open' | 'resolved';

export interface FindingRecord {
  id: string;
  status: FindingStatus;
  verdict: FindingVerdict;
  note: string;
  taskId?: string;
  parentTaskId?: string;
  artifactId?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  page?: number;
  sourceRegionFingerprint?: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  resolutionNote?: string;
}

export interface AddFindingInput {
  taskId?: string;
  artifactId?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  page?: number;
  sourceRegionFingerprint?: string;
  verdict: FindingVerdict;
  note: string;
}

export interface ListFindingsOptions {
  taskId?: string;
  openOnly?: boolean;
  limit?: number;
}

const VALID_VERDICTS = new Set<FindingVerdict>(['correct', 'incorrect', 'needs_fix', 'improvement']);

function inferParentTaskId(taskId?: string): string | undefined {
  if (!taskId) {
    return undefined;
  }
  const marker = taskId.indexOf('--');
  if (marker <= 0) {
    return taskId;
  }
  return taskId.slice(0, marker);
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

function parseFinding(raw: string): FindingRecord | undefined {
  if (!raw.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<FindingRecord>;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    if (typeof parsed.id !== 'string' || parsed.id.trim() === '') {
      return undefined;
    }
    if (parsed.status !== 'open' && parsed.status !== 'resolved') {
      return undefined;
    }
    if (!parsed.verdict || !VALID_VERDICTS.has(parsed.verdict)) {
      return undefined;
    }
    if (typeof parsed.note !== 'string' || parsed.note.trim() === '') {
      return undefined;
    }

    return {
      ...parsed,
      id: parsed.id,
      status: parsed.status,
      verdict: parsed.verdict,
      note: parsed.note,
      createdAt: Number(parsed.createdAt ?? 0),
      updatedAt: Number(parsed.updatedAt ?? 0)
    } as FindingRecord;
  } catch {
    return undefined;
  }
}

async function loadFindingEvents(logPath: string): Promise<FindingRecord[]> {
  try {
    const raw = await readFile(logPath, 'utf8');
    return raw
      .split('\n')
      .map(parseFinding)
      .filter((entry): entry is FindingRecord => !!entry);
  } catch {
    return [];
  }
}

function latestFindings(events: FindingRecord[]): FindingRecord[] {
  const byId = new Map<string, FindingRecord>();
  for (const event of events) {
    byId.set(event.id, event);
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

function toPositiveInt(value: number | undefined, key: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer when provided`);
  }
  return value;
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function matchesTask(finding: FindingRecord, taskId?: string): boolean {
  if (!taskId) {
    return true;
  }

  const requestedParent = inferParentTaskId(taskId);
  const findingParent = finding.parentTaskId ?? inferParentTaskId(finding.taskId);

  return finding.taskId === taskId || finding.taskId === requestedParent || findingParent === requestedParent;
}

export async function listFindings(logPath: string, options: ListFindingsOptions = {}): Promise<FindingRecord[]> {
  const allLatest = latestFindings(await loadFindingEvents(logPath));
  let filtered = allLatest.filter((finding) => matchesTask(finding, options.taskId));

  if (options.openOnly) {
    filtered = filtered.filter((finding) => finding.status === 'open');
  }

  if (options.limit && options.limit > 0) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

export async function addFinding(logPath: string, input: AddFindingInput): Promise<FindingRecord> {
  const note = input.note.trim();
  if (!note) {
    throw new Error('note is required');
  }

  if (!VALID_VERDICTS.has(input.verdict)) {
    throw new Error(`verdict must be one of: ${[...VALID_VERDICTS].join(', ')}`);
  }

  const lineStart = toPositiveInt(input.lineStart, 'lineStart');
  const lineEnd = toPositiveInt(input.lineEnd, 'lineEnd');
  if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
    throw new Error('lineEnd cannot be less than lineStart');
  }

  const page = toPositiveInt(input.page, 'page');
  const taskId = normalizeOptional(input.taskId);
  const now = Date.now();

  const record: FindingRecord = {
    id: `${now}-${Math.random().toString(36).slice(2, 10)}`,
    status: 'open',
    verdict: input.verdict,
    note,
    taskId,
    parentTaskId: inferParentTaskId(taskId),
    artifactId: normalizeOptional(input.artifactId),
    filePath: normalizeOptional(input.filePath),
    lineStart,
    lineEnd,
    page,
    sourceRegionFingerprint: normalizeOptional(input.sourceRegionFingerprint),
    createdAt: now,
    updatedAt: now
  };

  await ensureParentDir(logPath);
  await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function resolveFinding(logPath: string, id: string, note: string): Promise<FindingRecord> {
  const findingId = id.trim();
  if (!findingId) {
    throw new Error('id is required');
  }

  const resolutionNote = note.trim();
  if (!resolutionNote) {
    throw new Error('resolution note is required');
  }

  const current = (await listFindings(logPath, { openOnly: false })).find((finding) => finding.id === findingId);
  if (!current) {
    throw new Error(`finding not found: ${findingId}`);
  }

  if (current.status === 'resolved') {
    return current;
  }

  const now = Date.now();
  const resolved: FindingRecord = {
    ...current,
    status: 'resolved',
    updatedAt: now,
    resolvedAt: now,
    resolutionNote
  };

  await ensureParentDir(logPath);
  await appendFile(logPath, `${JSON.stringify(resolved)}\n`, 'utf8');
  return resolved;
}

function describeLocation(finding: FindingRecord): string {
  const parts: string[] = [];
  if (finding.artifactId) {
    parts.push(`artifact=${finding.artifactId}`);
  }
  if (finding.filePath) {
    const linePart =
      finding.lineStart && finding.lineEnd && finding.lineEnd !== finding.lineStart
        ? `${finding.filePath}:${finding.lineStart}-${finding.lineEnd}`
        : finding.lineStart
          ? `${finding.filePath}:${finding.lineStart}`
          : finding.filePath;
    parts.push(`file=${linePart}`);
  }
  if (finding.page) {
    parts.push(`page=${finding.page}`);
  }
  if (finding.sourceRegionFingerprint) {
    parts.push(`fingerprint=${finding.sourceRegionFingerprint}`);
  }
  return parts.length > 0 ? parts.join(' | ') : 'location=unspecified';
}

export async function renderOpenFindingsForTask(logPath: string, taskId: string, limit = 12): Promise<string[]> {
  const openFindings = await listFindings(logPath, { taskId, openOnly: true, limit });
  return openFindings.map((finding) => {
    const location = describeLocation(finding);
    return `- [${finding.verdict}] ${location} :: ${finding.note}`;
  });
}
