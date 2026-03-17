# Git Workflow Rules

## CRITICAL: Never push directly to main

**All work must go through dev branch:**

1. Make changes in `dev`
2. Push to `origin/dev`
3. Create PR from `dev` → `main` (or merge via PR)
4. CI must pass before merge

**NEVER run:**
- `git push origin main`
- `git merge dev` while on `main` and then push
- Any direct commit to `main`

This applies to ALL LLMs and contributors without exception.

## Branch structure

- `dev` — active development, CI runs tests only
- `main` — production, triggers full CI + Docker build + deploy to server

## Deploy procedure

When the user asks to deploy (e.g. "deploy", "задеплой", "/deploy"):

1. Ensure all local changes are committed and pushed to `dev`
2. Create PR: `gh pr create --base main --head dev --title "..." --body "..."`
3. Wait for CI to pass: poll `gh pr checks <PR_NUMBER>` every 15s until all green
4. Merge: `gh pr merge <PR_NUMBER> --merge --delete-branch=false`
5. Confirm deploy started: `gh run list --branch main --limit 3`

Do NOT use `git merge` + `git push origin main` directly.

## Admin UI Rules

- Use English for months, days, and statuses in Admin/Staff menus (more concise).
- Candidate-facing strings MUST remain in Ukrainian.
