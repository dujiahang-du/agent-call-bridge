import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
// The publication check is JavaScript so it also works before dependencies exist.
// @ts-ignore imported JavaScript CLI also exports its read-only scanner
import { scanRepository } from '../scripts/check-safe.mjs';

const project = resolve(import.meta.dirname, '..');
const area = join(project, '.local');
mkdirSync(area, { recursive: true });
function fixture() {
  const dir = mkdtempSync(join(area, 'safety-tests-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', `core.hooksPath=${join(dir, 'no-hooks')}`, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Safety Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const put = (path: string, value: string | Buffer) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), value); git('add', '--', path); };
  const commit = (message = 'fixture checkpoint') => git('commit', '-qm', message);
  const close = () => {
    // Recursive cleanup is confined to the verified project-local test directory.
    if (!resolve(dir).startsWith(resolve(area) + sep) || !dir.includes('safety-tests-')) throw new Error('Unsafe cleanup path');
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, git, put, commit, close, scan: () => scanRepository(dir, { history: true }) };
}
// Synthetic attack payloads are assembled to keep this test source publishable.
const syntheticToken = () => ['ghp', 'A'.repeat(36)].join('_');
const syntheticPhone = () => '+86' + ['138', '0000', '1234'].join('');
const has = (r: any, word: string) => r.problems.some((p: any) => p.kind.includes(word));

test('staged blobs are inspected, not unstaged replacement; results never expose values', () => {
  const f = fixture();
  try {
    const value = syntheticToken(); f.put('src/settings.txt', value); writeFileSync(join(f.dir, 'src/settings.txt'), 'clean unstaged version');
    const result = f.scan(); assert.ok(has(result, 'credential')); assert.ok(!JSON.stringify(result).includes(value));
  } finally { f.close(); }
});
test('deleted forbidden paths and binary payloads remain blocked throughout full history', () => {
  const f = fixture();
  try {
    f.put('archive/calls.wav', Buffer.from([0, 1, 2, 3])); f.put('.local/connection.json', '{}'); f.commit();
    f.git('rm', '-q', '--', 'archive/calls.wav', '.local/connection.json'); f.put('README.md', 'clean present'); f.commit();
    const result = f.scan(); assert.equal(result.commits, 2); assert.ok(has(result, 'forbidden')); assert.ok(has(result, 'binary'));
    assert.ok(result.problems.some((p: any) => p.path === 'archive/calls.wav'));
  } finally { f.close(); }
});
test('all unpushed refs, commit messages and tag messages are checked', () => {
  const f = fixture();
  try {
    f.put('README.md', 'base'); f.commit(); const clean = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-qb', 'private-old-branch'); f.put('old.txt', syntheticPhone()); f.commit(syntheticToken());
    f.git('tag', '-a', 'fixture-tag', '-m', syntheticToken()); f.git('checkout', '-q', '--detach', clean);
    const result = f.scan(); assert.ok(has(result, 'phone')); assert.ok(result.problems.some((p: any) => p.path.startsWith('commit '))); assert.ok(result.problems.some((p: any) => p.path.startsWith('tag ')));
  } finally { f.close(); }
});
test('shared blob aliases retain forbidden historical names', () => {
  const f = fixture();
  try {
    f.put('.env', 'ordinary content'); f.commit(); f.git('mv', '.env', 'README.md'); f.commit();
    assert.ok(f.scan().problems.some((p: any) => p.path === '.env' && p.kind.includes('forbidden')));
  } finally { f.close(); }
});
test('binary and UTF-16 payloads are scanned regardless of harmless extension', () => {
  const f = fixture();
  try {
    f.put('image.txt', Buffer.concat([Buffer.from([0, 255]), Buffer.from(syntheticToken())]));
    f.put('unicode.txt', Buffer.from('token=' + JSON.stringify(syntheticToken()), 'utf16le'));
    const result = f.scan(); assert.ok(has(result, 'binary')); assert.ok(has(result, 'credential'));
  } finally { f.close(); }
});
test('exact fixture allowlist accepts only its known value at its known path', () => {
  const f = fixture();
  try {
    const known = ['202', '555', '0101'].join('');
    f.put('tests/core.test.ts', JSON.stringify(known)); assert.equal(f.scan().problems.length, 0);
    f.put('tests/arbitrary.test.ts', JSON.stringify(known)); assert.ok(has(f.scan(), 'phone'));
    f.git('rm', '-q', '--cached', 'tests/arbitrary.test.ts'); f.put('tests/core.test.ts', syntheticPhone()); assert.ok(has(f.scan(), 'phone'));
  } finally { f.close(); }
});
test('generic literal secrets, domestic numbers and sensitive filenames are redacted', () => {
  const f = fixture();
  try {
    const phone = syntheticPhone().slice(3); const value = ['unlisted', 'fixture', 'credential'].join('-');
    f.put(`${phone}.txt`, 'password: ' + JSON.stringify(value));
    const result = f.scan(); assert.ok(has(result, 'literal secret')); assert.ok(has(result, 'phone'));
    assert.ok(!JSON.stringify(result).includes(phone)); assert.ok(!JSON.stringify(result).includes(value));
  } finally { f.close(); }
});
test('sanitized env example is allowed but its actual secret is rejected', () => {
  const f = fixture();
  try {
    f.put('.env.example', 'API_KEY=""'); assert.equal(f.scan().problems.length, 0);
    f.put('.env.example', syntheticToken()); assert.ok(has(f.scan(), 'credential'));
  } finally { f.close(); }
});
test('reviewed Mock screenshot requires both the exact path and reviewed digest', () => {
  const f = fixture();
  try {
    const path = 'docs/screenshots/workbench.png'; const bytes = readFileSync(join(project, path));
    f.put(path, bytes); assert.equal(f.scan().problems.length, 0);
    f.put('docs/screenshots/another.png', bytes); assert.ok(has(f.scan(), 'binary'));
    f.git('rm', '-q', '--cached', 'docs/screenshots/another.png');
    f.put(path, Buffer.concat([bytes, Buffer.from([0])])); assert.ok(has(f.scan(), 'binary'));
  } finally { f.close(); }
});
test('quoted JSON keys and unquoted environment secrets cannot evade detection', () => {
  const f = fixture();
  try {
    const value = ['arbitrary', 'sensitive', 'fixture'].join('-');
    f.put('configuration.txt', JSON.stringify({ password: value }) + '\n' + ['API', 'KEY'].join('_') + '=' + value);
    const result = f.scan(); assert.ok(has(result, 'literal secret')); assert.ok(has(result, 'environment secret'));
  } finally { f.close(); }
});
test('sync refuses a foreign push URL before any commit or network operation', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, 'scripts')); copyFileSync(join(project, 'scripts/safe-sync.ps1'), join(f.dir, 'scripts/safe-sync.ps1'));
    f.git('remote', 'add', 'origin', 'https://github.com/dujiahang-du/agent-call-bridge');
    f.git('remote', 'set-url', '--push', 'origin', 'https://example.invalid/foreign.git');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(f.dir, 'scripts/safe-sync.ps1')], { cwd: f.dir, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Unexpected remote/);
    assert.throws(() => f.git('rev-parse', '--verify', 'HEAD'));
  } finally { f.close(); }
});
test('sync exclusive lock refuses concurrent execution', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, 'scripts')); copyFileSync(join(project, 'scripts/safe-sync.ps1'), join(f.dir, 'scripts/safe-sync.ps1'));
    // All paths come from the local fixture; use PowerShell literal single quotes.
    const quote = (v: string) => "'" + v.replaceAll("'", "''") + "'";
    const command = `$held=[IO.File]::Open(${quote(join(f.dir, '.git/agent-call-bridge-sync.lock'))},'OpenOrCreate','ReadWrite','None'); try { & ${quote(join(f.dir, 'scripts/safe-sync.ps1'))} } finally { $held.Dispose() }`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: f.dir, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Another project sync is running/);
  } finally { f.close(); }
});

test('sync pins inspected OID even if another Git process commits immediately after HEAD check', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  try {
    f.put('README.md', 'safe checkpoint'); f.commit(); const inspected = f.git('rev-parse', 'HEAD');
    mkdirSync(join(f.dir, 'scripts'));
    for (const name of ['safe-sync.ps1', 'check-safe.mjs']) copyFileSync(join(project, 'scripts', name), join(f.dir, 'scripts', name));
    f.git('remote', 'add', 'origin', 'https://github.com/dujiahang-du/agent-call-bridge');
    const quote = (v: string) => "'" + v.replaceAll("'", "''") + "'";
    // Only the fixture's git transport is intercepted; no remote is contacted.
    // Simulate a concurrent commit after rev-parse returns the inspected OID.
    const command = `
$global:fixtureGitExecutable=(Get-Command git.exe).Source
$global:fixtureHeadChecks=0
function git {
  if ($args[0] -eq 'fetch') { $global:LASTEXITCODE=0; return }
  if ($args -contains 'push') { ConvertTo-Json -InputObject @($args) | Set-Content -LiteralPath ${quote(join(f.dir, 'push-args.json'))}; $global:LASTEXITCODE=0; return }
  if ($args[0] -eq 'rev-parse' -and $args[1] -eq '--verify' -and $args[2] -eq 'HEAD') {
    $global:fixtureHeadChecks++
    $observed=& $global:fixtureGitExecutable @args
    if ($global:fixtureHeadChecks -eq 2) { & $global:fixtureGitExecutable -c ${quote('core.hooksPath=' + join(f.dir, 'no-hooks'))} commit --allow-empty -qm 'concurrent fixture commit' }
    $global:LASTEXITCODE=0; return $observed
  }
  & $global:fixtureGitExecutable @args
}
& ${quote(join(f.dir, 'scripts/safe-sync.ps1'))}
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: f.dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const args: string[] = JSON.parse(readFileSync(join(f.dir, 'push-args.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.ok(args.includes(`${inspected}:refs/heads/main`)); assert.ok(!args.includes('HEAD:main'));
    assert.notEqual(f.git('rev-parse', 'HEAD'), inspected);
  } finally { f.close(); }
});
