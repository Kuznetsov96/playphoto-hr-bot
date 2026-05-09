# CLAUDE.md

This repository uses `AGENTS.md` as the canonical short guide for AI coding agents. Read that file first.

## Claude-Specific Notes

- Follow the same project rules and command list from `AGENTS.md`.
- Never push directly to `main`; use `dev` and a PR to `main`.
- For deploy requests, create/merge a PR instead of running a direct `git merge` or `git push origin main`.
- Keep context low: avoid `node_modules/`, `dist/`, `.venv/`, `logs/`, `backups/`, `tmp/`, local `.env*`, and generated output unless the task explicitly needs them.

## Quick Checks

```bash
npm run build
npm run check-cycles
npm run check-menu-ids
npm test
```
