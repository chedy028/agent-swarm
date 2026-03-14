import { spawn } from 'node:child_process';
import { CommandResult, CommandRunner } from './types.js';

export class DefaultCommandRunner implements CommandRunner {
  async run(command: string, options: { cwd?: string; allowFailure?: boolean } = {}): Promise<CommandResult> {
    const { cwd, allowFailure } = options;

    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: process.env
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });

      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        const result: CommandResult = {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code ?? 1
        };

        if (!allowFailure && result.exitCode !== 0) {
          reject(new Error(`Command failed (${result.exitCode}): ${command}\n${result.stderr || result.stdout}`));
          return;
        }

        resolve(result);
      });
    });
  }
}
