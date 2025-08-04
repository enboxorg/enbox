# Claude AI Code Review

A GitHub Actions workflow that provides principal engineer-level code reviews using Claude, with deep understanding of your codebase.

## Quick Start

1. Add `CLAUDE_API_KEY` secret to your repository
2. Enable "Read and write permissions" in Settings → Actions → General
3. Claude will automatically review all new PRs

## What It Does

- Reads your codebase documentation (README, AGENT_CONTEXT, etc.) to understand your project
- Reviews code changes against YOUR established patterns and standards
- Provides technical analysis focused on code quality, architecture, and scope management
- Makes clear merge recommendations with specific action items

## Configuration

Edit the workflow file to:
- Change Claude model (Opus/Sonnet/Haiku)
- Adjust file review limits
- Modify temperature settings

For detailed documentation, see [CLAUDE_REVIEW_DETAILS.md](CLAUDE_REVIEW_DETAILS.md)

## Example Review

Claude provides focused technical feedback like:

> "This introduces scope creep by adding authentication logic directly in the API handler. This should be extracted to the auth middleware layer to maintain separation of concerns."

> "The error handling here doesn't follow our established pattern of using Result types. This will make it inconsistent with the rest of the codebase."

## Support

- Check Actions tab for logs
- Review [Anthropic's documentation](https://docs.anthropic.com/)
- See detailed docs in [CLAUDE_REVIEW_DETAILS.md](CLAUDE_REVIEW_DETAILS.md)