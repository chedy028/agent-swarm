import { open, readFile, rm, stat, writeFile } from 'node:fs/promises';

export interface LockOptions {
  staleMs?: number;
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const staleMs = options.staleMs ?? 60 * 60 * 1000;
  let lockFd;

  try {
    lockFd = await open(lockPath, 'wx');
    await writeFile(lockPath, `${process.pid}`);
  } catch {
    const isStale = await lockLooksStale(lockPath, staleMs);
    if (!isStale) {
      throw new Error(`Lock already held: ${lockPath}`);
    }

    await rm(lockPath, { force: true });
    lockFd = await open(lockPath, 'wx');
    await writeFile(lockPath, `${process.pid}`);
  }

  try {
    return await fn();
  } finally {
    await lockFd?.close();
    await rm(lockPath, { force: true });
  }
}

async function lockLooksStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const stats = await stat(lockPath);
    const age = Date.now() - stats.mtimeMs;
    if (age < staleMs) {
      return false;
    }

    const pidRaw = await readFile(lockPath, 'utf8');
    const pid = Number.parseInt(pidRaw.trim(), 10);
    if (Number.isNaN(pid)) {
      return true;
    }

    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}
