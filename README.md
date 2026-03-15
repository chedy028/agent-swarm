# Zoe Local Orchestrator MVP

Local-first orchestrator for coding agents using:
- Bash for worktree/tmux operations.
- Node + TypeScript for state machine, PR gate checks, retries, and cleanup.

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Edit `.autobot/config.json`:
- `repoPath`
- `worktreeRoot`
- `agentLaunchCommands`
- `uiAgent` (set to `gemini` to route UI tasks)
- `reviewerBotLogins`

3. Ensure GitHub CLI auth:

```bash
gh auth status
```

## Commands

```bash
pnpm zoe spawn --id feat-custom-templates --agent codex --description "Custom email templates" --prompt-file /abs/path/prompt.md
pnpm zoe spawn --id ui-polish-1 --agent ui --description "UI polish pass" --prompt-file /abs/path/prompt.md
pnpm zoe check
pnpm zoe status
pnpm zoe status --json
pnpm zoe retry --task-id feat-custom-templates --reason "fix failed CI"
pnpm zoe cleanup --dry-run
```

`--agent ui` routes to `config.uiAgent` (defaults to `gemini`).

If you use Gemini tasks, ensure Gemini CLI is installed and `GEMINI_API_KEY` is set in your shell environment.

Bash wrappers:

```bash
.autobot/spawn-agent.sh --id feat-custom-templates --agent codex --description "Custom email templates" --prompt-file /abs/path/prompt.md
.autobot/check-agents.sh
.autobot/cleanup-worktrees.sh --dry-run
```

## Cron examples

Check agents every 10 minutes:

```cron
*/10 * * * * cd /absolute/path/to/project && ./.autobot/check-agents.sh >> /tmp/zoe-check.log 2>&1
```

Cleanup daily at 2:30 AM:

```cron
30 2 * * * cd /absolute/path/to/project && ./.autobot/cleanup-worktrees.sh >> /tmp/zoe-cleanup.log 2>&1
```
