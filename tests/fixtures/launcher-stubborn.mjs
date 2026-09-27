// Synthetic local-only worker: deliberately ignores stop so the Windows Job must contain it.
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

if (process.argv[2] === 'child') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  const lines = createInterface({ input: process.stdin });
  const state = { workerPid: process.pid, childPid: 0, stopReceived: 0 };
  const data = process.env.ACB_DATA_DIR;
  const statePath = join(data, 'stubborn-state.json');
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  lines.on('line', line => { if (line === 'ACB_STOP') { state.stopReceived++; save(); } });
  await new Promise(resolve => lines.on('line', line => { if (line === 'ACB_START') resolve(); }));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child'], { windowsHide: true, stdio: 'ignore' });
  state.childPid = child.pid;
  save();
  const token = randomUUID();
  const port = Number(process.env.ACB_PORT);
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') response.end(JSON.stringify({ service: 'agent-call-bridge' }));
    else if (request.url === '/api/status' && request.headers.authorization === `Bearer ${token}`) response.end(JSON.stringify({ mode: 'mock', realCallsEnabled: false }));
    else { response.statusCode = 401; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  writeFileSync(join(data, 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, token }));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
