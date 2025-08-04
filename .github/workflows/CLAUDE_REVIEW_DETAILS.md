# Claude AI Code Review - Detailed Documentation

## Overview

This document contains detailed information about the Claude AI Code Review workflow that provides principal engineer-level code reviews using the official Claude Code Action.

## How It Works

When a pull request is opened or updated, the workflow:

1. **Authenticates with Anthropic** - Uses your API key to access Claude
2. **Learns your codebase** - Claude reads README.md, AGENT_CONTEXT.md, package.json files, and other documentation
3. **Understands the context** - Analyzes your project structure, dependencies, and architectural patterns  
4. **Reviews like a principal engineer** - Evaluates each file against your established standards and patterns
5. **Provides strategic assessment** - Delivers both tactical code feedback and strategic architectural guidance
6. **Makes a recommendation** - Clear merge decision with specific conditions and follow-up items

## What Makes This Different

Unlike generic AI code reviews, this workflow:

- **Has context** - Claude understands your specific codebase, not just general best practices
- **Maintains standards** - Enforces YOUR team's patterns, conventions, and quality bar
- **Thinks long-term** - Considers technical debt, scalability, and architectural evolution
- **Reviews holistically** - Understands how changes fit into the larger monorepo structure
- **Uses official action** - Leverages Anthropic's official GitHub Action for reliability and updates

## Setup Requirements

### 1. Add Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Generate an API key
3. Add it as `ANTHROPIC_API_KEY` secret in your repository:
   - Go to Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `ANTHROPIC_API_KEY`
   - Value: Your API key

### 2. Enable Workflow Permissions

1. Go to Settings → Actions → General
2. Scroll to "Workflow permissions"
3. Select "Read and write permissions"
4. Save

That's it! No GitHub App required.

## Context Files Used

The workflow reads these files to understand your codebase:

- `README.md` - Project overview and goals
- `AGENT_CONTEXT.md` - Specific context for AI agents
- `GETTING_STARTED.md` - Development patterns and setup
- `package.json` files - Dependencies and project structure
- Package-specific READMEs in the monorepo

## Configuration

### Model Selection

The workflow uses Claude Opus 4 by default for principal engineer-level analysis:

```yaml
model: "claude-opus-4-20250514"  # Latest Opus model for best analysis
# model: "claude-3-7-sonnet-20250219-beta:0"  # Faster, still excellent
# model: "claude-3-5-haiku-20241022"  # Quick code checks
```

### Temperature Setting

The workflow uses a low temperature (0.3) for consistent, analytical reviews. This ensures Claude provides thoughtful, precise feedback rather than creative interpretations.

### Settings Configuration

The workflow uses advanced settings to control Claude's behavior:

```yaml
settings: |
  {
    "env": {
      "REVIEW_TYPE": "principal-engineer"
    },
    "permissions": {
      "allow": ["Read", "Bash"],
      "deny": ["WebFetch", "Write"]
    },
    "hooks": {
      "PreToolUse": [{
        "matcher": "Read",
        "hooks": [{
          "type": "log",
          "message": "Reading file for code review..."
        }]
      }]
    }
  }
```

### Permissions Explained

- **Read**: Allows Claude to read files in your repository
- **Bash**: Allows running read-only commands like `git diff`
- **WebFetch**: Denied to prevent external API calls
- **Write**: Denied to ensure reviews are read-only

## Example Output

### 1. Principal Engineer File Review
```
## 🏗️ Principal Engineer Review by Claude

I've conducted a thorough review of 5 file(s) in this PR, analyzing them against our codebase standards and architectural principles.

### 📄 packages/core/src/auth/authenticator.ts

This implementation aligns well with our microservices architecture. However, I have concerns about the session management approach:

1. **Pattern Violation**: The direct Redis calls here break our established data access layer pattern. All cache operations should go through the CacheService interface we established in packages/core/src/services/cache.

2. **Security Consideration**: The JWT refresh token is stored without encryption. Given our security requirements outlined in AGENT_CONTEXT.md, all tokens should be encrypted at rest...

[Specific line-by-line feedback with architectural context]
```

### 2. Executive Summary
```
## 🎯 Principal Engineer Executive Summary

### Strategic Assessment
This PR introduces OAuth2 integration, which aligns with our Q4 roadmap for third-party integrations. The implementation is solid but needs refinement to meet our architectural standards.

### Technical Leadership Perspective
- **Code Quality**: B+ - Well-structured but misses some established patterns
- **Architecture Fit**: Mostly aligned, with exceptions noted below
- **Technical Debt**: Introduces minor debt in error handling that should be addressed
- **Risk Level**: Low - No critical issues, but needs the pattern fixes before merge

### Merge Recommendation: NOT READY

**Blockers (Must Fix)**:
1. Replace direct Redis calls with CacheService abstraction
2. Implement token encryption for refresh tokens
3. Add rate limiting to OAuth callback endpoint

**Nice to Have**:
- Consider extracting OAuth provider logic to a strategy pattern
- Add metrics collection for OAuth success/failure rates

Once the blockers are addressed, this will be a solid addition to our auth system.
```

## Advanced Features

### Using Different Models

You can switch between models based on your needs:

- **claude-opus-4-20250514**: Best for thorough, principal-level reviews
- **claude-3-7-sonnet-20250219-beta:0**: Excellent balance of speed and quality
- **claude-3-5-haiku-20241022**: Fast reviews for smaller changes

### Custom Review Prompts

You can customize the review focus by modifying the `prompt` parameter:

```yaml
prompt: |
  Focus on security implications and performance bottlenecks in this PR.
  Pay special attention to SQL queries and API endpoint authorization.
```

### Using with Cloud Providers

The action supports AWS Bedrock and Google Vertex AI:

```yaml
# For AWS Bedrock
use_bedrock: "true"
model: "anthropic.claude-3-7-sonnet-20250219-beta:0"

# For Google Vertex AI
use_vertex: "true"
model: "claude-3-7-sonnet@20250219"
```

### GitHub App Authentication (Optional)

If you prefer to use GitHub App authentication for better security:

1. Install the [Claude Code GitHub App](https://github.com/apps/claude-code)
2. Add these secrets:
   - `CLAUDE_CODE_APP_ID`: Your app ID
   - `CLAUDE_CODE_APP_PRIVATE_KEY`: Your app's private key
3. Update the workflow to use the app token (see examples in the action's documentation)

## Troubleshooting

### Common Issues

1. **API Key Errors**: Ensure your `ANTHROPIC_API_KEY` secret is set correctly
2. **Permission Denied**: Check that workflow permissions are set to "Read and write"
3. **Rate Limits**: Consider using a less powerful model for high-volume PRs
4. **Timeout Issues**: Large PRs may timeout; consider splitting them

### Debug Mode

Enable debug logging by adding to your settings:

```yaml
settings: |
  {
    "env": {
      "DEBUG": "true"
    }
  }
```

## Best Practices

1. **Keep PRs Focused**: Smaller, focused PRs get better reviews
2. **Update Context Files**: Keep README and AGENT_CONTEXT files current
3. **Iterate on Feedback**: Use Claude's feedback to improve your code before merging
4. **Monitor Usage**: Track API usage to manage costs effectively

## Security Considerations

- All reviews are read-only; Claude cannot modify your code
- API keys are stored as encrypted secrets
- No data is retained by the action after the review completes
- Consider using GitHub App authentication for additional security

## Cost Estimation

- **Opus 4**: ~$0.10-0.50 per PR depending on size
- **Sonnet**: ~$0.05-0.25 per PR
- **Haiku**: ~$0.02-0.10 per PR

Factors affecting cost:
- Number of files changed
- Size of context files
- Length of PR description
- Model choice