import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

export function defaultSipExecutable(): string {
  const bundled = resolve('native/sip/baresip.exe');
  return existsSync(bundled) ? bundled : resolve('.tools/release/sip/baresip.exe');
}
/** Reject an ordinary upstream MSVC binary, which silently ignores -f. */
export async function verifySipExecutable(executable: string): Promise<void> {
  const path = resolve(executable);
  const manifest = JSON.parse((await readFile(join(dirname(path), 'build-manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
  if (manifest.entrypoint !== 'acb-cwd-only-v1' || manifest.platform !== 'win-x64' || manifest.tls !== false) throw new Error('Unsupported SIP build');
  const digest = createHash('sha256').update(await readFile(path)).digest('hex');
  if (digest !== manifest.sha256) throw new Error('SIP executable checksum mismatch');
}
