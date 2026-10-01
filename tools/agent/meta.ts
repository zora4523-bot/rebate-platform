// JSON helper for the bash wrappers in tools/agent (bash cannot escape or parse JSON safely).
//
//   node meta.ts merge --file <json> [--new] [--copy-to <file>]
//                      [--str k=v]... [--num k=v]... [--bool k=true|false]... [--null k]...
//                      [--list k=a,b,c]... [--lines k=<file>]... [--json k=<json text>]...
//       Writes (with --new) or updates a flat JSON object atomically.
//   node meta.ts events --events <file> [--err <file>]
//       Prints shell-readable facts about a `codex exec --json` event stream:
//       last_type=<type of the last non-empty line | none | invalid>, thread_id=<id or empty>,
//       capacity=<0|1> (model capacity error reported by an error event or on stderr).
//   node meta.ts get --file <json> <key>
//       Prints one scalar (empty line when missing or null); `a.b` reads a nested key.
//   node meta.ts emit [--str k=v]... (same value flags as merge)
//       Prints one compact JSON object on stdout.
//
// Exit codes: 0 ok, 2 usage or internal error.
import { existsSync, readFileSync } from 'node:fs';
import { readJsonFile, writeFileAtomic } from '../lib/fsx.ts';

export const CAPACITY_TEXT = 'Selected model is at capacity';

export type EventFacts = { lastType: string; threadId: string; capacity: boolean };

type JsonObject = Record<string, unknown>;

class UsageError extends Error {}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the facts the wrapper needs from a `codex exec --json` event stream. */
export function eventFacts(eventsText: string, stderrText: string): EventFacts {
  let lastType = 'none';
  let threadId = '';
  let capacity = stderrText.includes(CAPACITY_TEXT);
  for (const line of eventsText.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      lastType = 'invalid';
      continue;
    }
    if (!isObject(event) || typeof event['type'] !== 'string') {
      lastType = 'invalid';
      continue;
    }
    lastType = event['type'];
    if (lastType === 'thread.started' && typeof event['thread_id'] === 'string') {
      threadId = event['thread_id'];
    }
    // Only error-type events count: file contents quoted in ordinary items are data.
    if ((lastType === 'error' || lastType === 'turn.failed') && line.includes(CAPACITY_TEXT)) {
      capacity = true;
    }
  }
  return { lastType, threadId: threadId.replace(/[^A-Za-z0-9_-]/g, ''), capacity };
}

function splitPair(flag: string, raw: string | undefined): [string, string] {
  const at = raw === undefined ? -1 : raw.indexOf('=');
  if (raw === undefined || at <= 0) throw new UsageError(`${flag} needs <key>=<value>`);
  return [raw.slice(0, at), raw.slice(at + 1)];
}

/** Applies the value flags shared by `merge` and `emit`; returns the arguments it did not use. */
export function applyValueFlags(target: JsonObject, args: readonly string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i] ?? '';
    const raw = args[i + 1];
    switch (flag) {
      case '--str': {
        const [key, value] = splitPair(flag, raw);
        target[key] = value;
        i += 1;
        break;
      }
      case '--num': {
        const [key, value] = splitPair(flag, raw);
        if (!/^-?\d+$/.test(value)) throw new UsageError(`--num ${key}: not an integer: ${value}`);
        target[key] = Number(value);
        i += 1;
        break;
      }
      case '--bool': {
        const [key, value] = splitPair(flag, raw);
        if (!['true', 'false', '1', '0'].includes(value)) {
          throw new UsageError(`--bool ${key}: expected true|false|1|0, got ${value}`);
        }
        target[key] = value === 'true' || value === '1';
        i += 1;
        break;
      }
      case '--null': {
        if (raw === undefined) throw new UsageError('--null needs <key>');
        target[raw] = null;
        i += 1;
        break;
      }
      case '--list': {
        const [key, value] = splitPair(flag, raw);
        target[key] = value === '' ? [] : value.split(',');
        i += 1;
        break;
      }
      case '--json': {
        const [key, value] = splitPair(flag, raw);
        try {
          target[key] = JSON.parse(value) as unknown;
        } catch {
          target[key] = value;
        }
        i += 1;
        break;
      }
      case '--lines': {
        const [key, file] = splitPair(flag, raw);
        target[key] = existsSync(file)
          ? readFileSync(file, 'utf8')
              .split('\n')
              .filter((line) => line !== '')
          : [];
        i += 1;
        break;
      }
      default:
        rest.push(flag);
    }
  }
  return rest;
}

function takeOption(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined) throw new UsageError(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function takeSwitch(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
}

function requireEmpty(rest: readonly string[]): void {
  if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);
}

function main(argv: readonly string[]): number {
  const [command, ...tail] = argv;
  const args = [...tail];
  if (command === 'merge') {
    const file = takeOption(args, '--file');
    const copyTo = takeOption(args, '--copy-to');
    const fresh = takeSwitch(args, '--new');
    if (file === undefined) throw new UsageError('merge needs --file');
    let doc: JsonObject = {};
    if (!fresh) {
      const current = readJsonFile(file);
      if (!isObject(current)) throw new Error(`${file}: not a JSON object`);
      doc = current;
    }
    requireEmpty(applyValueFlags(doc, args));
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    writeFileAtomic(file, text);
    if (copyTo !== undefined) writeFileAtomic(copyTo, text);
    return 0;
  }
  if (command === 'events') {
    const eventsFile = takeOption(args, '--events');
    const errFile = takeOption(args, '--err');
    requireEmpty(args);
    if (eventsFile === undefined) throw new UsageError('events needs --events');
    const read = (file: string | undefined): string =>
      file !== undefined && existsSync(file) ? readFileSync(file, 'utf8') : '';
    const facts = eventFacts(read(eventsFile), read(errFile));
    const lastType = /^[A-Za-z0-9._-]+$/.test(facts.lastType) ? facts.lastType : 'invalid';
    process.stdout.write(
      `last_type=${lastType}\nthread_id=${facts.threadId}\ncapacity=${facts.capacity ? 1 : 0}\n`,
    );
    return 0;
  }
  if (command === 'get') {
    const file = takeOption(args, '--file');
    const [key, ...extra] = args;
    requireEmpty(extra);
    if (file === undefined || key === undefined) throw new UsageError('get needs --file and <key>');
    let value: unknown = readJsonFile(file);
    for (const part of key.split('.')) value = isObject(value) ? value[part] : undefined;
    const scalar = ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : '';
    process.stdout.write(`${scalar.replace(/\n/g, ' ')}\n`);
    return 0;
  }
  if (command === 'emit') {
    const doc: JsonObject = {};
    requireEmpty(applyValueFlags(doc, args));
    process.stdout.write(`${JSON.stringify(doc)}\n`);
    return 0;
  }
  throw new UsageError('usage: meta.ts merge|events|get|emit ...');
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`meta.ts: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
