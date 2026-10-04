import { expect, it } from 'vitest';
import { stripPlanned } from './oasdiff-base.ts';

it('drops planned operations and paths left empty, keeps shipped ones untouched', () => {
  const doc = {
    openapi: '3.1.0',
    paths: {
      '/healthz': { get: { operationId: 'getHealthz' } },
      '/v1/devices': { post: { operationId: 'registerDevice', 'x-implementation': 'planned' } },
      '/v1/mixed': {
        get: { operationId: 'shipped' },
        post: { operationId: 'later', 'x-implementation': 'planned' },
        parameters: [],
      },
    },
    components: { schemas: { A: { type: 'string' } } },
  };
  const { doc: out, removed } = stripPlanned(doc);
  expect(removed).toEqual(['POST /v1/devices', 'POST /v1/mixed']);
  expect(out['paths']).toEqual({
    '/healthz': { get: { operationId: 'getHealthz' } },
    '/v1/mixed': { get: { operationId: 'shipped' }, parameters: [] },
  });
  expect(out['components']).toEqual(doc.components);
  // The input is not modified.
  expect(Object.keys(doc.paths)).toEqual(['/healthz', '/v1/devices', '/v1/mixed']);
});

it('keeps an operation whose marker is anything but planned', () => {
  const doc = { paths: { '/x': { get: { 'x-implementation': 'shipped' } } } };
  expect(stripPlanned(doc).removed).toEqual([]);
});

it('rejects a document without paths', () => {
  expect(() => stripPlanned({ openapi: '3.1.0' })).toThrow(/paths/);
});
