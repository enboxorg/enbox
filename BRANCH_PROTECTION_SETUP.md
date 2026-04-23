# Branch Protection Setup Guide

To ensure that all tests pass and coverage doesn't decrease before merging to main, follow these steps to configure branch protection rules in GitHub:

## 1. Navigate to Branch Protection Settings

1. Go to your repository on GitHub
2. Click on **Settings** > **Branches**
3. Click **Add rule** or edit existing rule for `main` branch

## 2. Configure Branch Protection Rules

### Basic Settings
- **Branch name pattern**: `main`
- **Require a pull request before merging**
  - **Require approvals** (recommended: at least 1)
  - **Dismiss stale pull request approvals when new commits are pushed**
  - **Require review from CODEOWNERS** (if you have a CODEOWNERS file)

### Status Checks
- **Require status checks to pass before merging**
- **Require branches to be up to date before merging**

#### Required Status Checks
Add **exactly one** check (it must have run at least once on the branch before appearing in the list):

1. `CI Passed`

> **Do not add `Lint`, `Build`, `SonarCloud Code Analysis`, or any individual CI job as a required check.**
>
> The CI workflow is designed so that `CI Passed` is the single umbrella gate (see `ci.yml` → `ci-passed` job). It aggregates every sub-job and correctly handles both real runs and skipped runs:
>
> - On doc-only PRs, `Detect Changes` returns `src=false`. `lint`, `build`, `coverage-*`, and `sonarcloud` are legitimately **skipped**, and `CI Passed` still reports success.
> - On code PRs, `ci-passed` explicitly fails if any required sub-job (lint, build, tests, coverage, SonarCloud quality gate) reports failure.
>
> If you require `Lint` or `Build` directly, GitHub treats `SKIPPED` as "not passing" and blocks every doc-only PR forever. Worse, `SonarCloud Code Analysis` is a status posted by the **SonarCloud GitHub App** — it is never posted at all when the scan job is skipped, so any PR that skips the scan (docs-only, or when `SONAR_PROJECT_KEY`/`SONAR_ORG` are unset) will be stuck in a permanent pending state.
>
> The canonical required-checks list for this repo is therefore:
>
> ```
> [
>   { "context": "CI Passed", "integration_id": 15368 }
> ]
> ```
>
> (`integration_id: 15368` pins the check to the GitHub Actions app, preventing a third party from spoofing the status context.)

### Additional Settings
- **Require conversation resolution before merging**
- **Include administrators** (optional but recommended)
- **Restrict who can push to matching branches** (optional)

## 3. Workflow Status Checks

The following workflows will run automatically:

### CI Workflow (`ci.yml`)
- **Triggers**: On push to main and all PRs targeting main
- **Jobs**:
  - **Setup** -- lint + build all packages
  - **Test jobs** -- six parallel shards: lightweight packages, dwn-sdk-js, agent + api, dwn-sql-store, dwn-server, browser (Playwright)
  - **Coverage** -- aggregates lcov reports from all test jobs, enforces 90% minimum per package, posts coverage summary as PR comment
  - **CI Passed** -- gate job that requires all test + coverage jobs to succeed (this is the status check to add to branch protection)

### Deploy Workflow (`deploy.yml`)
- **Triggers**: On push to main (after CI passes)
- **Actions**: Deploys dwn-server to Fly.io

### Release Workflow (`release.yml`)
- **Triggers**: On push to main
- **Actions**: Manages changesets and npm publishing

## 4. Customizing Coverage Thresholds

The coverage threshold is set to **90%** per package in `ci.yml`. To modify:

```yaml
# In the coverage job, change the threshold variable:
threshold=90
```

## 5. Testing the Setup

1. Create a test PR with:
   - A failing test -- should fail CI
   - Coverage below 90% -- should fail the coverage check
   - All tests passing and coverage maintained -- should pass all checks

## 6. Troubleshooting

### Workflows not appearing in branch protection
- Make sure workflows have run at least once on the main branch
- Check workflow file syntax is correct
- Ensure workflow files are in `.github/workflows/`

### Coverage reports not generating
- All packages use `bun test --coverage` -- coverage is built-in
- Ensure test commands include coverage generation

### Low coverage numbers locally
- Verify test infrastructure is running (Docker containers for Pkarr, Postgres, MySQL)
- See `CLAUDE.md` "Local Test Infrastructure" section for setup instructions

### A doc-only PR is stuck on `Expected — Waiting for status to be reported`
This means the branch-protection rule lists a check that the CI workflow skipped (most commonly `Lint`, `Build`, or `SonarCloud Code Analysis`). Remove those from the required-checks list and keep only `CI Passed`. Inspect and repair the active ruleset with:

```bash
# List active rulesets and their IDs
gh api repos/enboxorg/enbox/rulesets --jq '.[] | {id, name, enforcement}'

# Inspect the current required checks for a ruleset
gh api repos/enboxorg/enbox/rulesets/<ID> \
  --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks'

# Update the ruleset so only `CI Passed` is required
gh api repos/enboxorg/enbox/rulesets/<ID> > /tmp/ruleset.json
jq '{
  name, target, enforcement, bypass_actors, conditions,
  rules: [.rules[] | if .type=="required_status_checks" then
    .parameters.required_status_checks = [{context:"CI Passed", integration_id:15368}]
  else . end]
}' /tmp/ruleset.json > /tmp/ruleset-updated.json
gh api --method PUT repos/enboxorg/enbox/rulesets/<ID> --input /tmp/ruleset-updated.json
```
