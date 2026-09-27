// Real bare-Node backend; only v0.1.2 shutdown persistence is simulated.
// The test restores main.js before replacement so the new worker is unmodified.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
await import('./launcher-legacy-actual.js');
process.on('exit', () => {
  const data = resolve(process.env.ACB_DATA_DIR ?? '.local');
  const db = new DatabaseSync(join(data, 'bridge.sqlite'));
  db.prepare("INSERT INTO meta(key,value) VALUES('paused','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
  db.prepare("DELETE FROM meta WHERE key='resume_after_shutdown'").run();
  const paused = db.prepare("SELECT value FROM meta WHERE key='paused'").get().value;
  const resumeMarker = db.prepare("SELECT value FROM meta WHERE key='resume_after_shutdown'").get() ?? null;
  db.close();
  writeFileSync(join(data, 'legacy-shutdown-fixture.json'), JSON.stringify({ simulatedVersion: '0.1.2', paused, resumeMarker }));
});
