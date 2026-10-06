import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VendorError } from './types.ts';
import type { VendorRecording, VendorResponse, VendorTransport } from './types.ts';
import { vendorRegistry } from './registry.ts';

function invalidRecording(): VendorError {
  // Never echo a recording, filename or parser message: it may contain sensitive data.
  return new VendorError('recording_invalid', 'Invalid synthetic vendor recording');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SECRET_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'apikey',
  'xapikey',
  'secret',
  'apisecret',
  'clientsecret',
  'accesskey',
  'accesskeyid',
  'accesskeysecret',
  'secretkey',
  'privatekey',
  'password',
  'credential',
  'credentials',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'securitytoken',
  'cookie',
  'setcookie',
]);

/** Stable JSON encoding; array order matters and object key order does not. */
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw invalidRecording();
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // Array.from visits holes, which must fail rather than collide with JSON null.
      return `[${Array.from(value, (entry: unknown) => canonicalJson(entry, ancestors)).join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidRecording();
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]: [string, unknown]) => {
        if (SECRET_KEYS.has(key.replace(/[-_\s]/g, '').toLowerCase())) {
          throw new VendorError('recording_has_secret', 'Recording contains a credential field');
        }
        return `${JSON.stringify(key)}:${canonicalJson(entry, ancestors)}`;
      })
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validate all content, including nested response fields, before retaining any recording. */
export function parseVendorRecording(value: unknown): VendorRecording {
  const serialized = canonicalJson(value);
  if (
    !isRecord(value) ||
    value.synthetic !== true ||
    !vendorRegistry().some((entry) => entry.vendor === value.vendor) ||
    typeof value.model !== 'string' ||
    value.model.trim() === '' ||
    !Object.hasOwn(value, 'request') ||
    !isRecord(value.response) ||
    !Array.isArray(value.response.chunks) ||
    !isRecord(value.response.usage) ||
    !validTokenCount(value.response.usage.input_tokens) ||
    !validTokenCount(value.response.usage.output_tokens)
  ) {
    throw invalidRecording();
  }
  // JSON validation above makes this a detached snapshot, with no mutable fixture references.
  return JSON.parse(serialized) as VendorRecording;
}

function requestKey(vendor: string, model: string, body: unknown): string {
  return canonicalJson([vendor, model, body]);
}

/** No live fallback exists, including for unknown requests and invalid recordings. */
export function createReplayTransport(recordings: readonly VendorRecording[]): VendorTransport {
  const responses = new Map<string, VendorResponse>();
  for (const input of recordings) {
    const recording = parseVendorRecording(input);
    const key = requestKey(recording.vendor, recording.model, recording.request);
    if (responses.has(key)) throw invalidRecording();
    responses.set(key, recording.response);
  }
  return Object.freeze({
    billable: false,
    send: async (request, signal) => {
      if (signal?.aborted) throw new VendorError('aborted', 'Replay was cancelled');
      const response = responses.get(requestKey(request.vendor, request.model, request.body));
      if (!response) throw new VendorError('recording_miss', 'No matching synthetic recording');
      return structuredClone(response);
    },
  } satisfies VendorTransport);
}

/** Read top-level JSON files in filename order. Refuse symlinks and non-regular JSON files. */
export async function loadVendorRecordings(dir: string): Promise<VendorRecording[]> {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith('.json'))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const recordings: VendorRecording[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) throw invalidRecording();
    const file = await open(join(dir, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw invalidRecording();
      let value: unknown;
      try {
        value = JSON.parse(await file.readFile('utf8')) as unknown;
      } catch {
        throw invalidRecording();
      }
      recordings.push(parseVendorRecording(value));
    } finally {
      await file.close();
    }
  }
  return recordings;
}

/** Fixtures stay in source control; tsc does not copy JSON files into dist. */
export function vendorFixturesDir(): string {
  return fileURLToPath(
    new URL(
      '../../../../../src/modules/agent/model-gateway/vendors/__fixtures__/',
      import.meta.url,
    ),
  );
}
