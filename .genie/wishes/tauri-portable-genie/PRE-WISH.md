# Pre-Wish: Self-Contained Tauri-Wrapped Genie Application

**Date:** 2025-10-26
**Status:** Research Complete - Ready for Wish Creation
**Complexity:** Medium-High (3-4 weeks estimated)
**Feasibility:** ✅ HIGH - Proven patterns, production-ready technologies

---

## Executive Summary

Wrap Genie CLI + Forge into a self-contained Tauri desktop application where:
- **All user data lives in one portable directory** (backup = copy folder)
- **No Node.js installation required** (bundled as sidecar binary)
- **Terminal UI via xterm.js** (native performance, familiar CLI experience)
- **Self-updating npm packages** (update without rebuilding executable)
- **Cross-platform native app** (Windows, macOS, Linux from single codebase)
- **3x smaller than Electron** (~63MB vs ~205MB)

---

## User Request Context

> "Create a self-contained app where all the data will be cited. The application will run in isolation so that we can tell the users that that file is all they need to move their genie around and save it etc. It must be built in a way that it's easy to export or extract the user data."

> "For instance the Forge uses a local user path to save data. Same for genie. We would have to do something that works within that sandbox environment created by the Tauri application. When I say self contained I mean a standalone app with all data in it, so that the users only have to worry about backup the application."

> "It should be possible to extract the user data somehow, considering the corruption possibility. The same app will update its own npm package, and we will not need to publish new executables, unless we're changing tauri code itself for improvements."

**Key Requirements:**
1. Single-file backup (copy app directory = complete backup)
2. Portable data architecture (no system paths)
3. No external dependencies (bundled Node.js)
4. Terminal UI (CLI-first design preserved)
5. Self-updating (npm packages update in-place)
6. Data export/import (corruption recovery)

---

## Architecture Design

### High-Level Structure

```
Tauri Desktop App
├── Frontend (Rust + WebView)
│   ├── xterm.js (terminal emulator UI)
│   ├── tauri-plugin-pty (native pseudo-terminal)
│   ├── tauri-plugin-fs (portable file system access)
│   └── tauri-plugin-shell (sidecar management)
├── Sidecar Binary (pkg-compiled)
│   ├── Node.js runtime (embedded)
│   ├── Genie CLI (bundled npm package)
│   └── Forge server (bundled npm package)
└── Portable Data Directory
    ├── config/ (executor auth, settings)
    ├── workspaces/ (user projects)
    │   ├── project-1/
    │   │   ├── .genie/ (project metadata)
    │   │   └── .git/
    │   └── project-2/
    ├── forge-data/ (tasks, sessions)
    │   ├── tasks.db (SQLite)
    │   └── worktrees/ (isolated git worktrees)
    └── stats/ (usage tracking)
        ├── sessions.json
        └── stats-history.json
```

### Data Portability Strategy

**Current Storage Locations (System-Dependent):**
```typescript
// CLI Data
~/.config/opencode/providers         // Executor auth
~/.config/gemini-cli/                // Gemini settings
<workspace>/.genie/state/            // Stats, sessions, version

// Forge Data
<workspace>/.genie/                  // Project metadata
<workspace>/.genie/backups/          // Backups
git worktrees (Forge-managed)        // Task attempts
```

**Proposed Portable Architecture:**
```typescript
// Environment variable: GENIE_PORTABLE_ROOT
<app_data_dir>/genie-portable/
├── config/
│   ├── opencode/providers/          // Relocated from ~/.config
│   └── gemini-cli/                  // Relocated from ~/.config
├── workspaces/
│   ├── project-1/
│   │   ├── .genie/state/           // All project data
│   │   └── .git/
│   └── project-2/
├── forge-data/
│   ├── sessions/                    // Forge MCP server data
│   └── worktrees/                   // Isolated task attempts
└── stats/
    ├── sessions.json
    └── stats-history.json
```

**Implementation:**
1. **Path Abstraction Layer** (`.genie/cli/src/lib/portable-paths.ts`):
   ```typescript
   function getGenieRoot(): string {
     return process.env.GENIE_PORTABLE_ROOT || os.homedir();
   }

   function getConfigPath(relativePath: string): string {
     const root = getGenieRoot();
     return path.join(root, 'config', relativePath);
   }

   function getWorkspacePath(projectName: string): string {
     const root = getGenieRoot();
     return path.join(root, 'workspaces', projectName);
   }
   ```

2. **Tauri Integration:**
   - Pass `appDataDir` to Node sidecar on startup
   - Set `GENIE_PORTABLE_ROOT` environment variable
   - All path resolution goes through abstraction layer

3. **Migration Tool:**
   - Detect existing Genie installations
   - Offer to migrate to portable mode
   - Copy data preserving structure

---

## Technical Implementation Details

### 1. Node.js Sidecar Integration

**Method:** Bundle Node.js + Genie using `pkg` tool

**Configuration (`tauri.conf.json`):**
```json
{
  "bundle": {
    "externalBin": ["binaries/genie-node"]
  }
}
```

**Build Process:**
```bash
# Package Genie CLI + Forge into standalone binary
npx @yao-pkg/pkg package.json --output genie-node

# Rename for target triple (automated)
node scripts/rename-sidecar.js

# Result: binaries/genie-node-x86_64-unknown-linux-gnu
```

**Permissions (`capabilities/default.json`):**
```json
{
  "permissions": [
    "core:default",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        {
          "name": "binaries/genie-node",
          "sidecar": true,
          "args": true
        }
      ]
    }
  ]
}
```

**Execution (Rust):**
```rust
use tauri_plugin_shell::ShellExt;

let genie_command = app
    .shell()
    .sidecar("genie-node")
    .unwrap()
    .args(["--portable", app_data_dir.to_str().unwrap()]);

let (mut rx, mut child) = genie_command.spawn().unwrap();
```

**Size:** ~60-70MB bundled (Node.js + Genie + Forge)

---

### 2. Terminal UI Integration

**Technology:** xterm.js + tauri-plugin-pty

**Frontend Setup:**
```bash
pnpm add xterm @xterm/addon-fit
pnpm add @tauri-apps/plugin-shell
```

**Terminal Component (TypeScript):**
```typescript
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Command } from '@tauri-apps/plugin-shell';

const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  theme: {
    background: '#1e1e1e',
    foreground: '#cccccc'
  }
});

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(document.getElementById('terminal'));
fitAddon.fit();

// Start Genie sidecar
const genie = Command.sidecar('genie-node', ['--interactive']);
genie.stdout.on('data', (line) => terminal.write(line));
genie.stderr.on('data', (line) => terminal.write(`\x1b[31m${line}\x1b[0m`));

terminal.onData((data) => {
  genie.write(data); // Send user input to Genie
});

await genie.spawn();
```

**PTY Plugin (Rust):**
```rust
use tauri_plugin_pty::{Pty, PtyConfig};

#[tauri::command]
fn spawn_pty(app: tauri::AppHandle) -> Result<u32, String> {
    let pty = Pty::new(PtyConfig {
        shell: Some("/bin/bash".to_string()),
        env: vec![
            ("GENIE_PORTABLE_ROOT".to_string(), app_data_dir.to_string())
        ],
        ..Default::default()
    }).map_err(|e| e.to_string())?;

    Ok(pty.pid())
}
```

**Proven Examples:**
- `marc2332/tauri-terminal` - Working xterm.js + portable-pty integration
- `terraphim/terraphim-liquid-glass-terminal` - Production Tauri terminal app
- `ElectricSQL` - Embedded psql console using xterm.js in Tauri

---

### 3. Portable File System

**Tauri Plugin Configuration:**
```json
{
  "permissions": [
    "fs:allow-read",
    "fs:allow-write",
    {
      "identifier": "fs:scope",
      "allow": [
        "$APPDATA/genie-portable/**/*"
      ]
    }
  ]
}
```

**Base Directories (TypeScript):**
```typescript
import { BaseDirectory } from '@tauri-apps/plugin-fs';

// Application data directory
await readTextFile('config/settings.json', {
  baseDir: BaseDirectory.AppData
});

// Resource directory (bundled assets)
await readFile('templates/wish.md', {
  baseDir: BaseDirectory.Resource
});

// User documents (optional workspace location)
await exists('my-project/', {
  baseDir: BaseDirectory.Document
});
```

**Path Resolution:**
- **Windows:** `C:\Users\<user>\AppData\Local\com.namastex.genie\genie-portable\`
- **macOS:** `~/Library/Application Support/com.namastex.genie/genie-portable/`
- **Linux:** `~/.local/share/com.namastex.genie/genie-portable/`

---

### 4. Self-Updating Mechanism

**Strategy:** Update npm packages within bundled Node.js runtime

**Update Command (in Genie CLI):**
```bash
genie update --portable
```

**Implementation:**
```typescript
// .genie/cli/src/commands/update.ts
async function updatePortable(appDataDir: string) {
  const packagePath = path.join(appDataDir, 'genie-portable', 'packages');

  // Update Genie CLI
  await execAsync('npm install -g automagik-genie@next', {
    env: {
      NPM_CONFIG_PREFIX: packagePath,
      NODE_PATH: path.join(packagePath, 'node_modules')
    }
  });

  // Update Forge
  await execAsync('npm install -g automagik-forge@next', {
    env: {
      NPM_CONFIG_PREFIX: packagePath,
      NODE_PATH: path.join(packagePath, 'node_modules')
    }
  });

  console.log('✅ Packages updated. Restart Genie to apply changes.');
}
```

**Tauri Code Updates:**
- Require new executable (rare)
- GitHub releases for Tauri updates
- Auto-update via `tauri-plugin-updater` (future enhancement)

---

### 5. Data Export/Backup

**Built-in Commands:**

```bash
# Export entire portable directory as zip
genie export --output ~/Desktop/genie-backup.zip

# Export single workspace
genie export --workspace my-project --output ~/Desktop/my-project.zip

# Import workspace
genie import ~/Desktop/my-project.zip

# Backup everything (copy directory)
cp -r ~/.local/share/com.namastex.genie/genie-portable ~/Backups/
```

**Implementation (Tauri):**
```typescript
import { save } from '@tauri-apps/plugin-dialog';
import { readDir, copyFile, BaseDirectory } from '@tauri-apps/plugin-fs';

async function exportWorkspace(workspaceName: string) {
  const savePath = await save({
    title: 'Export Workspace',
    defaultPath: `${workspaceName}.zip`,
    filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
  });

  if (!savePath) return;

  // Create zip from workspace directory
  const workspacePath = `genie-portable/workspaces/${workspaceName}`;
  await zipDirectory(workspacePath, savePath, BaseDirectory.AppData);

  console.log(`✅ Exported workspace to ${savePath}`);
}
```

---

## Implementation Phases

### Phase 1: Proof of Concept (1 week)
**Goal:** Basic Tauri app with embedded Genie terminal

**Tasks:**
1. Set up Tauri project structure
2. Integrate xterm.js + tauri-plugin-pty
3. Compile Genie CLI to sidecar binary using `pkg`
4. Bundle sidecar with Tauri app
5. Launch Genie in embedded terminal
6. Verify basic commands work

**Deliverables:**
- Running Tauri app with functional Genie terminal
- Proof that sidecar approach works
- Initial bundle size measurement

---

### Phase 2: Portable Architecture (1 week)
**Goal:** All data in portable directory structure

**Tasks:**
1. Create path abstraction layer (`portable-paths.ts`)
2. Refactor CLI to use portable paths
   - Stats tracker (`.genie/cli/src/lib/stats-tracker.ts:92`)
   - Executor auth (`.genie/cli/src/lib/executor-auth.ts:72,176`)
   - Config loading
3. Update Forge MCP server for portable mode
4. Implement `GENIE_PORTABLE_ROOT` environment variable
5. Pass app data directory from Tauri to sidecar
6. Test data isolation (multiple instances)

**Deliverables:**
- All data stored in `<appDataDir>/genie-portable/`
- Zero writes to `~/.config/` or system paths
- Migration tool for existing installations

---

### Phase 3: Self-Updating & Polish (1 week)
**Goal:** Production-ready features

**Tasks:**
1. Implement `genie update --portable` command
2. Handle Forge server restart after updates
3. Add export/import functionality
4. Create backup/restore UI
5. Error handling and recovery
6. Platform-specific packaging (`.app`, `.exe`, `.AppImage`)
7. Testing on Windows, macOS, Linux

**Deliverables:**
- Working self-update mechanism
- Export/import tools
- Installers for all platforms
- User documentation

---

### Phase 4: Documentation & Release (3-5 days)
**Goal:** User-ready release

**Tasks:**
1. Write user guide (installation, backup, migration)
2. Create demo video
3. Publish to GitHub releases
4. Update main Genie docs
5. Community announcement

**Deliverables:**
- Published release artifacts
- Comprehensive documentation
- Migration guide for CLI users

---

## Technical Challenges & Solutions

| Challenge | Solution | Complexity |
|-----------|----------|------------|
| **Node.js runtime bundling** | Use `@yao-pkg/pkg` to compile Node + Genie into standalone binary | ✅ Solved (proven pattern) |
| **Terminal UI in Tauri** | xterm.js + tauri-plugin-pty (production-ready) | ✅ Solved (multiple examples) |
| **Portable data paths** | Path abstraction layer + `GENIE_PORTABLE_ROOT` env var | 🟡 Medium (refactoring required) |
| **Forge worktree management** | Redirect worktree root to portable directory | 🟡 Medium (config changes) |
| **Git operations** | Portable git config paths (`.gitconfig` in app data) | 🟡 Medium (git path overrides) |
| **Self-updating npm** | `npm install` within Node sidecar environment | 🟡 Medium (env variables) |
| **Tauri code updates** | Require new executable (unavoidable) | 🔴 Limitation (rare occurrence) |
| **Cross-platform paths** | Tauri's `BaseDirectory` abstraction | ✅ Solved (built-in) |

---

## Benefits Analysis

### For Users

✅ **Zero Installation Friction**
- No Node.js, npm, or pnpm required
- Download → Run → Start building
- Non-technical users can use Genie

✅ **Dead Simple Backup**
- Copy one folder = complete backup
- No scattered config files
- Portable across machines (same OS)

✅ **Data Safety**
- Export/import for corruption recovery
- Built-in backup tools
- Isolated from system changes

✅ **Familiar CLI Experience**
- Same terminal interface
- All commands work identically
- Muscle memory preserved

✅ **Fast Updates**
- npm packages update without full reinstall
- Only rebuild for Tauri changes (rare)
- Always on latest Genie version

---

### For Development

✅ **Smaller Distribution**
- 63MB vs 205MB (Electron equivalent)
- Faster downloads
- Lower bandwidth costs

✅ **Native Performance**
- Rust backend (faster than Electron)
- Lower memory usage
- Better battery life

✅ **Cross-Platform**
- Single codebase for Windows, macOS, Linux
- Consistent behavior across platforms
- Easier maintenance

✅ **Security**
- Sandboxed file system access
- Explicit permissions model
- No arbitrary system access

---

## Limitations & Trade-offs

⚠️ **Tauri Code Updates**
- Changes to Tauri Rust code require new executable
- Users must download new app version
- **Mitigation:** Rare (only for UI/framework changes)

⚠️ **Git Dependency**
- Still requires system Git installation
- Cannot bundle Git (too large + licensing)
- **Mitigation:** Document in install guide, check on startup

⚠️ **Platform-Specific Builds**
- Cannot cross-compile easily (macOS requires macOS)
- Need CI/CD for multi-platform releases
- **Mitigation:** GitHub Actions runners

⚠️ **Terminal-Only UI**
- No graphical wizards or rich UI components
- CLI-first by design
- **Mitigation:** Aligns with Genie philosophy (feature, not bug)

⚠️ **Initial Learning Curve**
- Users must understand portable mode vs system install
- Migration path for existing users
- **Mitigation:** Clear documentation, migration wizard

---

## Security Considerations

### File System Permissions

**Tauri's Permission Model:**
```json
{
  "permissions": [
    {
      "identifier": "fs:scope",
      "allow": [
        "$APPDATA/genie-portable/**/*"
      ],
      "deny": [
        "$APPDATA/genie-portable/config/secrets.json"
      ]
    }
  ]
}
```

**Best Practices:**
- Minimal permission scope (only app data directory)
- Explicit deny list for sensitive files
- No arbitrary file system access
- Executor API keys encrypted at rest

---

### Sidecar Security

**Execution Controls:**
- Sidecar binary signed with developer certificate
- Arguments validated against allow list
- No shell injection vulnerabilities
- Process isolation (separate PID)

**Code Integrity:**
```json
{
  "identifier": "shell:allow-execute",
  "allow": [
    {
      "name": "binaries/genie-node",
      "sidecar": true,
      "cmd": "",
      "args": [
        "--portable",
        { "validator": "\\S+" }
      ]
    }
  ]
}
```

---

## Comparison: Tauri vs Electron

| Metric | Tauri | Electron |
|--------|-------|----------|
| **Bundle Size** | ~63MB | ~205MB |
| **Memory Usage** | ~100MB | ~300MB |
| **Startup Time** | <1s | 2-3s |
| **Backend Language** | Rust | Node.js |
| **Security Model** | Sandboxed, explicit permissions | Full Node.js access |
| **Update Mechanism** | npm in sidecar + optional Tauri updater | Electron updater |
| **Cross-Platform** | ✅ Windows, macOS, Linux | ✅ Windows, macOS, Linux |
| **Learning Curve** | Higher (Rust + frontend) | Lower (all JS) |
| **Community Size** | Growing | Established |

**Verdict:** Tauri wins for desktop apps prioritizing size, performance, and security.

---

## Success Metrics

### Technical Milestones

- [ ] Tauri app launches and displays terminal
- [ ] Genie CLI commands execute successfully
- [ ] All data writes to portable directory (zero system paths)
- [ ] Export/import workflow validated
- [ ] Self-update mechanism tested
- [ ] Cross-platform builds generated
- [ ] Bundle size <100MB per platform

---

### User Validation

- [ ] Non-technical user installs without assistance
- [ ] User completes full backup/restore cycle
- [ ] User updates npm packages without issues
- [ ] User migrates from CLI install to portable app
- [ ] User reports improved experience vs global install

---

## References & Resources

### Official Documentation
- **Tauri v2 Docs:** https://v2.tauri.app/
- **Sidecar Guide:** https://v2.tauri.app/develop/sidecar/
- **File System Plugin:** https://v2.tauri.app/plugin/file-system/
- **Shell Plugin:** https://v2.tauri.app/plugin/shell/

### Community Examples
- **tauri-terminal:** https://github.com/marc2332/tauri-terminal
  - xterm.js + portable-pty integration
- **terraphim-liquid-glass-terminal:** https://github.com/terraphim/terraphim-liquid-glass-terminal
  - Production Tauri terminal emulator
- **ElectricSQL:** https://electric-sql.com/blog/2024/02/05/local-first-ai-with-tauri-postgres-pgvector-llama
  - Embedded console example

### Tools & Libraries
- **pkg:** https://github.com/yao-pkg/pkg (Node.js to binary)
- **xterm.js:** https://xtermjs.org/ (terminal emulator)
- **tauri-plugin-pty:** https://lib.rs/crates/tauri-plugin-pty (PTY support)

---

## Current Genie Data Locations

### CLI Data Storage
```typescript
// .genie/cli/src/lib/stats-tracker.ts:92
this.dataPath = path.join(workspaceRoot, '.genie/state/stats-history.json');

// .genie/cli/src/lib/executor-auth.ts:72
const providersDir = path.join(os.homedir(), '.config', 'opencode', 'providers');

// .genie/cli/src/lib/executor-auth.ts:176
const settingsPath = path.join(os.homedir(), '.config', 'gemini-cli', 'settings.json');
```

### Files to Refactor
1. `.genie/cli/src/lib/stats-tracker.ts` (workspace-relative paths)
2. `.genie/cli/src/lib/executor-auth.ts` (homedir config paths)
3. `.genie/cli/src/lib/forge-executor.ts` (project config)
4. Forge MCP server (worktree management)

**Refactoring Pattern:**
```typescript
// Before
const configPath = path.join(os.homedir(), '.config', 'opencode');

// After
import { getConfigPath } from './portable-paths';
const configPath = getConfigPath('opencode');
```

---

## Next Steps

### Immediate Actions
1. **Create GitHub issue** with this pre-wish document
2. **Get user approval** on architecture and approach
3. **Set up Tauri project** (`pnpm create tauri-app`)
4. **Start Phase 1** (proof of concept)

### Open Questions
1. Should we support both portable and system install modes?
2. Do we need a migration wizard or just documentation?
3. Should Git be bundled (increases size ~100MB)?
4. Do we need graphical settings UI or CLI-only config?

### Dependencies
- Tauri v2 (stable as of 2024)
- Node.js 20.x (for pkg compilation)
- xterm.js 5.x
- tauri-plugin-pty 0.1.x
- tauri-plugin-shell 2.x
- tauri-plugin-fs 2.x

---

## Estimated Timeline

**Total:** 3-4 weeks (full-time) or 6-8 weeks (part-time)

| Phase | Duration | Status |
|-------|----------|--------|
| Phase 1: PoC | 1 week | Not started |
| Phase 2: Portable | 1 week | Not started |
| Phase 3: Polish | 1 week | Not started |
| Phase 4: Release | 3-5 days | Not started |

**First Milestone:** Working PoC by 2025-11-02 (1 week from now)

---

## Conclusion

Wrapping Genie into a Tauri-based self-contained application is **highly feasible** and aligns perfectly with the goals:

✅ **Self-contained** - All data in portable directory
✅ **No dependencies** - Bundled Node.js runtime
✅ **Easy backup** - Copy folder = complete backup
✅ **Self-updating** - npm packages update in-place
✅ **Native experience** - Fast, small, secure
✅ **Proven approach** - Multiple production examples

**Recommendation:** Proceed with implementation. The technical foundation is solid, benefits are substantial, and risks are manageable.

---

**Research conducted by:** Master Genie
**Date:** 2025-10-26
**Documentation sources:** Tauri official docs (Context7), web research, current Genie codebase analysis
