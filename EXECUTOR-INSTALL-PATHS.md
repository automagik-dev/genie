# Executor Installation Paths - FILL THIS IN

Please provide the installation commands/URLs for each executor on each platform.

## 1. Claude (Anthropic's Claude desktop app)
**Command to verify:** `claude`

### macOS
```bash
# Installation method:
brew install --cask claude

# OR download URL:
https://claude.ai/download
```

### Linux (Ubuntu/Debian)
```bash
# Installation method:
[PLEASE PROVIDE]

# OR download URL:
[PLEASE PROVIDE]
```

### Linux (Fedora/RHEL)
```bash
# Installation method:
[PLEASE PROVIDE]

# OR download URL:
[PLEASE PROVIDE]
```

### Windows/WSL
```bash
# Installation method:
[PLEASE PROVIDE]

# OR download URL:
[PLEASE PROVIDE]
```

---

## 2. ChatGPT (codex-cli)
**Command to verify:** `codex`

### All Platforms (npm)
```bash
npm install -g codex-cli
```

### Authentication
```bash
# Method 1: Interactive login
codex auth login

# Method 2: API key
codex auth set-api-key <YOUR_API_KEY>

# Where to get API key:
https://platform.openai.com/api-keys
```

---

## 3. Cline (VSCode Extension)
**Command to verify:** `code` + extension check

### VSCode Installation
#### macOS
```bash
brew install --cask visual-studio-code
```

#### Linux (Ubuntu/Debian)
```bash
snap install code --classic

# OR
wget -O code.deb 'https://code.visualstudio.com/sha/download?build=stable&os=linux-deb-x64'
sudo dpkg -i code.deb
```

#### Linux (Fedora/RHEL)
```bash
[PLEASE PROVIDE]
```

### Extension Installation (All Platforms)
```bash
code --install-extension saoudrizwan.claude-dev
```

**Extension ID:** `saoudrizwan.claude-dev`
**Marketplace:** https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev

---

## 4. Cursor (AI-first IDE)
**Command to verify:** `cursor`

### macOS
```bash
# Installation method:
[PLEASE PROVIDE - is it brew install --cask cursor?]

# OR download URL:
https://cursor.sh
```

### Linux
```bash
# Installation method:
[PLEASE PROVIDE]

# OR download URL:
https://cursor.sh
```

### Windows/WSL
```bash
# Installation method:
[PLEASE PROVIDE]
```

---

## 5. Continue (VSCode Extension)
**Command to verify:** `code` + extension check

### VSCode Installation
Same as Cline above

### Extension Installation (All Platforms)
```bash
code --install-extension continue.continue
```

**Extension ID:** `continue.continue`
**Marketplace:** https://marketplace.visualstudio.com/items?itemName=Continue.continue

---

## 6. OpenCoder (Local/Self-hosted)
**Command to verify:** `opencoder` OR custom

### Installation
```bash
# Installation method:
[PLEASE PROVIDE - Docker? npm? binary download?]
```

### Configuration
```bash
# How to configure/setup:
[PLEASE PROVIDE]
```

---

## Questions to Clarify:

1. **Claude desktop app:**
   - Is there a Homebrew cask for it?
   - Linux installation method?
   - Does it have a CLI command `claude` or is it GUI-only?

2. **Cursor:**
   - Is there a Homebrew formula?
   - Does `cursor` command work in terminal?
   - Linux installation package/method?

3. **Priority order:**
   - Which executors should we prioritize? (I'll implement in order of priority)
   - My suggestion: ChatGPT first (most universal), then Claude, then others

4. **Authentication:**
   - ChatGPT: Implement `codex auth login` flow now
   - Others: Just verify installation (login later)?

---

## Once you fill this in, I will:
1. Create verification functions for each executor
2. Create installation functions with OS detection
3. Create authentication flow (ChatGPT first)
4. Build interactive menu
5. Integrate into start.sh
