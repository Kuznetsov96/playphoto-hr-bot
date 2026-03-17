Deploy accumulated changes from dev to main via PR.

Steps:
1. Make sure all local changes are committed and pushed to dev
2. Create a PR from dev → main using `gh pr create`
3. Wait for the CI `test` job to pass (poll with `gh pr checks` every 15s)
4. Merge the PR with `gh pr merge --merge --delete-branch=false`
5. Confirm the Deploy workflow was triggered by checking `gh run list --branch main --limit 3`
