// The launcher assigns this process to its Windows Job before opening the gate.
// No app imports or child processes may run before ACB_START.
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
let started = false;
let stopping = false;
const timeout = setTimeout(() => process.exit(1), 10000);
function stop() {
  if (stopping) return;
  stopping = true;
  if (!started) process.exit(0);
  process.emit('SIGTERM');
}
input.on('close', stop);
await new Promise(resolve => input.on('line', line => {
  if (line === 'ACB_STOP') stop();
  else if (line === 'ACB_START') resolve();
}));
clearTimeout(timeout);
await import('../dist/server/main.js');
started = true;
