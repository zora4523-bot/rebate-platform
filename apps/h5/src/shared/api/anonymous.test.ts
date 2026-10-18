import { expect, it } from 'vitest';
import openapi from '../../../../../contracts/openapi.yaml?raw';
import { anonymousOperations, isAnonymousOperation } from './anonymous.ts';

type Auth = 'anonymous' | 'bearer';

/** Line reader for the contract layout (2-space paths, 4-space methods, 6-space security). */
function contractAuth(): Map<string, Auth | 'undeclared'> {
  const result = new Map<string, Auth | 'undeclared'>();
  const lines = openapi.split('\n');
  let path: string | null = null;
  let operation: string | null = null;
  lines.forEach((line, index) => {
    const pathMatch = /^ {2}(\/[^:]+):$/.exec(line);
    if (pathMatch) {
      path = pathMatch[1]!.startsWith('/admin/') ? null : pathMatch[1]!;
      operation = null;
      return;
    }
    if (/^\S/.test(line)) path = null;
    const methodMatch = /^ {4}(get|post|put|patch|delete|head|options):$/.exec(line);
    if (methodMatch && path !== null) {
      operation = `${methodMatch[1]!.toUpperCase()} ${path}`;
      result.set(operation, 'undeclared');
      return;
    }
    if (operation === null || !line.startsWith('      security:')) return;
    const inline = line.slice('      security:'.length).trim();
    const items: string[] = [];
    for (let next = index + 1; lines[next]?.startsWith('        - ') === true; next += 1) {
      items.push(lines[next]!.trim().slice(2));
    }
    if (inline === '[]' || items.includes('{}')) result.set(operation, 'anonymous');
    else if (inline === '' && items.length === 1 && items[0] === 'bearerAuth: []') {
      result.set(operation, 'bearer');
    } else throw new Error(`unexpected security on ${operation}: ${line} ${items.join(',')}`);
  });
  return result;
}

it('anonymous operation list equals the contract operations with security [] or optional {}', () => {
  const auth = contractAuth();
  expect(auth.size).toBeGreaterThan(0);
  expect([...auth].filter(([, kind]) => kind === 'undeclared')).toEqual([]);
  const expected = [...auth].filter(([, kind]) => kind === 'anonymous').map(([op]) => op);
  expect([...anonymousOperations].sort()).toEqual(expected.sort());
  expect(auth.get('GET /v1/articles')).toBe('anonymous');
  expect(auth.get('GET /v1/me')).toBe('bearer');
});

it('matches method and path template exactly', () => {
  expect(isAnonymousOperation('GET', '/v1/articles/{article_id}')).toBe(true);
  expect(isAnonymousOperation('get', '/v1/articles')).toBe(true);
  expect(isAnonymousOperation('POST', '/v1/articles')).toBe(false);
  expect(isAnonymousOperation('GET', '/v1/articles/fixture-article')).toBe(false);
  expect(isAnonymousOperation('GET', '/v1/me')).toBe(false);
});
