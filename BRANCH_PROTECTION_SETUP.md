# Branch Protection Setup Guide

To ensure that all tests pass and coverage doesn't decrease before merging to main, follow these steps to configure branch protection rules in GitHub:

## 1. Navigate to Branch Protection Settings

1. Go to your repository on GitHub
2. Click on **Settings** → **Branches**
3. Click **Add rule** or edit existing rule for `main` branch

## 2. Configure Branch Protection Rules

### Basic Settings
- **Branch name pattern**: `main`
- ✅ **Require a pull request before merging**
  - ✅ **Require approvals** (recommended: at least 1)
  - ✅ **Dismiss stale pull request approvals when new commits are pushed**
  - ✅ **Require review from CODEOWNERS** (if you have a CODEOWNERS file)

### Status Checks
- ✅ **Require status checks to pass before merging**
- ✅ **Require branches to be up to date before merging**

#### Required Status Checks
Add these checks (they must run at least once before appearing in the list):
1. `CI / Test and Coverage`
2. `CI / CI Success`
3. `Coverage Comparison / Compare Coverage` (for PRs only)

### Additional Settings
- ✅ **Require conversation resolution before merging**
- ✅ **Include administrators** (optional but recommended)
- ✅ **Restrict who can push to matching branches** (optional)

## 3. Workflow Status Checks

The following workflows will run automatically:

### CI Workflow (`ci.yml`)
- **Triggers**: On push to main and all PRs targeting main
- **Actions**:
  - Runs linting
  - Builds all packages
  - Runs all tests
  - Generates coverage reports
  - Checks coverage thresholds (80% minimum)
  - Posts coverage summary as PR comment

### Coverage Comparison Workflow (`coverage-comparison.yml`)
- **Triggers**: On PRs targeting main only
- **Actions**:
  - Compares coverage between PR branch and base branch
  - Fails if coverage decreases in any package
  - Posts detailed comparison report as PR comment

## 4. Customizing Coverage Thresholds

To modify coverage requirements:

1. **Overall threshold** (in `ci.yml`):
   ```bash
   # Change the 80 to your desired percentage
   if (( $(echo "$coverage < 80" | bc -l) )); then
   ```

2. **Per-package thresholds**: You can add package-specific thresholds in the coverage check scripts

## 5. Testing the Setup

1. Create a test PR with:
   - A failing test → Should fail CI
   - Reduced test coverage → Should fail coverage comparison
   - All tests passing and coverage maintained → Should pass all checks

## 6. Troubleshooting

### Workflows not appearing in branch protection
- Make sure workflows have run at least once on the main branch
- Check workflow file syntax is correct
- Ensure workflow files are in `.github/workflows/`

### Coverage reports not generating
- For packages using `bun test`: coverage is built-in (`bun test --coverage`)
- For packages using Mocha (`agent`, `api`): verify `c8` is configured if coverage is needed
- Ensure test commands include coverage generation

### False coverage decreases
- Check if base branch has coverage data
- Verify coverage report formats match between branches
- Consider allowing small decreases (e.g., 0.1%) for rounding errors