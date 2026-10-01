// Small file helpers shared by the tools.
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Writes via a temporary file in the same directory followed by a rename, so readers never see
 * a half-written file (规划/11 §2.1: run state is written to a temp file, then moved).
 */
export function writeFileAtomic(file: string, data: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', 0o644);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
