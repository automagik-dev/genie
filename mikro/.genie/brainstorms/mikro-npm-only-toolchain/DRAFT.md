# DRAFT — npm-only reproducible toolchain

Date: 2026-08-31
Status: READY

WRS: ██████████ 100/100

- Problem ✅ — stale Bun authority contradicts repository-owned npm installs.
- Scope ✅ — one lock and one dependency-free guard across the local wrapper, CI, canonical installer, source/committed updater, and launcher self-heal; no upgrades.
- Boundary ✅ — deliberate raw local `npm ci` and consumer `npm install github:automagik-dev/mikro` cannot be intercepted before npm mutation and are not misrepresented as guarded paths.
- Contract ✅ — lockfile v3 structure; exact `name`, `version`, `dependencies`, `devDependencies`, and `engines` coherence; explicit six-lock rejection set.
- Tests ✅ — frozen invalid fixtures use sentinel, fake-npm, and updater parking tripwires before every owned mutation seam; coherent controls must reach npm.
- Release ✅ — exact-candidate CI guarded install plus install/update smoke is the release gate; the metadata release workflow remains no-install.
- Scope gate ✅ — production path allowlist names CI, installer, smoke, launcher, source/build updater, focused tests, and directly affected docs.

Simplest complete design: delete the false lock and run one dependency-free npm authority guard before mutation in every repository-owned installer.

Next Step: independent review, then `wish` for this child only.
