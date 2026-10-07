import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';

export function checkDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Recording directory must be a real directory');
  }
}

export function readJsonFile(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Recording must be a regular file');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally {
    closeSync(fd);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object');
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error('Unsupported recording envelope key');
  }
}

interface RecordingEnvelope {
  request: { method: 'GET' | 'POST'; path: string; body?: string };
  response: { status: number; headers: Record<string, string>; body: string };
}

/** B1-04c transport envelope only; platform payloads stay opaque. */
export function validateRecording(input: unknown): RecordingEnvelope {
  const envelope = object(input);
  onlyKeys(envelope, ['request', 'response']);
  const request = object(envelope['request']);
  const response = object(envelope['response']);
  onlyKeys(request, ['method', 'path', 'body']);
  onlyKeys(response, ['status', 'headers', 'body']);
  const method = request['method'];
  if (method !== 'GET' && method !== 'POST') throw new Error('Invalid recording method');
  const path = request['path'];
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Recording requires an absolute URL path');
  }
  const requestBody = request['body'];
  if (requestBody !== undefined && typeof requestBody !== 'string') {
    throw new Error('Invalid recording request body');
  }
  const status = response['status'];
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('Invalid recording response status');
  }
  const headers = object(response['headers']);
  if (Object.values(headers).some((value) => typeof value !== 'string')) {
    throw new Error('Invalid recording response headers');
  }
  const body = response['body'];
  if (typeof body !== 'string') throw new Error('Invalid recording response body');
  return {
    request: { method, path, ...(requestBody === undefined ? {} : { body: requestBody }) },
    response: { status, headers: { ...headers } as Record<string, string>, body },
  };
}
