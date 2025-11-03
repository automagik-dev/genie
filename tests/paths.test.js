const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  findWorkspaceRoot,
  getPackageRoot,
  getTemplateGeniePath,
  getTemplateClaudePath,
  getTemplateRootPath,
  getTemplateRelativeBlacklist,
  resolveTargetGeniePath,
  resolveTargetStatePath,
  resolveBackupsRoot,
  resolveWorkspaceProviderPath,
  resolveWorkspaceVersionPath,
  resolveWorkspacePackageJson,
  resolveProviderStatusPath,
  resolveTempBackupsRoot
} = require('../dist/cli/lib/paths.js');

const ORIGINAL_CWD = process.cwd();

function makeTempDir(prefix = 'paths-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Test: findWorkspaceRoot returns directory containing .genie
(function testFindWorkspaceRootInCurrentDirectory() {
  const tempDir = makeTempDir();
  const genieDir = path.join(tempDir, '.genie');
  fs.mkdirSync(genieDir);
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    const result = findWorkspaceRoot();
    assert.strictEqual(result, tempDir, 'should return directory containing .genie');
  } finally {
    process.chdir(previousCwd);
    cleanupTempDir(tempDir);
  }
})();

// Test: findWorkspaceRoot ascends to parent directories
(function testFindWorkspaceRootInAncestor() {
  const tempDir = makeTempDir();
  const nestedDir = path.join(tempDir, 'a', 'b', 'c');
  fs.mkdirSync(path.join(tempDir, '.genie'));
  fs.mkdirSync(nestedDir, { recursive: true });
  const previousCwd = process.cwd();
  process.chdir(nestedDir);
  try {
    const result = findWorkspaceRoot();
    assert.strictEqual(result, tempDir, 'should locate .genie in ancestor directory');
  } finally {
    process.chdir(previousCwd);
    cleanupTempDir(tempDir);
  }
})();

// Test: findWorkspaceRoot falls back to current directory
(function testFindWorkspaceRootFallback() {
  const tempDir = makeTempDir();
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    const result = findWorkspaceRoot();
    assert.strictEqual(result, tempDir, 'should fall back to cwd when .genie is missing');
  } finally {
    process.chdir(previousCwd);
    cleanupTempDir(tempDir);
  }
})();

// Test: getPackageRoot returns absolute path
(function testGetPackageRootIsAbsolute() {
  const packageRoot = getPackageRoot();
  assert.ok(path.isAbsolute(packageRoot), 'package root should be absolute');
})();

// Test: getPackageRoot points to repository root
(function testGetPackageRootContainsPackageJson() {
  const packageRoot = getPackageRoot();
  assert.ok(fs.existsSync(path.join(packageRoot, 'package.json')), 'package root should contain package.json');
})();

// Test: getPackageRoot is stable across calls
(function testGetPackageRootStable() {
  const first = getPackageRoot();
  const second = getPackageRoot();
  assert.strictEqual(first, second, 'multiple calls should return same root');
})();

// Test: getTemplateGeniePath defaults to code template
(function testGetTemplateGeniePathDefault() {
  const expected = path.join(getPackageRoot(), '.genie', 'code');
  const result = getTemplateGeniePath();
  assert.strictEqual(result, expected, 'default template should point to .genie/code');
})();

// Test: getTemplateGeniePath returns create template
(function testGetTemplateGeniePathCreate() {
  const expected = path.join(getPackageRoot(), '.genie', 'create');
  const result = getTemplateGeniePath('create');
  assert.strictEqual(result, expected, 'create template should point to .genie/create');
})();

// Test: getTemplateGeniePath stays inside package root
(function testGetTemplateGeniePathWithinRoot() {
  const result = getTemplateGeniePath('code');
  const relative = path.relative(getPackageRoot(), result);
  assert.ok(!relative.startsWith('..'), 'template path should stay within package root');
})();

// Test: getTemplateClaudePath points to .claude directory
(function testGetTemplateClaudePathLocation() {
  const expected = path.join(getPackageRoot(), '.claude');
  const result = getTemplateClaudePath();
  assert.strictEqual(result, expected, 'should resolve to .claude directory');
})();

// Test: getTemplateClaudePath returns absolute path
(function testGetTemplateClaudePathAbsolute() {
  const result = getTemplateClaudePath();
  assert.ok(path.isAbsolute(result), 'Claude template path should be absolute');
})();

// Test: getTemplateClaudePath ignores template argument
(function testGetTemplateClaudePathIgnoresTemplate() {
  const defaultPath = getTemplateClaudePath();
  const createPath = getTemplateClaudePath('create');
  assert.strictEqual(defaultPath, createPath, 'template argument should not change Claude path');
})();

// Test: getTemplateRootPath matches package root
(function testGetTemplateRootPathMatchesRoot() {
  const packageRoot = getPackageRoot();
  const result = getTemplateRootPath();
  assert.strictEqual(result, packageRoot, 'root template path should equal package root');
})();

// Test: getTemplateRootPath returns absolute path
(function testGetTemplateRootPathAbsolute() {
  const result = getTemplateRootPath();
  assert.ok(path.isAbsolute(result), 'root template path should be absolute');
})();

// Test: getTemplateRootPath ignores template argument
(function testGetTemplateRootPathIgnoresTemplate() {
  const defaultPath = getTemplateRootPath();
  const createPath = getTemplateRootPath('create');
  assert.strictEqual(defaultPath, createPath, 'template argument should not change root path');
})();

// Test: getTemplateRelativeBlacklist contains protected folders
(function testGetTemplateRelativeBlacklistContents() {
  const blacklist = getTemplateRelativeBlacklist();
  assert.ok(blacklist.has('wishes'), 'blacklist should protect wishes directory');
  assert.ok(blacklist.has('reports'), 'blacklist should protect reports directory');
})();

// Test: getTemplateRelativeBlacklist returns new set each call
(function testGetTemplateRelativeBlacklistFreshInstances() {
  const first = getTemplateRelativeBlacklist();
  first.add('temp');
  const second = getTemplateRelativeBlacklist();
  assert.ok(!second.has('temp'), 'each call should return a fresh set instance');
})();

// Test: getTemplateRelativeBlacklist includes cli directory
(function testGetTemplateRelativeBlacklistIncludesCli() {
  const blacklist = getTemplateRelativeBlacklist();
  assert.ok(blacklist.has('cli'), 'blacklist should include cli directory');
})();

// Test: resolveTargetGeniePath uses current working directory by default
(function testResolveTargetGeniePathDefaultCwd() {
  const tempDir = makeTempDir();
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    const expected = path.join(tempDir, '.genie');
    const result = resolveTargetGeniePath();
    assert.strictEqual(result, expected, 'should base path on current working directory');
  } finally {
    process.chdir(previousCwd);
    cleanupTempDir(tempDir);
  }
})();

// Test: resolveTargetGeniePath handles absolute inputs
(function testResolveTargetGeniePathAbsolute() {
  const absPath = path.join(os.tmpdir(), 'paths-test-absolute');
  const result = resolveTargetGeniePath(absPath);
  assert.strictEqual(result, path.join(absPath, '.genie'), 'should append .genie to absolute path');
})();

// Test: resolveTargetGeniePath resolves relative inputs
(function testResolveTargetGeniePathRelative() {
  const relative = path.join('tmp', 'paths-relative');
  const expected = path.resolve(relative, '.genie');
  const result = resolveTargetGeniePath(relative);
  assert.strictEqual(result, expected, 'should resolve relative input to absolute path');
})();

// Test: resolveTargetStatePath appends state directory
(function testResolveTargetStatePathStructure() {
  const base = path.join('tmp', 'state-structure');
  const result = resolveTargetStatePath(base);
  const expected = path.join(resolveTargetGeniePath(base), 'state');
  assert.strictEqual(result, expected, 'should append state directory to genie path');
})();

// Test: resolveTargetStatePath uses current directory when omitted
(function testResolveTargetStatePathDefaultCwd() {
  const tempDir = makeTempDir();
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    const result = resolveTargetStatePath();
    assert.strictEqual(result, path.join(tempDir, '.genie', 'state'), 'should use cwd when no argument provided');
  } finally {
    process.chdir(previousCwd);
    cleanupTempDir(tempDir);
  }
})();

// Test: resolveTargetStatePath resolves relative paths
(function testResolveTargetStatePathRelative() {
  const relative = path.join('tmp', 'state-relative');
  const result = resolveTargetStatePath(relative);
  const expected = path.resolve(relative, '.genie', 'state');
  assert.strictEqual(result, expected, 'should resolve relative path to absolute state directory');
})();

// Test: resolveBackupsRoot appends backups directory
(function testResolveBackupsRootStructure() {
  const cwd = path.join('tmp', 'backups-structure');
  const result = resolveBackupsRoot(cwd);
  const expected = path.join(resolveTargetGeniePath(cwd), 'backups');
  assert.strictEqual(result, expected, 'should append backups directory to genie path');
})();

// Test: resolveBackupsRoot uses current directory when omitted
(function testResolveBackupsRootDefaultCwd() {
  const tempDir = makeTempDir();
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    const result = resolveBackupsRoot();
    assert.strictEqual(result, path.join(tempDir, '.genie', 'backups'), 'should use cwd for default backups path');
  } finally {
    process.chdir(previousCwd);
    cleanupTempDir(tempDir);
  }
})();

// Test: resolveBackupsRoot resolves relative paths
(function testResolveBackupsRootRelative() {
  const relative = path.join('tmp', 'backups-relative');
  const result = resolveBackupsRoot(relative);
  const expected = path.resolve(relative, '.genie', 'backups');
  assert.strictEqual(result, expected, 'should resolve relative path to backups directory');
})();

// Test: resolveWorkspaceProviderPath ends with provider.json
(function testResolveWorkspaceProviderPathFileName() {
  const result = resolveWorkspaceProviderPath('/tmp/provider-file');
  assert.strictEqual(path.basename(result), 'provider.json', 'should point to provider.json file');
})();

// Test: resolveWorkspaceProviderPath default cwd behavior
(function testResolveWorkspaceProviderPathDefaultCwd() {
  const tempDir = makeTempDir();
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    const result = resolveWorkspaceProviderPath();
    assert.strictEqual(result, path.join(tempDir, '.genie', 'state', 'provider.json'), 'should resolve using cwd when no argument');
  } finally {
    process.chdir(previousCwd);
    cleanupTempDir(tempDir);
  }
})();

// Test: resolveWorkspaceProviderPath resolves relative paths
(function testResolveWorkspaceProviderPathRelative() {
  const relative = path.join('tmp', 'provider-relative');
  const result = resolveWorkspaceProviderPath(relative);
  const expected = path.resolve(relative, '.genie', 'state', 'provider.json');
  assert.strictEqual(result, expected, 'should resolve relative provider path to absolute location');
})();

// Test: resolveWorkspaceVersionPath ends with version.json
(function testResolveWorkspaceVersionPathFileName() {
  const result = resolveWorkspaceVersionPath('/tmp/version-file');
  assert.strictEqual(path.basename(result), 'version.json', 'should point to version.json file');
})();

// Test: resolveWorkspaceVersionPath default cwd behavior
(function testResolveWorkspaceVersionPathDefaultCwd() {
  const tempDir = makeTempDir();
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    const result = resolveWorkspaceVersionPath();
    assert.strictEqual(result, path.join(tempDir, '.genie', 'state', 'version.json'), 'should use cwd for version path when omitted');
  } finally {
    process.chdir(previousCwd);
    cleanupTempDir(tempDir);
  }
})();

// Test: resolveWorkspaceVersionPath resolves relative paths
(function testResolveWorkspaceVersionPathRelative() {
  const relative = path.join('tmp', 'version-relative');
  const result = resolveWorkspaceVersionPath(relative);
  const expected = path.resolve(relative, '.genie', 'state', 'version.json');
  assert.strictEqual(result, expected, 'should resolve relative version path to absolute location');
})();

// Test: resolveWorkspacePackageJson points to package.json
(function testResolveWorkspacePackageJsonFileName() {
  const result = resolveWorkspacePackageJson('/tmp/package-file');
  assert.strictEqual(path.basename(result), 'package.json', 'should point to package.json file within .genie');
})();

// Test: resolveWorkspacePackageJson default cwd behavior
(function testResolveWorkspacePackageJsonDefaultCwd() {
  const tempDir = makeTempDir();
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    const result = resolveWorkspacePackageJson();
    assert.strictEqual(result, path.join(tempDir, '.genie', 'package.json'), 'should use cwd when no argument provided');
  } finally {
    process.chdir(previousCwd);
    cleanupTempDir(tempDir);
  }
})();

// Test: resolveWorkspacePackageJson resolves relative paths
(function testResolveWorkspacePackageJsonRelative() {
  const relative = path.join('tmp', 'package-relative');
  const result = resolveWorkspacePackageJson(relative);
  const expected = path.resolve(relative, '.genie', 'package.json');
  assert.strictEqual(result, expected, 'should resolve relative package path to absolute location');
})();

// Test: resolveProviderStatusPath ends with provider-status.json
(function testResolveProviderStatusPathFileName() {
  const result = resolveProviderStatusPath('/tmp/status-file');
  assert.strictEqual(path.basename(result), 'provider-status.json', 'should point to provider-status.json file');
})();

// Test: resolveProviderStatusPath default cwd behavior
(function testResolveProviderStatusPathDefaultCwd() {
  const tempDir = makeTempDir();
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    const result = resolveProviderStatusPath();
    assert.strictEqual(result, path.join(tempDir, '.genie', 'state', 'provider-status.json'), 'should use cwd when no argument provided');
  } finally {
    process.chdir(previousCwd);
    cleanupTempDir(tempDir);
  }
})();

// Test: resolveProviderStatusPath resolves relative paths
(function testResolveProviderStatusPathRelative() {
  const relative = path.join('tmp', 'status-relative');
  const result = resolveProviderStatusPath(relative);
  const expected = path.resolve(relative, '.genie', 'state', 'provider-status.json');
  assert.strictEqual(result, expected, 'should resolve relative status path to absolute location');
})();

// Test: resolveTempBackupsRoot appends temporary backups directory
(function testResolveTempBackupsRootStructure() {
  const cwd = path.join('tmp', 'temp-backups-structure');
  const result = resolveTempBackupsRoot(cwd);
  const expected = path.join(cwd, '.genie-backups-temp');
  assert.strictEqual(result, expected, 'should append .genie-backups-temp to provided cwd');
})();

// Test: resolveTempBackupsRoot default cwd behavior
(function testResolveTempBackupsRootDefaultCwd() {
  const tempDir = makeTempDir();
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    const result = resolveTempBackupsRoot();
    assert.strictEqual(result, path.join(tempDir, '.genie-backups-temp'), 'should base temporary backups path on cwd');
  } finally {
    process.chdir(previousCwd);
    cleanupTempDir(tempDir);
  }
})();

// Test: resolveTempBackupsRoot resolves relative inputs
(function testResolveTempBackupsRootRelative() {
  const relative = path.join('tmp', 'temp-backups-relative');
  const result = resolveTempBackupsRoot(relative);
  const expected = path.join(relative, '.genie-backups-temp');
  assert.strictEqual(result, expected, 'should append .genie-backups-temp preserving relative resolution semantics');
  assert.ok(!path.isAbsolute(result), 'relative cwd should yield relative backups path');
})();

process.chdir(ORIGINAL_CWD);
console.log('✅ paths tests passed');