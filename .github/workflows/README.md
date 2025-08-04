# Claude AI Code Review

A GitHub Actions workflow that provides principal engineer-level code reviews using Claude, powered by the official Claude Code Action.

## Quick Start

1. **Create a GitHub App for authentication**:
   - Go to [github.com/apps/claude-code](https://github.com/apps/claude-code) and install the Claude Code GitHub App
   - Generate a private key for the app
   - Add `CLAUDE_CODE_APP_ID` and `CLAUDE_CODE_APP_PRIVATE_KEY` as repository secrets

2. **Add your Anthropic API key**:
   - Add `ANTHROPIC_API_KEY` secret to your repository
   - Get your API key from [console.anthropic.com](https://console.anthropic.com)

3. **Enable permissions**:
   - The workflow will automatically request necessary permissions

4. Claude will automatically review all new PRs!

## What It Does

- Uses the official [Claude Code Action](https://github.com/anthropics/claude-code-action) for reliable AI-powered reviews
- Reads your codebase documentation (README, AGENT_CONTEXT, etc.) to understand your project
- Reviews code changes against YOUR established patterns and standards
- Provides technical analysis focused on code quality, architecture, and scope management
- Makes clear merge recommendations with specific action items

## Configuration

The workflow uses the Claude Opus 4 model by default. You can customize:

- **Model**: Change `model` in the workflow (e.g., `claude-opus-4-20250514`)
- **Temperature**: Adjust for more/less creative responses (default: 0.3)
- **Max Tokens**: Control response length (default: 8192)
- **Permissions**: Configure which tools Claude can use

For detailed documentation, see [CLAUDE_REVIEW_DETAILS.md](CLAUDE_REVIEW_DETAILS.md)

## Example Review

Claude provides focused technical feedback like:

> "This introduces scope creep by adding authentication logic directly in the API handler. This should be extracted to the auth middleware layer to maintain separation of concerns."

> "The error handling here doesn't follow our established pattern of using Result types. This will make it inconsistent with the rest of the codebase."

## Support

- Check Actions tab for logs
- Review [Claude Code Action documentation](https://github.com/anthropics/claude-code-action)
- See detailed docs in [CLAUDE_REVIEW_DETAILS.md](CLAUDE_REVIEW_DETAILS.md)