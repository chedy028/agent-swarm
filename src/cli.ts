#!/usr/bin/env node
import { loadConfig } from './config.js';
import { addFinding, listFindings, resolveFinding } from './findings.js';
import { withFileLock } from './lock.js';
import { cleanupTasks, getStatus, retryTask, spawnTask, checkTasks } from './orchestrator.js';
import { DefaultCommandRunner } from './shell.js';

interface ParsedArgs {
  command?: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [, , command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  return { command, flags };
}

function getFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function toBool(value: string | boolean | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  return false;
}

function getIntFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const raw = getFlag(flags, key);
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${key} must be an integer`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`zoe commands:
  zoe spawn --id --description --prompt-file [--config]
  zoe check [--task-id] [--config]
  zoe status [--task-id] [--json] [--config]
  zoe finding-add --verdict --note [--task-id --artifact-id --file --line-start --line-end --page --fingerprint] [--config]
  zoe findings [--task-id] [--open-only] [--json] [--config]
  zoe finding-resolve --id --note [--config]
  zoe retry --task-id --reason [--delta-file] [--config]
  zoe cleanup [--dry-run] [--config]`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  const command = parsed.command;

  if (!command || command === '--help' || command === 'help') {
    printHelp();
    return;
  }

  const configPath = getFlag(parsed.flags, 'config');
  const config = await loadConfig(configPath);
  const runner = new DefaultCommandRunner();

  if (command === 'spawn') {
    if (getFlag(parsed.flags, 'agent')) {
      throw new Error('spawn no longer accepts --agent. Trio mode always launches codex, gemini, and claude.');
    }

    const result = await spawnTask(config, runner, {
      id: getFlag(parsed.flags, 'id') ?? '',
      description: getFlag(parsed.flags, 'description') ?? '',
      promptFile: getFlag(parsed.flags, 'prompt-file') ?? ''
    });
    for (const message of result.messages) {
      console.log(message);
    }
    return;
  }

  if (command === 'check') {
    const runCheck = async () => await checkTasks(config, runner, getFlag(parsed.flags, 'task-id'));
    const result = await withFileLock(config.lockPath, runCheck, { staleMs: 60 * 60 * 1000 });

    if (result.messages.length === 0) {
      return;
    }

    for (const message of result.messages) {
      console.log(message);
    }
    process.exitCode = 2;
    return;
  }

  if (command === 'status') {
    const tasks = await getStatus(config, getFlag(parsed.flags, 'task-id'));
    if (toBool(parsed.flags.json)) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }

    for (const task of tasks) {
      console.log([
        `id=${task.id}`,
        `kind=${task.kind}`,
        `status=${task.status}`,
        `agent=${task.agent ?? '-'}`,
        `parent=${task.parentId ?? '-'}`,
        `winner=${task.winnerChildId ?? '-'}`,
        `pr=${task.pr?.number ?? '-'}`,
        `retries=${task.retryCount}`,
        `note=${task.note ?? '-'}`
      ].join(' | '));
    }

    if (tasks.length === 0) {
      console.log('no_tasks');
    }
    return;
  }

  if (command === 'retry') {
    const result = await retryTask(config, runner, {
      taskId: getFlag(parsed.flags, 'task-id') ?? '',
      reason: getFlag(parsed.flags, 'reason') ?? '',
      deltaFile: getFlag(parsed.flags, 'delta-file')
    });
    for (const message of result.messages) {
      console.log(message);
    }
    return;
  }

  if (command === 'finding-add') {
    const verdict = getFlag(parsed.flags, 'verdict');
    if (!verdict) {
      throw new Error('finding-add requires --verdict');
    }

    const note = getFlag(parsed.flags, 'note');
    if (!note) {
      throw new Error('finding-add requires --note');
    }

    const finding = await addFinding(config.findingLogPath, {
      taskId: getFlag(parsed.flags, 'task-id'),
      artifactId: getFlag(parsed.flags, 'artifact-id'),
      filePath: getFlag(parsed.flags, 'file'),
      lineStart: getIntFlag(parsed.flags, 'line-start') ?? getIntFlag(parsed.flags, 'line'),
      lineEnd: getIntFlag(parsed.flags, 'line-end'),
      page: getIntFlag(parsed.flags, 'page'),
      sourceRegionFingerprint: getFlag(parsed.flags, 'fingerprint'),
      verdict: verdict as 'correct' | 'incorrect' | 'needs_fix' | 'improvement',
      note
    });

    if (toBool(parsed.flags.json)) {
      console.log(JSON.stringify(finding, null, 2));
      return;
    }

    console.log(`finding_added:${finding.id}`);
    return;
  }

  if (command === 'findings') {
    const findings = await listFindings(config.findingLogPath, {
      taskId: getFlag(parsed.flags, 'task-id'),
      openOnly: toBool(parsed.flags['open-only'])
    });

    if (toBool(parsed.flags.json)) {
      console.log(JSON.stringify(findings, null, 2));
      return;
    }

    if (findings.length === 0) {
      console.log('no_findings');
      return;
    }

    for (const finding of findings) {
      console.log(
        [
          `id=${finding.id}`,
          `status=${finding.status}`,
          `verdict=${finding.verdict}`,
          `task=${finding.taskId ?? '-'}`,
          `artifact=${finding.artifactId ?? '-'}`,
          `file=${finding.filePath ?? '-'}`,
          `line=${finding.lineStart ?? '-'}`,
          `note=${finding.note}`
        ].join(' | ')
      );
    }
    return;
  }

  if (command === 'finding-resolve') {
    const id = getFlag(parsed.flags, 'id');
    const note = getFlag(parsed.flags, 'note');
    if (!id || !note) {
      throw new Error('finding-resolve requires --id and --note');
    }

    const finding = await resolveFinding(config.findingLogPath, id, note);
    if (toBool(parsed.flags.json)) {
      console.log(JSON.stringify(finding, null, 2));
      return;
    }

    console.log(`finding_resolved:${finding.id}`);
    return;
  }

  if (command === 'cleanup') {
    const result = await cleanupTasks(config, runner, {
      dryRun: toBool(parsed.flags['dry-run'])
    });
    for (const message of result.messages) {
      console.log(message);
    }
    if (result.messages.length === 0) {
      console.log('nothing_to_cleanup');
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exit(1);
});
