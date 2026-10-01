// Test-only preload (`node --import`): replaces global fetch with canned GitHub API responses so
// the inline script of .github/workflows/protected-paths.yml can run without any network.
// Routes come from the JSON file named by COULI_FAKE_GITHUB: { "<path?query>": { status, body } }.
import { readFileSync } from 'node:fs';

type Route = { status: number; body: unknown };

const file = process.env['COULI_FAKE_GITHUB'];
if (file === undefined) throw new Error('COULI_FAKE_GITHUB is not set');
const routes = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Route>;
const base = process.env['GITHUB_API_URL'] ?? '';

globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const route = routes[url.startsWith(base) ? url.slice(base.length) : url];
  if (route === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
  const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
  return Promise.resolve(new Response(text, { status: route.status }));
};
