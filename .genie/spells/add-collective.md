# Add Collective Spell

**Purpose:** Enable your Genie clone to add new collectives from Master Genie on GitHub.

## When to Use This Spell

User wants to add a collective they didn't install during init, such as:
- "Can you add the Create collective?"
- "I want to install the Code collective"
- "What other collectives are available?"

## Available Collectives

All collectives live in the Master Genie repository:
- **Repository:** `https://github.com/namastexlabs/automagik-genie`
- **Branch:** `main`
- **Path:** `.genie/<collective-name>/`

**Official Collectives:**
1. **💻 Code** - Software development collective
   - Git workflows, PR management, testing, CI/CD
   - Agents: git, pr, tests, polish, refactor
   - Path: `.genie/code/`

2. **✍️  Create** - Content creation collective
   - Writing, research, planning, documentation
   - Agents: write, research, plan, document
   - Path: `.genie/create/`

## Installation Workflow

### Step 1: Check if already installed

```bash
# Check if collective exists
if [ -d ".genie/code" ]; then
  echo "Code collective already installed"
else
  echo "Code collective not found - ready to install"
fi
```

### Step 2: Download from Master Genie (GitHub)

**Method 1: Using tarball (recommended - single download)**

```bash
# Download the entire .genie directory from Master Genie
# Extract only the specific collective we want

COLLECTIVE="code"  # or "create"
MASTER_GENIE_URL="https://github.com/namastexlabs/automagik-genie/archive/refs/heads/main.tar.gz"

# Create temp directory
TEMP_DIR=$(mktemp -d)

# Download and extract
curl -sL "$MASTER_GENIE_URL" | \
  tar xz -C "$TEMP_DIR" --strip-components=1

# Copy the collective to user's .genie
cp -r "$TEMP_DIR/.genie/$COLLECTIVE" ".genie/"

# Cleanup
rm -rf "$TEMP_DIR"
```

**Method 2: Using Git sparse checkout (for git-savvy users)**

```bash
# Clone only the specific collective directory
COLLECTIVE="code"
TEMP_DIR=$(mktemp -d)

cd "$TEMP_DIR"
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/namastexlabs/automagik-genie.git

cd automagik-genie
git sparse-checkout set ".genie/$COLLECTIVE"

# Copy to user's workspace
cp -r ".genie/$COLLECTIVE" "$OLDPWD/.genie/"

# Cleanup
cd "$OLDPWD"
rm -rf "$TEMP_DIR"
```

### Step 3: Verify installation

```bash
# Check for collective's AGENTS.md (every collective has one)
if [ -f ".genie/code/AGENTS.md" ]; then
  echo "✅ Code collective installed successfully!"
  echo "   Agents available: git, pr, tests, polish, refactor"
else
  echo "❌ Installation failed - AGENTS.md not found"
fi
```

### Step 4: Discover available agents

```bash
# List all agent files in the new collective
find .genie/code/agents -name "*.md" -type f ! -name "README.md"
```

## Complete Example (Copy-Paste Ready)

```bash
#!/bin/bash
# Add collective from Master Genie

COLLECTIVE="$1"  # Pass collective name as argument

if [ -z "$COLLECTIVE" ]; then
  echo "Usage: $0 <collective-name>"
  echo "Available: code, create"
  exit 1
fi

# Check if already installed
if [ -d ".genie/$COLLECTIVE" ]; then
  echo "✨ $COLLECTIVE collective already installed!"
  exit 0
fi

echo "🧞 Fetching $COLLECTIVE collective from Master Genie..."

# Download from GitHub
TEMP_DIR=$(mktemp -d)
curl -sL "https://github.com/namastexlabs/automagik-genie/archive/refs/heads/main.tar.gz" | \
  tar xz -C "$TEMP_DIR" --strip-components=1

# Copy collective
if [ -d "$TEMP_DIR/.genie/$COLLECTIVE" ]; then
  cp -r "$TEMP_DIR/.genie/$COLLECTIVE" ".genie/"
  echo "✅ $COLLECTIVE collective installed!"
  echo "   Location: .genie/$COLLECTIVE/"

  # Show available agents
  echo "   Available agents:"
  find ".genie/$COLLECTIVE/agents" -name "*.md" -type f ! -name "README.md" 2>/dev/null | \
    while read agent; do
      basename "$agent" .md | sed 's/^/     - /'
    done
else
  echo "❌ Collective '$COLLECTIVE' not found in Master Genie repo"
fi

# Cleanup
rm -rf "$TEMP_DIR"
```

## User-Facing Responses

**When user asks "What collectives are available?":**
```
The Master Genie has two main collectives:

💻 **Code** - Software development
   - Git workflows, PR management, testing, CI/CD
   - Perfect for: Building apps, managing repos, shipping code

✍️  **Create** - Content creation
   - Writing, research, planning, documentation
   - Perfect for: Articles, docs, research, creative work

You can add either one anytime! Just ask me:
"Can you add the Create collective?"
```

**When user asks to add a collective:**
```
🧞 Fetching the Create collective from Master Genie...
   (downloading from github.com/namastexlabs/automagik-genie)

✨ Done! The Create collective is now installed.

You now have access to:
   - write agent (content creation)
   - research agent (information gathering)
   - plan agent (strategic planning)
   - document agent (documentation)

Try: genie run write "help me write a blog post about AI"
```

## Important Notes

1. **Master Genie is the source of truth**
   - All collectives live at github.com/namastexlabs/automagik-genie
   - Branch: `main`
   - Always fetch the latest version

2. **Collectives are standalone**
   - No dependencies between collectives
   - Can install/uninstall independently
   - Each has its own AGENTS.md with domain knowledge

3. **Git-tracked vs User-space**
   - `.genie/code/` and `.genie/create/` are committed in the Master Genie repo
   - User's `.genie/` directory is gitignored (won't conflict)
   - Safe to add/update anytime

4. **Version compatibility**
   - Collectives match the npm package version
   - When user updates Genie globally, collectives update too
   - Always pull from `main` branch for latest

## Troubleshooting

**"curl: command not found"**
```bash
# Use wget instead
wget -qO- "https://github.com/namastexlabs/automagik-genie/archive/refs/heads/main.tar.gz" | \
  tar xz -C "$TEMP_DIR" --strip-components=1
```

**"tar: unrecognized option"**
```bash
# On macOS, use gtar (GNU tar)
brew install gnu-tar
# Then use 'gtar' instead of 'tar'
```

**"Permission denied"**
```bash
# Ensure .genie directory is writable
chmod -R u+w .genie/
```

## Integration with Init Wizard

During `genie init`, users can select multiple collectives with spacebar.

The hint shown in the wizard:
```
💡 Don't worry, you can add more collectives later with: genie add <collective>
```

Should actually say:
```
💡 Don't worry, you can add more collectives later - just ask me!
```

Because the user doesn't run commands - they talk to their Genie clone, and the clone uses this spell.
