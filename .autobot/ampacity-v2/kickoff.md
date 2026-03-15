# Ampacity-v2 Swarm Kickoff

You are working in the `ampacity-v2` repository.

Your job is to ship one concrete, high-value, self-contained improvement that moves the project closer to production readiness. Do not wait for more instructions unless you are genuinely blocked.

## Context to Review First

Read these files before choosing the change:

- `README.md`
- `QUICK_START.md`
- `IMPLEMENTATION_STATUS.md`
- `check_list.md`
- relevant files under `backend/app/`
- relevant files under `frontend/app/`
- relevant tests under `tests/`

## Priorities

Choose the best scoped improvement you can complete end-to-end today. Prefer, in order:

1. A backend contract, validation, rollout, lifecycle, or determinism gap.
2. A runtime reliability issue or cleanup with real value, including replacing deprecated FastAPI startup hooks with lifespan handling if that is the best win.
3. A reviewer UI improvement only if you can validate it fully and include a screenshot in the PR body.

## Constraints

- Keep the change focused and low-risk.
- Do not do a broad refactor.
- Preserve deterministic numeric behavior unless a bug fix requires a targeted change.
- Keep standards artifact and lockfile behavior intact.
- If you touch UI files, include at least one screenshot in the PR body using Markdown image syntax.

## Execution

1. Inspect the repo and select the highest-value scoped improvement.
2. Implement the change.
3. Add or update tests for the behavior you changed.
4. Run the relevant validation:
   - `pytest -q`
   - `cd frontend && npm install && npm run build` if frontend files changed
   - any narrower checks needed for your change
5. Commit your work on your branch.
6. Open a GitHub PR from your branch with:
   - a concise summary
   - the reason this change matters
   - validation steps and results
   - screenshots if UI changed

## Delivery Standard

At the end, leave the branch in a reviewable state with a PR opened. If you hit a blocker, document it clearly in the PR body and terminal output, along with the best next step.
