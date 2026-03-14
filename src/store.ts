import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TaskRecord, TaskRegistry } from './types.js';

const EMPTY_REGISTRY: TaskRegistry = { tasks: [] };

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export async function loadRegistry(registryPath: string): Promise<TaskRegistry> {
  try {
    const raw = await readFile(registryPath, 'utf8');
    const parsed = JSON.parse(raw) as TaskRegistry;
    if (!parsed || !Array.isArray(parsed.tasks)) {
      return { ...EMPTY_REGISTRY };
    }
    return parsed;
  } catch {
    return { ...EMPTY_REGISTRY };
  }
}

export async function saveRegistry(registryPath: string, registry: TaskRegistry): Promise<void> {
  await ensureParentDir(registryPath);
  const tempPath = `${registryPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await rename(tempPath, registryPath);
}

export async function appendHistory(historyPath: string, task: TaskRecord): Promise<void> {
  await ensureParentDir(historyPath);
  await appendFile(historyPath, `${JSON.stringify(task)}\n`, 'utf8');
}

export function upsertTask(registry: TaskRegistry, task: TaskRecord): TaskRegistry {
  const nextTasks = registry.tasks.filter((t) => t.id !== task.id);
  nextTasks.push(task);
  nextTasks.sort((a, b) => a.startedAt - b.startedAt);
  return { tasks: nextTasks };
}

export function getTask(registry: TaskRegistry, taskId: string): TaskRecord | undefined {
  return registry.tasks.find((task) => task.id === taskId);
}
