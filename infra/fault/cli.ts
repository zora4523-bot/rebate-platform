import { runCli } from './fault.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  fetch: (url, init) => fetch(url, init),
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
});
