// Preloaded into the worker child processes of worker-signal-start.int.test.ts
// (`node --import <this file> dist/main.worker.js`; task B1-01t, worker contract 7). Writes exactly
// one line to stderr when the process ends because its event loop ran out of work — Node emits
// 'beforeExit' then, and never when the process is ended by process.exit() or by a signal's default
// action. So the line proves a natural end: every pool closed, the keep-alive timer cleared, no
// process.exit(). The number is the exit code the process is about to end with.
// Only node: modules, erasable syntax (Node strips the types when it loads this file).
import { writeSync } from 'node:fs';

process.on('beforeExit', (code: number) => {
  writeSync(2, `exit-probe: beforeExit ${String(code)}\n`);
});
