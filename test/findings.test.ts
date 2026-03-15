import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { addFinding, listFindings, renderOpenFindingsForTask, resolveFinding } from '../src/findings.js';

describe('findings log', () => {
  test('adds and lists findings with task filtering', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zoe-findings-'));
    const logPath = path.join(root, '.autobot', 'review-findings.jsonl');

    await addFinding(logPath, {
      taskId: 'pack-review',
      verdict: 'correct',
      artifactId: 'eq:1',
      note: 'Equation formatting is correct.',
      page: 12
    });

    await addFinding(logPath, {
      taskId: 'pack-review--codex',
      verdict: 'needs_fix',
      filePath: 'src/esh/catalog_api.py',
      lineStart: 771,
      note: 'Equation preview is still escaped text on this line.'
    });

    const parentFindings = await listFindings(logPath, { taskId: 'pack-review', openOnly: true });
    expect(parentFindings).toHaveLength(2);

    const childFindings = await listFindings(logPath, { taskId: 'pack-review--gemini', openOnly: true });
    expect(childFindings).toHaveLength(2);

    const rendered = await renderOpenFindingsForTask(logPath, 'pack-review--gemini');
    expect(rendered.join('\n')).toContain('needs_fix');
    expect(rendered.join('\n')).toContain('correct');
  });

  test('resolve appends resolved state and removes from open list', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zoe-findings-'));
    const logPath = path.join(root, '.autobot', 'review-findings.jsonl');

    const created = await addFinding(logPath, {
      taskId: 'pack-review',
      verdict: 'incorrect',
      note: 'Table row has wrong value.',
      artifactId: 'table:3',
      page: 15
    });

    const resolved = await resolveFinding(logPath, created.id, 'Fixed in follow-up patch.');
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionNote).toContain('Fixed');

    const open = await listFindings(logPath, { openOnly: true });
    expect(open).toHaveLength(0);

    const all = await listFindings(logPath, { openOnly: false });
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('resolved');
  });
});
