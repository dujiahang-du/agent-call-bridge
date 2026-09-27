import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
if (resolve(git('rev-parse', '--show-toplevel')).toLowerCase() !== root.toLowerCase()) throw new Error('Repository root mismatch');
const history = process.argv.includes('--history');
const files = history ? git('ls-tree', '-r', '--name-only', 'HEAD').split('\n') : git('diff', '--cached', '--name-only', '--diff-filter=ACMR').split('\n');
const forbidden = /(^|\/)(\.local|\.tools|\.cache|node_modules|auth\.json|connection\.json|config\.protected|\.env(?:\..*)?)($|\/)|\.(?:db|sqlite\w*|wav|mp3|pem|pfx|p12|log|exe|dll|zip)$/i;
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{25,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/,
  /\bLTAI[A-Za-z0-9]{16,}\b/,
];
const problems = [];
for (const file of files.filter(Boolean)) {
  if (forbidden.test(file)) { problems.push(`${file}: forbidden runtime/private file`); continue; }
  const content = git('show', history ? `HEAD:${file}` : `:${file}`);
  if (content.includes('\uFFFD')) problems.push(`${file}: invalid UTF-8 replacement character`);
  if (patterns.some(p => p.test(content))) problems.push(`${file}: possible credential (value redacted)`);
}
if (history) {
  const text = git('log', '--all', '-p', '--format=commit:%h', '--', '.', ':!package-lock.json');
  if (patterns.some(p => p.test(text))) problems.push('History contains possible credential (value redacted)');
}
if (problems.length) { process.stderr.write(problems.join('\n') + '\n'); process.exit(1); }
process.stdout.write(`Safety check passed: ${files.filter(Boolean).length} files${history ? ' and complete local history' : ' staged'}.\n`);
