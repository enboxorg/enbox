# Claude AI Code Review - Detailed Documentation

## Overview

This document contains detailed information about the Claude AI Code Review workflow that provides principal engineer-level code reviews.

## How It Works

When a pull request is opened or updated, the workflow:

1. **Learns your codebase** - Reads README.md, AGENT_CONTEXT.md, package.json files, and other documentation
2. **Understands the context** - Analyzes your project structure, dependencies, and architectural patterns  
3. **Reviews like a principal engineer** - Evaluates each file against your established standards and patterns
4. **Provides strategic assessment** - Delivers both tactical code feedback and strategic architectural guidance
5. **Makes a recommendation** - Clear merge decision with specific conditions and follow-up items

## What Makes This Different

Unlike generic AI code reviews, this workflow:

- **Has context** - Claude understands your specific codebase, not just general best practices
- **Maintains standards** - Enforces YOUR team's patterns, conventions, and quality bar
- **Thinks long-term** - Considers technical debt, scalability, and architectural evolution
- **Reviews holistically** - Understands how changes fit into the larger monorepo structure

## Context Files Used

The workflow reads these files to understand your codebase:

- `README.md` - Project overview and goals
- `AGENT_CONTEXT.md` - Specific context for AI agents
- `GETTING_STARTED.md` - Development patterns and setup
- `package.json` files - Dependencies and project structure
- Package-specific READMEs in the monorepo

## Configuration

### Model Selection

The workflow uses Claude 3 Opus by default for principal engineer-level analysis:

```javascript
model: 'claude-3-opus-20240229',     // Principal engineer-level reviews
// model: 'claude-3-sonnet-20240229',  // Senior engineer-level
// model: 'claude-3-haiku-20240307',   // Quick code checks
```

### Temperature Setting

The workflow uses a low temperature (0.3) for consistent, analytical reviews. This ensures Claude provides thoughtful, precise feedback rather than creative interpretations.

### File Limits

By default, the workflow reviews up to 10 files per PR to avoid timeouts. You can adjust this in the workflow:

```javascript
for (const file of files.slice(0, 10)) { // Change 10 to your preferred limit
```

### Supported File Types

The workflow reviews files with these extensions:
- JavaScript/TypeScript: `.js`, `.jsx`, `.ts`, `.tsx`
- Python: `.py`
- Java: `.java`
- Go: `.go`
- Rust: `.rs`
- Ruby: `.rb`
- PHP: `.php`
- C#: `.cs`
- C/C++: `.c`, `.cpp`, `.h`
- Swift: `.swift`
- Kotlin: `.kt`

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

### Risk Analysis
- **Primary Risk**: The new OAuth flow bypasses our rate limiting middleware
- **Security**: Token storage needs encryption (HIGH PRIORITY)
- **Production Impact**: Low risk if above issues are addressed

### Recommendation
**NOT READY TO MERGE** - Two must-fix items:
1. Implement rate limiting for OAuth endpoints
2. Encrypt refresh tokens in storage

### Follow-up Work
- Add integration tests for the OAuth flow
- Update API documentation
- Consider extracting OAuth logic into a dedicated service (future PR)
```

## Maximizing Review Quality

To get the best principal engineer-level reviews:

1. **Keep your context files updated** - Especially AGENT_CONTEXT.md and README.md
2. **Document your patterns** - The more Claude knows about your standards, the better
3. **Be specific in PR descriptions** - Help Claude understand the strategic intent
4. **Define your architecture** - Document your architectural decisions and principles

## Cost Considerations

- Claude API calls are billed per token
- Opus provides principal engineer-level analysis but costs more
- Context files add tokens but dramatically improve review quality
- Large files are truncated to 15,000 characters
- Budget approximately $0.10-0.50 per PR depending on size

## Troubleshooting

### Common Issues

1. **"Claude API key not found"**
   - Verify `CLAUDE_API_KEY` secret is set correctly

2. **Timeout errors**
   - Reduce the number of files reviewed per PR
   - Use a faster model (Sonnet or Haiku)

3. **No review posted**
   - Check the Actions tab for error logs
   - Ensure PR contains supported file types

## Privacy & Security

- Code is sent to Anthropic's API for analysis
- Only changed files are sent, not the entire codebase
- Review the [Anthropic Privacy Policy](https://www.anthropic.com/privacy)
- Consider using self-hosted alternatives for sensitive code