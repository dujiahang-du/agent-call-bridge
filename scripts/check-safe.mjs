import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Fail closed: every index entry; --history additionally scans every path in
// every reachable commit and every reachable blob/tag/message, including deleted
// files, binary payloads, unpushed branches and complete first-publication history.
// No diff-text scanning, external ignore file, baseline or blanket test exemption.
const forbidden = /(^|\/)(?:\.local|\.tools|\.cache|node_modules|release|coverage|test-results|playwright-report|auth\.json|connection\.json|config\.(?:protected|enc)|\.env(?:\..*)?)($|\/)|\.(?:db|sqlite\w*|wav|mp3|m4a|ogg|flac|pcm|pem|key|pfx|p12|log|exe|dll|zip|7z|tar|gz)$/i;
const credentialPatterns = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bLTAI[A-Za-z0-9]{16,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:SK|AC)[a-fA-F0-9]{32}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /https?:\/\/[^\s/:@]+:[^\s/@]{4,}@/g,
  /\bBearer\s+[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+)*/g,
];
const literalSecret = /(?<![\w"'])(["']?)(?:auth[_-]?token|access[_-]?key(?:[_-]?(?:id|secret))?|api[_-]?key|client[_-]?secret|password|secret|control[_-]?pin|token)\1\s*[:=]\s*["']([^"'\r\n]{4,})["']/gi;
const environmentSecret = /\b[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY_ID|ACCESS_KEY_SECRET)\s*=\s*([A-Za-z0-9_+/.=-]{8,})/g;
const phonePatterns = [
  /(?<![\w+])\+[1-9](?:[ ()-]?\d){6,14}(?!\d)/g,
  /(?<![\d+])1[3-9]\d{9}(?!\d)/g,
  /["'](\d{10,11})["']/g,
];

// Exact path + exact synthetic value only. Phone fixtures are fictional NANP
// 202-555-01xx or Twilio documented magic-test numbers; credentials are named
// offline fixtures. A different value in these same files still fails.
const fixtureAllowlist = new Map([
  ['tests/providers.test.ts', new Set(['fixture-only-not-a-real-secret', 'fixture-id', '7531', '+15005550009', '+15005550006', '5005550009'])],
  ['tests/core.test.ts', new Set(['2025550101', 'unit-test-secret', 'dpapi-fixture-secret'])],
  ['tests/sip-native.test.ts', new Set(['synthetic-test-password'])],
  // Display labels / HTML input type, not configured credentials.
  ['src/web/main.tsx', new Set(['Auth Token', 'AccessKey ID', 'AccessKey Secret', 'text'])],
]);
// Only the enumeration above is also exempt in this scanner's declaration.
fixtureAllowlist.set('scripts/check-safe.mjs', new Set([...fixtureAllowlist.values()].flatMap(s => [...s])));
// Root agent visually reviewed this isolated Mock UI screenshot on 2026-09-27:
// no real number, credential, token, thread ID or personal data. Every replacement
// requires another visual review AND a new exact digest; no directory exemption.
const reviewedAssets = new Map([
  ['docs/screenshots/workbench.png', 'c3440b2ceb9946928b724a23a14e6535b82e9247f5202c19c28f012c29bd3404'],
]);

function matches(text, path) {
  const kinds = new Set();
  const allowed = fixtureAllowlist.get(path);
  for (const re of credentialPatterns) for (const m of text.matchAll(re)) if (!allowed?.has(m[0])) kinds.add('possible credential (value redacted)');
  for (const m of text.matchAll(literalSecret)) if (!allowed?.has(m[2])) kinds.add('literal secret (value redacted)');
  for (const m of text.matchAll(environmentSecret)) if (!allowed?.has(m[1])) kinds.add('environment secret (value redacted)');
  for (const re of phonePatterns) for (const m of text.matchAll(re)) if (!allowed?.has(m[1] ?? m[0])) kinds.add('possible phone number (value redacted)');
  return [...kinds];
}
function label(path) { return matches(path, '').length || /[\x00-\x1f\x7f]/.test(path) ? '[sensitive or nonstandard path redacted]' : path; }
function textOf(buffer) { try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return null; } }

export function scanRepository(repositoryRoot, { history = false } = {}) {
  const root = resolve(repositoryRoot);
  const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args], { cwd: root, maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (resolve(git('rev-parse', '--show-toplevel').toString('utf8').trim()).toLowerCase() !== root.toLowerCase()) throw new Error('Repository root mismatch');
  const problems = [], seenPaths = new Set(), seenBlobs = new Set(), contentCache = new Map();
  if (git('rev-parse', '--is-shallow-repository').toString('utf8').trim() === 'true') throw new Error('Shallow history cannot be fully inspected');
  let commits = 0;
  const report = (path, kind) => problems.push({ path: label(path), kind });
  const scanContent = (oid, path) => {
    seenBlobs.add(oid);
    let bytes = contentCache.get(oid);
    if (!bytes) { bytes = git('cat-file', 'blob', oid); contentCache.set(oid, bytes); }
    const text = textOf(bytes);
    if (text === null || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
      // Only an explicitly reviewed path AND content digest can admit a binary.
      if (reviewedAssets.get(path) !== createHash('sha256').update(bytes).digest('hex')) report(path, 'binary or invalid UTF-8 content requires explicit review');
      for (const decoded of [bytes.toString('latin1'), bytes.toString('utf16le')]) for (const kind of matches(decoded, path)) report(path, kind);
    } else for (const kind of matches(text, path)) report(path, kind);
  };
  const inspect = (mode, type, oid, path) => {
    const key = `${mode}:${oid}:${path}`;
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    if (path !== '.env.example' && forbidden.test(path)) report(path, 'forbidden runtime/private file');
    for (const kind of matches(path, '')) report(path, kind);
    if (!['100644', '100755'].includes(mode) || type !== 'blob') { report(path, 'symlink/submodule or unsupported Git entry'); return; }
    scanContent(oid, path);
  };
  const indexText = textOf(git('ls-files', '--stage', '-z'));
  if (indexText === null) throw new Error('Invalid UTF-8 Git path');
  const index = indexText.split('\0').filter(Boolean);
  for (const entry of index) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Unrecognized Git index entry');
    if (match[3] !== '0') report(match[4], 'unmerged index entry');
    inspect(match[1], 'blob', match[2], match[4]);
  }
  if (history) {
    const commitIds = git('rev-list', '--all').toString('utf8').trim().split('\n').filter(Boolean);
    // --all includes HEAD (including detached HEAD), local/remote refs and tags.
    // Enumerating every tree preserves all historical names of shared blobs.
    for (const commit of commitIds) {
      commits++;
      const message = git('cat-file', 'commit', commit).toString('utf8').split('\n\n').slice(1).join('\n\n');
      for (const kind of matches(message, '')) report(`commit ${commit.slice(0, 12)} message`, kind);
      const treeText = textOf(git('ls-tree', '-rz', '--full-tree', commit));
      if (treeText === null) throw new Error('Invalid UTF-8 historical path');
      for (const entry of treeText.split('\0').filter(Boolean)) {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
        if (!match) throw new Error('Unrecognized Git tree entry');
        inspect(match[1], match[2], match[3], match[4]);
      }
    }
    const objects = git('rev-list', '--objects', '--all', '--no-object-names').toString('utf8').trim().split('\n').filter(Boolean);
    for (const oid of objects) {
      if (seenBlobs.has(oid)) continue;
      const type = git('cat-file', '-t', oid).toString('utf8').trim();
      if (type === 'blob') scanContent(oid, `unattached blob ${oid.slice(0, 12)}`);
      if (type === 'tag') for (const kind of matches(git('cat-file', 'tag', oid).toString('utf8'), '')) report(`tag ${oid.slice(0, 12)}`, kind);
    }
  }
  return { problems, indexEntries: index.length, pathVersions: seenPaths.size, blobs: seenBlobs.size, commits };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--history')) throw new Error('Unsupported option');
    const result = scanRepository(resolve(dirname(fileURLToPath(import.meta.url)), '..'), { history: process.argv.includes('--history') });
    if (result.problems.length) {
      for (const p of result.problems) process.stderr.write(`${p.path}: ${p.kind}\n`);
      process.exitCode = 1;
    } else process.stdout.write(`Safety check passed: ${result.indexEntries} index entries, ${result.pathVersions} path versions, ${result.blobs} blobs, ${result.commits} historical commits.\n`);
  } catch { process.stderr.write('Safety check failed closed: Git data could not be fully inspected. No values were printed.\n'); process.exitCode = 1; }
}
