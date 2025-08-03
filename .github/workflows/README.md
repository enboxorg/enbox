# AI Code Review Workflows

This directory contains comprehensive GitHub Actions workflows for automated AI-powered code reviews on pull requests.

## Workflows Overview

### 1. `ai-code-review.yml`
The main AI code review workflow that provides:
- **OpenAI-based code review** - Analyzes code changes for bugs, improvements, and best practices
- **PR Agent integration** - Comprehensive review focusing on security, performance, and maintainability
- **Code complexity analysis** - Measures cyclomatic complexity and maintainability index
- **Security scanning** - Uses Snyk, Semgrep, and Gitleaks for vulnerability detection
- **Performance analysis** - Bundle size checking and dependency analysis
- **Documentation review** - Checks for missing JSDoc/TSDoc comments

### 2. `ai-test-suggestions.yml`
Automated test generation and coverage analysis:
- **AI-powered test suggestions** - Generates test cases for changed files
- **Coverage analysis** - Runs existing tests and reports coverage metrics
- **Missing test detection** - Identifies files without corresponding test files
- **Mutation testing** - Uses Stryker to assess test quality

### 3. `ai-architecture-review.yml`
Architecture and design pattern analysis:
- **Design pattern detection** - Identifies patterns and anti-patterns
- **SOLID principles analysis** - Checks adherence to software design principles
- **Dependency analysis** - Detects circular dependencies and architectural issues
- **Code metrics** - Lines of code, file distribution, and complexity metrics

## Setup Instructions

### 1. Required Secrets

Add these secrets to your repository (Settings → Secrets and variables → Actions):

- **`OPENAI_API_KEY`** (Required) - Your OpenAI API key for AI-powered reviews
- **`SNYK_TOKEN`** (Optional) - For Snyk security scanning
- **`GITHUB_TOKEN`** (Provided) - Automatically available in workflows

### 2. Workflow Permissions

Ensure your repository has the following permissions enabled:
- Go to Settings → Actions → General
- Under "Workflow permissions", select "Read and write permissions"
- Check "Allow GitHub Actions to create and approve pull requests"

### 3. Optional Configuration

#### Customize AI Review Instructions
Edit the `PR_REVIEWER.EXTRA_INSTRUCTIONS` in `ai-code-review.yml` to focus on your specific needs.

#### Adjust File Filters
Modify the `paths` section in workflows to target specific file types or directories.

#### Configure Complexity Thresholds
Adjust complexity analysis thresholds in the workflow scripts as needed.

## Usage

Once configured, the workflows will automatically trigger on:
- New pull requests
- Updates to existing pull requests
- Synchronization events

The AI will post detailed comments on the PR with:
- Code review feedback
- Security vulnerabilities
- Performance concerns
- Test suggestions
- Architecture recommendations
- Documentation gaps

## Cost Considerations

These workflows use OpenAI API calls which incur costs. To manage expenses:
- Limit the number of files analyzed per PR
- Use path filters to focus on critical code
- Consider using GPT-3.5 instead of GPT-4 for lower costs
- Monitor your OpenAI usage dashboard

## Troubleshooting

### Common Issues

1. **"OpenAI API key not found"**
   - Ensure `OPENAI_API_KEY` secret is properly set

2. **"Resource not accessible by integration"**
   - Check workflow permissions are set to read/write

3. **Rate limiting**
   - OpenAI has rate limits; consider adding retry logic
   - Reduce the number of files analyzed simultaneously

4. **Large PR timeouts**
   - Break down large PRs into smaller ones
   - Increase workflow timeout limits
   - Use file filters to reduce scope

## Customization

### Adding New Analysis Tools

To add new analysis tools:

1. Create a new job in the appropriate workflow
2. Install required tools in the setup steps
3. Run analysis and save results to a markdown file
4. Use the GitHub Script action to post results as PR comments

### Integrating Other AI Providers

To use other AI providers (Anthropic, Cohere, etc.):

1. Replace OpenAI API calls with your provider's SDK
2. Update environment variables and secrets
3. Adjust prompt formats as needed
4. Update model selection parameters

## Best Practices

1. **Start with a subset** - Enable one workflow at a time to understand the output
2. **Tune the prompts** - Customize AI prompts for your team's coding standards
3. **Set expectations** - Inform your team that AI suggestions are advisory
4. **Regular updates** - Keep action versions and dependencies updated
5. **Monitor costs** - Track API usage to avoid unexpected charges

## Support

For issues or questions:
1. Check the [Actions tab](../../actions) for workflow run logs
2. Review GitHub Actions documentation
3. Check the documentation for specific tools (OpenAI, Semgrep, etc.)
4. Open an issue in this repository

## License

These workflows are provided as-is under the same license as the repository.