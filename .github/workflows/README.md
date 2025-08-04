# Claude AI Code Review

A streamlined GitHub Actions workflow for AI-powered code reviews using Claude on pull requests.

## Overview

This workflow uses Claude (Anthropic's AI) to automatically review code changes in pull requests. It provides:

- **Intelligent code analysis** - Claude reviews each changed file for bugs, improvements, and best practices
- **File-by-file feedback** - Detailed review comments for each modified file
- **PR summary** - High-level assessment of the entire pull request
- **Support for multiple languages** - JavaScript, TypeScript, Python, Java, Go, Rust, and more

## How It Works

When a pull request is opened or updated, the workflow:

1. Identifies reviewable code files
2. Sends each file with its changes to Claude for analysis
3. Posts a comprehensive review comment with feedback for each file
4. Provides an overall PR summary with merge readiness assessment

## Setup

### 1. Add Claude API Key

1. Get your API key from [Anthropic Console](https://console.anthropic.com/)
2. Go to your repo Settings → Secrets and variables → Actions
3. Add a new secret named `CLAUDE_API_KEY` with your API key

### 2. Enable Workflow Permissions

1. Go to Settings → Actions → General
2. Under "Workflow permissions", select "Read and write permissions"

That's it! The workflow will automatically run on all new pull requests.

## Configuration

### Model Selection

The workflow uses Claude 3 Opus by default for the highest quality reviews. You can change the model by editing the workflow:

```javascript
model: 'claude-3-opus-20240229',  // Highest quality
// model: 'claude-3-sonnet-20240229',  // Good balance
// model: 'claude-3-haiku-20240307',   // Fastest & cheapest
```

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

The workflow posts two types of comments:

### 1. Detailed File Reviews
```
## 🤖 Claude AI Code Review

I've reviewed 5 file(s) in this PR. Here's my analysis:

### 📄 src/api/users.js

The changes implement a new user authentication endpoint...
[Detailed feedback for each file]
```

### 2. PR Summary
```
## 🎯 PR Summary by Claude

This PR implements user authentication with JWT tokens...
[Overall assessment and merge readiness]
```

## Cost Considerations

- Claude API calls are billed per token
- Opus model is most expensive but provides best results
- Consider using Sonnet or Haiku for routine PRs
- Large files are truncated to 10,000 characters to manage costs

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

## Support

For issues or questions:
1. Check the Actions tab for detailed logs
2. Review [Anthropic's documentation](https://docs.anthropic.com/)
3. Open an issue in this repository