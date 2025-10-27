# Genie - Research Preview Disclaimer

## Experimental Software Notice

**Genie is experimental software currently in research preview (Release Candidate stage).** This AI agent system is under active development and has not yet reached stable production release.

## What Genie Does

Genie is an autonomous AI agent orchestration framework that installs to your local machine with capabilities to:

- **Read and write files** in your workspace
- **Execute terminal commands** on your behalf
- **Perform git operations** including commits, pushes, and pull request creation
- **Run tests, builds, and CI/CD workflows**
- **Orchestrate development tasks** across multiple AI agents
- **Learn and adapt** through meta-learning capabilities

## User Responsibilities

By installing and using Genie, you acknowledge and accept the following:

### 1. Experimental Nature
- This software is **experimental** and under **active development**
- Features may change, break, or behave unexpectedly
- No stable releases exist yet (all releases are tagged `@latest` or `-rc.X`)
- Bugs, errors, and unexpected behaviors should be expected

### 2. Agent Actions & Oversight
- **You are responsible for reviewing all actions** performed by Genie agents
- Agents may make mistakes, produce incorrect code, or take unexpected actions
- Always verify changes before committing, pushing, or deploying
- Use version control (git) to track and revert unwanted changes
- Test thoroughly before production use

### 3. Data & Privacy Responsibility
- **You are responsible for understanding what data Genie processes**
- Configure LLM providers that comply with your organization's policies
- Use only LLM subscriptions approved for your use case (personal/professional)
- Be aware that data sent to LLM APIs leaves your local machine
- Consider using local/private LLMs for sensitive workspaces (OpenCoder executor available)

### 4. Security Considerations
- Genie has **full access to your workspace** where it's installed
- Agents can execute arbitrary commands with your user permissions
- Review agent configurations and prompts before execution
- Do not run Genie in environments with sensitive credentials or production systems without proper safeguards
- Use dedicated test/development environments for experimentation

## Data Privacy & Security

### What Stays Local
✓ **All Genie code and orchestration** runs locally on your machine
✓ **Your workspace files** never leave your computer (except via LLM API calls)
✓ **Forge backend** runs locally (http://localhost:8887)
✓ **MCP server** runs locally (http://localhost:8885)
✓ **Session state, logs, and history** stored locally in `.genie/state/`

### What Leaves Your Machine
⚠️ **LLM API calls** - Code, prompts, and context sent to your configured LLM provider
⚠️ **Version checks** - npm registry queries to check for updates
⚠️ **Optional telemetry** (if enabled) - Anonymous usage statistics

### Privacy Recommendations
- **For personal projects**: Use any LLM provider you trust
- **For professional work**: Use LLM providers approved by your organization
- **For sensitive data**: Use local/private LLMs (e.g., OpenCoder executor with local models)
- **For compliance**: Configure Genie to use your organization's approved AI infrastructure

## No Warranties or Liability

### Disclaimer of Warranties
**NAMASTEX LABS PROVIDES GENIE "AS IS" WITHOUT WARRANTY OF ANY KIND**, either express or implied, including but not limited to:

- Warranties of merchantability
- Fitness for a particular purpose
- Non-infringement
- Accuracy, reliability, or completeness of results

### Limitation of Liability
**IN NO EVENT SHALL NAMASTEX LABS BE LIABLE** for any:

- Direct, indirect, incidental, or consequential damages
- Loss of data, profits, or business opportunities
- Damages arising from use or inability to use the software
- Damages caused by agent actions, mistakes, or errors
- Any other damages or losses arising from your use of Genie

This limitation applies regardless of the legal theory (contract, tort, negligence, or otherwise), even if Namastex Labs has been advised of the possibility of such damages.

## Your Acknowledgment

By proceeding with installation and use of Genie, you acknowledge that:

1. ✓ You have read and understood this disclaimer
2. ✓ You accept the experimental nature of this software
3. ✓ You accept responsibility for reviewing all agent actions
4. ✓ You accept responsibility for data privacy and security
5. ✓ You accept that Namastex Labs provides no warranties
6. ✓ You accept that Namastex Labs has no liability for damages
7. ✓ You will use Genie in compliance with your organization's policies
8. ✓ You understand this is **research preview software**, not production-ready

## BUT HEY... IT'S GOING TO BE FUN! 🎉✨

Despite all the serious legal stuff above, Genie is designed to make development **faster, smarter, and more enjoyable**. We're building the future of autonomous development workflows, and you're invited to be part of the journey!

### What Makes It Fun
- 🧞 **Conversational AI agents** that understand your intent
- 🔮 **Autonomous execution** - delegate tasks and get results
- ✨ **Meta-learning** - agents that improve themselves over time
- 🎩 **Extensible architecture** - create your own agents and workflows
- 🌟 **Active development** - new features and improvements constantly

### Join the Community
- **Report bugs**: [GitHub Issues](https://github.com/namastexlabs/automagik-genie/issues)
- **Request features**: [GitHub Discussions](https://github.com/namastexlabs/automagik-genie/discussions)
- **Contribute**: [Contributing Guide](CONTRIBUTING.md)
- **Stay updated**: Watch releases on GitHub

## License

Genie is open source software licensed under the MIT License. See [LICENSE](LICENSE) for full terms.

---

**Version**: Research Preview (RC builds, `@latest` tag)
**Status**: Experimental - Not for production use
**Last Updated**: 2025-10-23

**Questions?** Open an issue on GitHub or check our documentation at the project repository.
