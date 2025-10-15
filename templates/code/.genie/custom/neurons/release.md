## Project Customization

**Project:** automagik-genie
**Package:** automagik-genie (npm)

### Release Workflow

**Scripts:**
- `pnpm bump:rc` - Create RC version
- `pnpm bump:patch/minor/major` - Create RC for next version
- `pnpm release:stable` - Promote RC to stable

**GitHub Actions:**
- `.github/workflows/publish.yml` - Auto-publish on release creation

**Commands:**
```bash
# Create release
gh release create vX.Y.Z --title "vX.Y.Z - Title" --generate-notes

# Monitor workflow
gh run watch

# Verify npm
npm view automagik-genie@X.Y.Z
```

### Release Notes Template

```markdown
## 🎉 Release Title

Brief description

### ✨ What's New
- Feature 1
- Feature 2

### 📦 Installation
\`\`\`bash
npm install -g automagik-genie@X.Y.Z
\`\`\`

### 🔄 Upgrade Instructions
\`\`\`bash
npm install -g automagik-genie@X.Y.Z
cd project/ && genie update
\`\`\`

### 📚 Documentation
- [UPGRADE_GUIDE.md](link)

**Full Changelog:** https://github.com/namastexlabs/automagik-genie/compare/vA.B.C...vX.Y.Z
```
