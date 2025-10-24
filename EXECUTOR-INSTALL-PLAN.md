# Executor Installation & Authentication Plan

## ✅ IMPLEMENTATION COMPLETE

## 🎯 Goal
Interactive executor selection, installation, and authentication in start.sh

## 📋 Implementation Status: DONE

## 📋 Executors to Support

### Friendly Names Mapping
```bash
1. Claude (claude-code)      → command: claude
2. ChatGPT (codex)           → command: codex
3. Cline (VSCode extension)  → verify VSCode + extension
4. Cursor (IDE)              → command: cursor
5. Continue (VSCode ext)     → verify VSCode + extension
```

## 🏗️ Architecture

### Helper Functions Structure

```bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# EXECUTOR MANAGEMENT - Verification, Installation, Authentication
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Executor definitions (name, command, friendly name)
declare -A EXECUTORS=(
    [claude]="claude|Claude"
    [chatgpt]="codex|ChatGPT"
    [cline]="code|Cline"
    [cursor]="cursor|Cursor"
    [continue]="code|Continue"
)

# Verification functions
verify_claude() { ... }
verify_chatgpt() { ... }
verify_cline() { ... }
verify_cursor() { ... }
verify_continue() { ... }

# Installation functions
install_claude() { ... }
install_chatgpt() { ... }
install_cline() { ... }
install_cursor() { ... }
install_continue() { ... }

# Authentication functions
login_claude() { ... }        # Future
login_chatgpt() { ... }       # Implement now
login_cline() { ... }         # Future
login_cursor() { ... }        # Future
login_continue() { ... }      # Future

# Menu selection
select_executor_interactive() { ... }
```

## 📝 Installation Methods

### 1. Claude (claude-code)
**Command:** `claude`
**Verify:** `command -v claude`
**Install:**
```bash
# macOS
brew install --cask claude

# Linux
# Provide download URL + manual install instructions
echo "Download from: https://claude.ai/download"
```

### 2. ChatGPT (codex)
**Command:** `codex`
**Verify:** `command -v codex`
**Install:**
```bash
# All platforms (npm)
npm install -g codex-cli
```
**Login:**
```bash
codex auth login
# Or with API key
codex auth set-api-key <key>
```

### 3. Cline (VSCode Extension)
**Command:** `code` (VSCode)
**Verify:**
1. `command -v code`
2. `code --list-extensions | grep saoudrizwan.claude-dev`
**Install:**
```bash
# VSCode first (if missing)
# macOS
brew install --cask visual-studio-code
# Linux (Ubuntu/Debian)
snap install code --classic

# Then extension
code --install-extension saoudrizwan.claude-dev
```

### 4. Cursor (IDE)
**Command:** `cursor`
**Verify:** `command -v cursor`
**Install:**
```bash
# macOS
brew install --cask cursor

# Linux
# Download from https://cursor.sh
```

### 5. Continue (VSCode Extension)
**Command:** `code` (VSCode)
**Verify:**
1. `command -v code`
2. `code --list-extensions | grep continue.continue`
**Install:**
```bash
# VSCode first (if missing)
# Then extension
code --install-extension continue.continue
```

## 🎨 Interactive Menu Flow

```
🧞 Select Your AI Executor
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Claude          - Anthropic's Claude desktop app
2. ChatGPT         - OpenAI's ChatGPT (via codex-cli)
3. Cline           - Claude in VSCode (extension)
4. Cursor          - AI-first code editor
5. Continue        - Open-source AI coding assistant

Enter number (1-5): _
```

## 🔄 Installation Flow

```bash
1. Show menu
2. User selects number (1-5)
3. Verify executor installed
   ├─ If installed → ✅ Ready
   └─ If NOT installed:
      ├─ Show installation instructions
      ├─ Ask: "Install now? (y/n)"
      └─ Install if user confirms
4. Login/authenticate (if applicable)
   ├─ ChatGPT → codex auth login (NOW)
   └─ Others → skip (FUTURE)
5. Continue with Genie installation
```

## 🎯 Implementation Checklist

### Phase 1: Verification (All Executors)
- [ ] verify_claude()
- [ ] verify_chatgpt()
- [ ] verify_cline()
- [ ] verify_cursor()
- [ ] verify_continue()

### Phase 2: Installation (All Executors)
- [ ] install_claude()
- [ ] install_chatgpt()
- [ ] install_cline()
- [ ] install_cursor()
- [ ] install_continue()

### Phase 3: Authentication (ChatGPT Only for Now)
- [ ] login_chatgpt() - IMPLEMENT
- [ ] login_claude() - STUB (future)
- [ ] login_cline() - STUB (future)
- [ ] login_cursor() - STUB (future)
- [ ] login_continue() - STUB (future)

### Phase 4: Integration
- [ ] select_executor_interactive() menu
- [ ] Integrate into start.sh main flow
- [ ] Update genie init to use friendly names

## 💡 User Experience

**Before:**
```
Uses default executor (codex)
No verification
No installation
No authentication
User gets cryptic errors
```

**After:**
```
🧞 Select Your AI Executor
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Claude          - Anthropic's Claude desktop app
2. ChatGPT         - OpenAI's ChatGPT (via codex-cli)
3. Cline           - Claude in VSCode (extension)
4. Cursor          - AI-first code editor
5. Continue        - Open-source AI coding assistant

Enter number (1-5): 2

🔍 Checking if ChatGPT (codex-cli) is installed...
❌ ChatGPT not installed

📦 Would you like to install ChatGPT now? (y/n): y

⚡ Installing ChatGPT via npm...
✅ ChatGPT installed successfully!

🔑 ChatGPT requires authentication
   Run: codex auth login
   Or set API key: codex auth set-api-key <key>

Press Enter to authenticate now, or Ctrl+C to skip:
[launches codex auth login]

✅ ChatGPT authenticated successfully!
✅ You're ready to use Genie with ChatGPT!
```

## 📊 Error Handling

```bash
# Executor not found after installation
→ Show manual installation URL
→ Continue with next step (don't block)

# Authentication fails
→ Show error message
→ Provide manual auth command
→ Continue (Genie still installs)

# User cancels installation
→ Warn: "You'll need to install ChatGPT manually"
→ Continue with Genie installation
```

## 🔐 Security

- API keys stored by executor (not by our script)
- OAuth handled by executor CLI
- No credentials in start.sh
- User controls authentication flow

## 🚀 Future Enhancements

- [ ] Support for local models (Ollama, LM Studio)
- [ ] Multiple executor selection (use more than one)
- [ ] Executor switching (genie switch-executor)
- [ ] Authentication status check (genie status)
