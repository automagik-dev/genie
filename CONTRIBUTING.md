# Contributing to Automagik Genie

Thank you for your interest in contributing to Automagik Genie! We're building the universal development companion that keeps AI agents and repositories in sync, and we'd love your help.

## 🚀 Quick Start

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<YOUR_USERNAME>/automagik-genie`
3. Install dependencies: `pnpm install`
4. Create a branch: `git checkout -b feat/your-feature-name`
5. Make your changes
6. Test: `pnpm run test:genie`
7. Push and create a Pull Request

## 📋 What We're Looking For

- Improvements to the bootstrap CLI (`init`, `update`, `rollback`)
- Template migration enhancements for `.claude` → `.genie`
- Better MCP tooling and agent documentation
- Developer experience upgrades (diff previews, JSON output, etc.)

### Code Quality Standards
- **Tests**: Add tests for new features (aim for ~80% coverage of touched files)
- **Documentation**: Update README/docs when adding features or CLI flags
- **Type hints**: Use TypeScript types (no implicit `any`, prefer explicit interfaces)
- **Async patterns**: Prefer `async/await`, return `Promise` values from CLI helpers

## 🛠️ Development Process

### 1. Setting Up

```bash
# Clone and install
git clone https://github.com/namastexlabs/automagik-genie
cd automagik-genie
pnpm install

# Run tests to verify setup
pnpm run test:genie
```

#### Optional: Forge Backend Integration

Genie now supports Automagik Forge as the primary backend for session management (RC28+). This is **optional** for development but recommended for testing the full feature set.

```bash
# Start Forge backend (optional)
cd /path/to/automagik-forge
pnpm dev

# Configure Genie to use Forge
export FORGE_BASE_URL="http://localhost:3000"

# Now Genie commands use Forge backend
npx automagik-genie run analyze "test"
```

**Benefits of Forge integration:**
- Faster session creation (<5s vs 5-20s)
- Worktree isolation (safe parallel execution)
- Postgres-backed state (no file corruption)
- Eliminates 6+ critical bugs (#115, #92, #91, #93, #104, #122)

**See also:** `@.genie/agents/forge.md` for Forge agent usage and workflows.

### 2. Development Workflow

1. Create a descriptive branch (`feat/cli-diff-preview`)
2. Implement changes under `.genie/cli/src/`
3. Rebuild the dist bundle: `pnpm run build:genie`
4. Run tests: `pnpm run test:genie`
5. Stage changed source *and* the generated `.genie/cli/dist/**/*`
6. Commit using Conventional Commits and include the Genie co-author line

### 3. Testing

```bash
# Run all CLI + smoke tests
pnpm run test:genie

# Run a smoke test for init/update manually (optional)
node .genie/cli/dist/genie.js init --help

# Check coverage (optional for now)
pnpm run test:genie -- --coverage
```

### 4. Code Style

```bash
# Format TypeScript (if you have prettier installed globally)
pnpm exec prettier --write ".genie/cli/src/**/*.ts"

# Type-check by rebuilding
pnpm run build:genie  # (or your equivalent tsc invocation)
```

If you don't use Prettier, ensure your editor formats TypeScript consistently. The TypeScript build (`pnpm run build:genie`) must succeed.

## 📝 Pull Request Guidelines

### PR Title Format
Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat: add update preview diff`
- `fix: handle migration of custom hooks`
- `docs: refresh README hero section`

### PR Description Template

```markdown
## What
Brief description of changes

## Why
Motivation behind the change

## How to Test
1. Step-by-step testing instructions
2. Expected behaviour

## Breaking Changes
- List any breaking changes (if applicable)

## Screenshots / Demos
- Visual proof if UI/UX output changed
```

### Checklist
- [ ] Tests pass (`pnpm run test:genie`)
- [ ] Dist bundle rebuilt (`pnpm run build:genie`)
- [ ] Documentation updated (if needed)
- [ ] Added tests for new features
- [ ] PR title follows Conventional Commits
- [ ] Commit includes co-author: `Co-authored-by: Automagik Genie 🧞 <genie@namastex.ai>`

## 🧪 Testing Guidelines

### Unit Tests
Add/extend tests in `tests/genie-cli.test.js` or create new suites under `tests/` for CLI helpers.

### Integration Tests
Use disposable folders (e.g. `/tmp/genie-*`) to exercise `init`, `update`, and `rollback` flows end-to-end.

## 📚 Documentation

When adding features, update:
- `README.md` for user-facing CLI changes
- `docs/` (or create new docs) for extended guides
- Inline docstrings/comments for complex logic

## 🎯 Commit Guidelines

```
<type>(<scope>): <subject>

<body>

Co-authored-by: Automagik Genie 🧞 <genie@namastex.ai>
```

Example:
```
feat(cli): add provider status cache

Adds provider-status.json cache and reset hooks to avoid repeated
network checks during CLI runs.

Co-authored-by: Automagik Genie 🧞 <genie@namastex.ai>
```

## 🤝 Code of Conduct

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Focus on constructive feedback
- Assume good intentions
- Zero tolerance for harassment or discrimination

## 💬 Getting Help

- **Discord**: [Join our community](https://discord.gg/xcW8c7fF3R)
- **Issues**: Check existing issues or create a new one
- **Discussions**: Use GitHub Discussions for Q&A
- **Twitter**: Follow [@namastexlabs](https://twitter.com/namastexlabs)

## 🎯 Priority Areas

- Enhanced diffing/merge logic for `update`
- Robust migration paths for edge-case `.claude` projects
- Provider health checks + auto-detection ecosystem
- MCP ergonomics (JSON output, transcripts, etc.)

## 🏆 Recognition

Contributors are:
- Listed in the README
- Mentioned in release notes
- Invited to the contributors Discord channel
- Credited in the project

## 🔒 Security Issues

If you discover a security vulnerability, email genie@namastex.ai instead of opening a public issue. We'll respond promptly.

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

**Thank you for contributing to Automagik Genie!** 🚀

Every contribution, no matter how small, helps keep AI development workflows reliable and delightful.
