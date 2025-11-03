# 🧞 MULTI-TEMPLATE ARCHITECTURE WISH
**Status:** DRAFT
**GitHub Issue:** #37 - Multi-template architecture for project-type scaffolds
**Roadmap Item:** INIT-TEMPLATES – Separate framework dev from distribution templates + support project-type scaffolds
**Mission Link:** @.genie/product/mission.md §Pitch
**Completion Score:** 0/100 (updated by `/review`)

## Evaluation Matrix (100 Points Total)

### Discovery Phase (30 pts)
- **Context Completeness (10 pts)**
  - [ ] Current template mechanism fully mapped (4 pts)
  - [ ] Target template types identified (Next.js, Rust, etc.) (3 pts)
  - [ ] Versioning strategy documented (3 pts)
- **Scope Clarity (10 pts)**
  - [ ] Clear separation between framework dev and distribution (3 pts)
  - [ ] Template CLI interface designed (4 pts)
  - [ ] Out-of-scope explicitly stated (3 pts)
- **Evidence Planning (10 pts)**
  - [ ] Test scenarios for each template type (4 pts)
  - [ ] Artifact storage paths specified (3 pts)
  - [ ] Approval checkpoints documented (3 pts)

### Implementation Phase (40 pts)
- **Code Quality (15 pts)**
  - [ ] Clean separation of templates/ from framework .genie/ (5 pts)
  - [ ] Template selection logic follows best practices (5 pts)
  - [ ] No duplication between template types (5 pts)
- **Test Coverage (10 pts)**
  - [ ] Unit tests for template discovery (4 pts)
  - [ ] Integration tests for genie init --template (4 pts)
  - [ ] E2E tests for each template type (2 pts)
- **Documentation (5 pts)**
  - [ ] Template authoring guide complete (2 pts)
  - [ ] CLI help text clear (2 pts)
  - [ ] Template README.md examples (1 pt)
- **Execution Alignment (10 pts)**
  - [ ] Stayed within scope (4 pts)
  - [ ] Template versioning implemented (3 pts)
  - [ ] Framework dev workflow preserved (3 pts)

### Verification Phase (30 pts)
- **Validation Completeness (15 pts)**
  - [ ] Base template clean (no framework context) (6 pts)
  - [ ] Next.js template includes working scaffold (5 pts)
  - [ ] Template versions bump independently (4 pts)
- **Evidence Quality (10 pts)**
  - [ ] Before/after directory structures captured (4 pts)
  - [ ] Template init outputs logged (3 pts)
  - [ ] Version compatibility matrix documented (3 pts)
- **Review Thoroughness (5 pts)**
  - [ ] Human approval for base template cleanup (2 pts)
  - [ ] Each template type tested in isolation (2 pts)
  - [ ] Status log updated (1 pt)

## Context Ledger
| Source | Type | Summary | Routed To |
| --- | --- | --- | --- |
| @src/cli/commands/init.ts:77-209 | code | Current init copies from package `.genie/` | implementation |
| @src/cli/lib/paths.ts:7-13 | code | Template path resolution (.claude already migrated) | implementation |
|  | existing | Claude templates already moved (20+ files) | Group A (partial complete) |
|  | existing | Root doc already moved (23KB) | Group A (partial complete) |
|  | existing | Root doc already moved (4KB) | Group A (partial complete) |
| @package.json:15-34 | config | Files bundled in npm package | implementation |
| User clarification (items #4-6) | requirements | Separate templates, support Next.js/Rust, version independently | entire wish |
|  | template | Wish structure requirements | wish structure |

## Discovery Summary
- **Primary analyst:** Human (namastex) + Genie planning agent
- **Key observations:**
  - Current framework's `.genie/` IS the template (mixed concerns)
  - Framework repo contains Genie-specific context in `.genie/custom/` not suitable for user projects
  - No mechanism exists for project-type templates (Next.js, Rust, Python, etc.)
  - Users want pre-configured scaffolds, not just `.genie/` overlay
  - Template versioning independent of framework version enables faster iteration
- **Assumptions (ASM-#):**
  - ASM-1: Framework dev requires `.genie/` at repo root for dogfooding
  - ASM-2: Templates should be complete project scaffolds (package.json, src/, etc.), not just .genie/ overlays
  - ASM-3: Base template derived from current `.genie/` with framework context stripped
  - ASM-4: Template types have shared `.genie/` core + type-specific customizations
- **Open questions (Q-#):**
  - Q-1: Should templates include lock files (pnpm-lock.yaml, Cargo.lock)?
  - Q-2: How to handle template-specific dependencies (e.g., Next.js requires react)?
  - Q-3: Should `genie init` default to base template, or require explicit `--template` flag?
  - Q-4: Template versioning: semantic (1.0.0) or tied to framework (2.0.3-template1)?
- **Risks:**
  - RISK-1: Template proliferation increases maintenance burden
  - RISK-2: Template versioning divergence from framework may confuse users
  - RISK-3: Framework dev workflow disruption during `.genie/` relocation

## Executive Summary
Complete multi-template architecture migration (partial work already done):
1. **Complete separation:** Move remaining `.genie/` to `templates/base/.genie/` + create symlink for framework dev
2. **Enable project-type scaffolds:** Support `genie init --template nextjs` for pre-configured starters
3. **Independent versioning:** Track template versions separately from framework, enabling rapid iteration

**Partial migration complete:** `.claude/`, `AGENTS.md`, `CLAUDE.md` already in `templates/` (2025-10-12). This wish completes the migration by moving `.genie/` and adding template selection + versioning.

This unlocks Genie as a foundation for opinionated starter kits while maintaining clean framework development.

## Current State
- **Template source:** Framework repo's `.genie/` copied directly to user projects during `genie init`
  - Path resolution: `paths.ts:getTemplateGeniePath()` → `<package-root>/.genie/`
  - Includes framework-specific context: `.genie/custom/analyze.md`, product docs referencing Genie itself
- **Partial migration complete (as of 2025-10-12):**
  - ✅ `.claude/` templates moved to `templates/.claude/` (20+ agent wrappers)
  - ✅ `AGENTS.md` moved to `templates/AGENTS.md` (23KB)
  - ✅ `CLAUDE.md` moved to `templates/CLAUDE.md` (4KB)
  - ✅ Path resolution updated: `getTemplateClaudePath()` points to `templates/.claude/`
  - ❌ `.genie/` still at package root (not yet in `templates/`)
- **Single template:** No project-type differentiation (no nextjs/, rust-cli/ variants)
- **No versioning:** Templates tied to framework version (no independent evolution)
- **What's missing:**
  - `.genie/` not yet moved to `templates/base/.genie/`
  - No symlink from root `.genie/` → `templates/base/.genie/`
  - No template selection logic (`--template` flag doesn't exist)
  - No template versioning system (`template.json` files)
  - No project-type scaffolds (Next.js, Rust CLI templates)
- **Pain points:**
  - Users still copy Genie-specific context into their projects
  - No quick-start for common stacks (Next.js, Rust CLI, Python API, etc.)
  - Template improvements require framework releases

## Target State & Guardrails
- **Desired behaviour:**
  - Framework dev uses `.genie/` (symlinked to `templates/base/.genie/` for consistency)
  - Distribution ships multiple templates in `templates/` directory:
    ```
    templates/
    ├── base/              # Minimal .genie scaffold
    │   ├── .genie/
    │   ├── .claude/
    │   ├── AGENTS.md
    │   ├── CLAUDE.md
    │   └── template.json  # Metadata: version, description
    ├── nextjs/            # Next.js + Genie
    │   ├── .genie/
    │   ├── .claude/
    │   ├── AGENTS.md
    │   ├── CLAUDE.md
    │   ├── template.json
    │   ├── package.json   # Next.js dependencies
    │   ├── src/
    │   └── ...
    └── rust-cli/          # Rust CLI + Genie
        ├── .genie/
        ├── .claude/
        ├── AGENTS.md
        ├── CLAUDE.md
        ├── template.json
        ├── Cargo.toml
        ├── src/
        └── ...
    ```
  - CLI supports: `genie init --template <type>` (defaults to `base` if omitted)
  - Template discovery: `genie init --list-templates` shows available options
  - Template versioning: Each `template.json` tracks independent version + framework compatibility
- **Non-negotiables:**
  - Base template must be clean (no Genie framework context)
  - Framework dev workflow undisrupted (`.genie/` at root via symlink)
  - Template selection explicit (no magic selection based on project detection)
  - Templates ship in npm package (no external registry required)

## Execution Groups

### Group A – Template Directory Restructure
**Slug:** template-restructure
**Goal:** Separate framework dev `.genie/` from distribution templates

**Surfaces:**
- Current `.genie/` directory (framework root)
- New `templates/base/.genie/` (cleaned distribution template)
- `templates/base/.claude/`, `templates/base/AGENTS.md`, `templates/base/CLAUDE.md`
- `.genie/` → symlink to `templates/base/.genie/` (framework dev)

**Deliverables:**
1. Create `templates/base/` directory with cleaned `.genie/`:
   - Copy current `.genie/` → `templates/base/.genie/`
   - Remove framework-specific context:
     - `.genie/custom/` → empty or example stubs only
     - `.genie/product/` → replace with `{{PLACEHOLDERS}}`
     - Agent frontmatter → generic defaults (not Genie-specific)
   - Add `templates/base/template.json`:
     ```json
     {
       "name": "base",
       "version": "1.0.0",
       "description": "Minimal Genie framework scaffold",
       "compatibleFrameworkVersions": "^2.0.0",
       "author": "Automagik Genie Team"
     }
     ```
2. Copy `templates/.claude/` → `templates/base/.claude/`
3. Copy root `AGENTS.md`, `CLAUDE.md` → `templates/base/`
4. Create symlink for framework dev:
   ```bash
   rm -rf .genie
   ln -s templates/base/.genie .genie
   ```
5. Update `.gitignore` to track symlink but not target
6. Update `package.json:files` to include `templates/base/**/*`

**Evidence:**
- Store before/after directory trees in `qa/group-a/restructure/`
- Document removed framework context in `qa/group-a/cleanup-report.md`
- Verify symlink works for framework dev

**Validation:**
```bash
# Verify base template clean
cd templates/base
grep -r "automagik-genie" .genie/ || echo "Clean ✓"
grep -r "{{" .genie/product/*.md && echo "Placeholders present ✓"

# Verify framework dev workflow
cd /home/namastex/workspace/automagik-genie
ls -la .genie # Should show symlink
genie run plan --mode debug # Should work normally
```

**Suggested personas:** implementor, refactor (for cleanup)

**External tracker:** FORGE-TBD-A

---

### Group B – Next.js Template
**Slug:** nextjs-template
**Goal:** Create Next.js + Genie starter scaffold

**Surfaces:**
- `templates/nextjs/` (new complete Next.js project)
- Next.js-specific `.genie/custom/` overrides
- `templates/nextjs/template.json`

**Deliverables:**
1. Create `templates/nextjs/` scaffold:
   ```
   templates/nextjs/
   ├── .genie/              # Copy from base, customize
   │   ├── agents/
   │   ├── product/
   │   │   ├── mission.md          # Next.js app template
   │   │   └── tech-stack.md       # React, Next.js 15, TypeScript
   │   ├── custom/
   │   │   ├── implementor.md      # Frontend-focused prompts
   │   │   └── tests.md            # Jest/Vitest conventions
   │   └── ...
   ├── .claude/             # Copy from base
   ├── AGENTS.md            # Copy from base
   ├── CLAUDE.md            # Copy from base
   ├── template.json
   ├── package.json         # Next.js 15, React 18, TypeScript
   ├── tsconfig.json
   ├── next.config.js
   ├── .gitignore
   ├── src/
   │   ├── app/
   │   │   ├── page.tsx     # Landing page mentioning Genie
   │   │   └── layout.tsx
   │   └── components/
   └── README.md            # Setup instructions with Genie workflow
   ```
2. Template metadata (`template.json`):
   ```json
   {
     "name": "nextjs",
     "version": "1.0.0",
     "description": "Next.js 15 + Genie framework starter",
     "compatibleFrameworkVersions": "^2.0.0",
     "author": "Automagik Genie Team",
     "tags": ["frontend", "react", "typescript"],
     "requires": {
       "node": ">=18.0.0",
       "pnpm": ">=8.0.0"
     }
   }
   ```
3. Customize `.genie/custom/implementor.md` for frontend:
   ```markdown
   ## Next.js Conventions
   - Use App Router (src/app/) not Pages Router
   - Server Components by default, 'use client' when needed
   - Tailwind for styling
   ```
4. Pre-configure `package.json` with dependencies:
   - `next@^15.0.0`, `react@^18.3.0`, `typescript@^5.0.0`
   - Dev tools: `eslint`, `prettier`, `@types/node`
5. Add example component with Genie branding

**Evidence:**
- Store Next.js template test output in `qa/group-b/nextjs-tests/`
- Capture `pnpm install && pnpm dev` successful startup
- Document customization points

**Validation:**
```bash
# Test Next.js template init
cd /tmp/test-nextjs
genie init --template nextjs
pnpm install
pnpm dev
# Expect: Next.js dev server starts, landing page visible

# Test Genie workflow in Next.js project
genie run plan "@.genie/product/mission.md"
# Expect: Plan agent runs with Next.js context
```

**Suggested personas:** implementor (Next.js expertise), docgen (README)

**External tracker:** FORGE-TBD-B

---

### Group C – Template Selection CLI
**Slug:** template-cli
**Goal:** Implement `genie init --template <type>` with discovery

**Surfaces:**
- @src/cli/commands/init.ts – add `--template` flag
- @src/cli/lib/paths.ts – update `getTemplateGeniePath()` to accept template type

**Deliverables:**
1. Add `--template` flag to `genie init`:
   ```bash
   genie init --template <type> [--provider <codex|claude>] [--yes]

   # Examples:
   genie init --template base       # Minimal scaffold (default)
   genie init --template nextjs     # Next.js starter
   genie init --template rust-cli   # Rust CLI scaffold (future)
   ```
2. Implement template discovery (`template-discovery.ts`):
   ```typescript
   export interface TemplateMetadata {
     name: string;
     version: string;
     description: string;
     compatibleFrameworkVersions: string;
     author: string;
     tags?: string[];
     requires?: Record<string, string>;
   }

   export async function listTemplates(packageRoot: string): Promise<TemplateMetadata[]> {
     const templatesDir = path.join(packageRoot, 'templates');
     const entries = await fsp.readdir(templatesDir, { withFileTypes: true });
     const templates: TemplateMetadata[] = [];

     for (const entry of entries) {
       if (!entry.isDirectory()) continue;
       const metadataPath = path.join(templatesDir, entry.name, 'template.json');
       if (await pathExists(metadataPath)) {
         const metadata = await readJsonFile<TemplateMetadata>(metadataPath);
         if (metadata) templates.push(metadata);
       }
     }

     return templates;
   }

   export async function getTemplate(packageRoot: string, name: string): Promise<string | null> {
     const templatePath = path.join(packageRoot, 'templates', name);
     if (await pathExists(templatePath)) return templatePath;
     return null;
   }
   ```
3. Add `--list-templates` flag:
   ```bash
   genie init --list-templates
   # Output:
   # Available templates:
   #   base      - Minimal Genie framework scaffold (v1.0.0)
   #   nextjs    - Next.js 15 + Genie framework starter (v1.0.0)
   ```
4. Update `init.ts` flow:
   - Parse `--template` flag (default: `base`)
   - Resolve template path via `getTemplate()`
   - If template not found, show error + `--list-templates` hint
   - Copy template directory instead of just `.genie/`
   - Preserve existing backup + provider logic
5. Template compatibility check:
   - Read `template.json:compatibleFrameworkVersions`
   - Verify current framework version matches (semver)
   - Warn if incompatible but allow with `--force`

**Evidence:**
- Store CLI output tests in `qa/group-c/cli-tests/`
- Capture `--list-templates` output
- Document error messages for missing templates

**Validation:**
```bash
# Test template discovery
genie init --list-templates
# Expect: base, nextjs listed

# Test template selection
genie init --template nextjs --yes
ls -la package.json next.config.js
# Expect: Next.js files present

# Test invalid template
genie init --template invalid
# Expect: Error + suggestion to use --list-templates

# Test compatibility check
# (Create template with "compatibleFrameworkVersions": "^3.0.0")
genie init --template future-template
# Expect: Warning about version mismatch
```

**Suggested personas:** implementor, tests

**External tracker:** FORGE-TBD-C

---

### Group D – Template Versioning System
**Slug:** template-versioning
**Goal:** Independent template versioning with compatibility tracking

**Surfaces:**
- `templates/*/template.json` – version field
- `.genie/state/template.json` – new state file tracking installed template
- Update mechanism for templates (reuse update agent from backup-update wish)

**Deliverables:**
1. Template version schema (`template.json`):
   ```json
   {
     "name": "nextjs",
     "version": "1.2.0",
     "compatibleFrameworkVersions": "^2.0.0",
     "changelog": [
       { "version": "1.2.0", "date": "2025-10-12", "changes": ["Add Tailwind v4 support"] },
       { "version": "1.1.0", "date": "2025-09-15", "changes": ["Upgrade to Next.js 15"] },
       { "version": "1.0.0", "date": "2025-08-01", "changes": ["Initial release"] }
     ]
   }
   ```
2. Track installed template (`.genie/state/template.json`):
   ```json
   {
     "name": "nextjs",
     "version": "1.0.0",
     "installedAt": "2025-10-12T14:20:30.123Z",
     "source": "npm:automagik-genie@2.0.3"
   }
   ```
3. Template update detection:
   ```bash
   genie status
   # Output:
   # Framework version: 2.0.3 (latest)
   # Template: nextjs v1.0.0 (update available: v1.2.0)
   ```
4. Template upgrade flow:
   ```bash
   genie update --template
   # Checks for newer template version
   # Prompts: "Upgrade nextjs template 1.0.0 → 1.2.0?"
   # Applies template-specific migrations
   ```
5. Semver versioning strategy:
   - Template MAJOR: Breaking changes to structure
   - Template MINOR: New features, safe to auto-upgrade
   - Template PATCH: Bug fixes, safe to auto-upgrade
6. Update `package.json` bump scripts:
   ```json
   "scripts": {
     "bump:template": "node scripts/bump-template.js <template-name> <patch|minor|major>"
   }
   ```

**Evidence:**
- Store version compatibility matrix in `qa/group-d/versions/`
- Document template upgrade scenarios
- Test version detection logic

**Validation:**
```bash
# Test version tracking
genie init --template nextjs
cat .genie/state/template.json | jq .version
# Expect: "1.0.0"

# Test update detection
# (Manually bump templates/nextjs/template.json to 1.1.0)
genie status
# Expect: Shows template update available

# Test semver compatibility
# (Set template "compatibleFrameworkVersions": "^1.9.0")
genie init --template nextjs
# Expect: Warning about framework 2.0.3 vs template expecting ^1.9.0
```

**Suggested personas:** implementor, tests

**External tracker:** FORGE-TBD-D

---

### Group E – Rust CLI Template (Example Future Template)
**Slug:** rust-cli-template
**Goal:** Demonstrate extensibility with Rust CLI scaffold

**Surfaces:**
- `templates/rust-cli/` (complete Rust CLI project)
- Rust-specific `.genie/custom/` overrides

**Deliverables:**
1. Create `templates/rust-cli/` scaffold:
   ```
   templates/rust-cli/
   ├── .genie/
   │   ├── custom/
   │   │   ├── implementor.md      # Rust conventions
   │   │   └── tests.md            # cargo test patterns
   │   └── ...
   ├── .claude/
   ├── AGENTS.md
   ├── CLAUDE.md
   ├── template.json
   ├── Cargo.toml           # CLI dependencies (clap, anyhow)
   ├── src/
   │   └── main.rs          # Basic CLI entrypoint
   ├── tests/
   └── README.md
   ```
2. Template metadata:
   ```json
   {
     "name": "rust-cli",
     "version": "1.0.0",
     "description": "Rust CLI + Genie framework starter",
     "compatibleFrameworkVersions": "^2.0.0",
     "tags": ["rust", "cli", "backend"],
     "requires": {
       "rustc": ">=1.70.0",
       "cargo": ">=1.70.0"
     }
   }
   ```
3. Customize `.genie/custom/implementor.md`:
   ```markdown
   ## Rust Conventions
   - Use `anyhow::Result` for error handling
   - Follow Clippy suggestions
   - Document public APIs with /// comments
   ```

**Evidence:**
- Store Rust template tests in `qa/group-e/rust-tests/`
- Capture `cargo build && cargo run` success
- Document Rust-specific customizations

**Validation:**
```bash
# Test Rust template
cd /tmp/test-rust
genie init --template rust-cli
cargo build
cargo run
# Expect: CLI runs successfully

# Test Genie workflow in Rust project
genie run implementor "@.genie/product/mission.md"
# Expect: Implementor uses Rust conventions
```

**Suggested personas:** implementor (Rust expertise), docgen

**External tracker:** FORGE-TBD-E

## Verification Plan
- **Validation steps:**
  1. Restructure framework `.genie/` to `templates/base/`
  2. Verify symlink preserves framework dev workflow
  3. Create Next.js template with complete scaffold
  4. Test `genie init --template nextjs` creates working app
  5. Implement template discovery + selection CLI
  6. Add versioning to templates + track in state
  7. Test template updates via `genie update --template`
  8. Create Rust CLI template as extensibility demo
- **Evidence storage:**
  - Restructure: `qa/group-a/restructure/`
  - Next.js: `qa/group-b/nextjs-tests/`
  - CLI: `qa/group-c/cli-tests/`
  - Versioning: `qa/group-d/versions/`
  - Rust: `qa/group-e/rust-tests/`
- **Branch strategy:** Dedicated branch `feat/multi-template-architecture`

### Evidence Checklist
- **Validation commands (exact):**
  ```bash
  # Base template clean
  grep -r "automagik-genie" templates/base/.genie/ || echo "Clean ✓"

  # Template init
  genie init --template nextjs && pnpm install && pnpm dev

  # Template discovery
  genie init --list-templates

  # Version tracking
  cat .genie/state/template.json | jq .version

  # Template update
  genie update --template
  ```
- **Artefact paths:**
  - Test outputs: `qa/group-{a,b,c,d,e}/`
  - Template metadata: `templates/*/template.json`
  - State tracking: `.genie/state/template.json`
- **Approval checkpoints:**
  - [ ] Human review base template cleanup (Group A) before symlink creation
  - [ ] Next.js template structure approved (Group B) before CLI integration
  - [ ] Template versioning strategy finalized (Group D) before implementation

## <spec_contract>
- **Scope:**
  - Complete `.genie/` migration to `templates/base/.genie/` + create symlink
  - Create Next.js + Rust CLI template scaffolds
  - Implement `genie init --template <type>` CLI
  - Add template versioning with compatibility checks
  - Track installed template in `.genie/state/template.json`
- **Already complete (partial Group A, 2025-10-12):**
  - ✅ `.claude/` moved to `templates/.claude/` (20+ agent wrappers)
  - ✅ `AGENTS.md` moved to `templates/AGENTS.md`
  - ✅ `CLAUDE.md` moved to `templates/CLAUDE.md`
  - ✅ Path resolution updated (`getTemplateClaudePath()` points to templates/)
- **Out of scope:**
  - External template registry (npm, GitHub) – ship in package only
  - Template generation wizard (`genie create-template`) – manual authoring for now
  - Dynamic template selection based on project detection – explicit flag required
  - CI/CD templates (GitHub Actions, etc.) – focus on project scaffolds
- **Success metrics:**
  - Framework dev workflow unchanged (symlink works)
  - Templates init in <5s and produce working projects
  - Template versioning enables independent iteration
  - At least 2 complete templates shipped (Next.js, Rust CLI)
- **External tasks:**
  - FORGE-TBD-A: Complete template restructure (finish .genie migration + symlink)
  - FORGE-TBD-B: Next.js template authoring
  - FORGE-TBD-C: Template selection CLI
  - FORGE-TBD-D: Template versioning system
  - FORGE-TBD-E: Rust CLI template (demo extensibility)
- **Dependencies:**
  - Existing `genie init` flow
  - `template.json` schema (defined in this wish)
  - Framework versioning system (`.genie/state/version.json`)
</spec_contract>

## Blocker Protocol
1. Pause work and create `reports/blocker-multi-template-architecture-<timestamp>.md` describing findings.
2. Notify owner (namastex) and wait for updated instructions.
3. Resume only after wish status/log is updated.

## Status Log
- [2025-10-12 00:00Z] Wish created from planning brief (items #4-6)

## Proposals for Refinement

### Proposal 1: CLI Structure
```bash
# Option A: Subcommand (cleaner grouping)
genie init --template <type>
genie template list
genie template info <type>
genie template update

# Option B: Flags only (simpler)
genie init --template <type>
genie init --list-templates
genie update --template

# Recommended: Option B (fewer commands, consistent with init)
```

### Proposal 2: Template Version Format
```
# Option A: Semantic (independent evolution)
nextjs template: 1.2.0
Framework: 2.0.3

# Option B: Coupled (template tied to framework)
nextjs template: 2.0.3-t1 (framework 2.0.3, template iteration 1)

# Option C: Hybrid (major coupled, minor independent)
nextjs template: 2.4.0 (framework 2.x, template iteration 4)

# Recommended: Option A (cleaner, enables rapid template iteration)
```

### Proposal 3: Template Discovery Order
```
# Option A: Package-bundled only
templates/ shipped in npm package

# Option B: Package + local override
1. Check ~/.genie/templates/ (user custom)
2. Fallback to <package>/templates/

# Option C: Package + local + git URL
genie init --template https://github.com/user/custom-template

# Recommended: Option A for v1, Option B for v2 (simpler to start)
```

### Proposal 4: Template Content Scope
```
# Option A: .genie overlay only
Templates contain just .genie/, .claude/, AGENTS.md, CLAUDE.md
User creates package.json, src/ manually

# Option B: Complete scaffolds
Templates include full project structure (package.json, src/, etc.)

# Recommended: Option B (matches user expectation of "starter kit")
```
