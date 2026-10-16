// Dev-server proxy for the admin console (vite.config.ts): with COULI_ADMIN_API_TARGET set, the
// Vite dev server forwards /admin/v1 (path unchanged) to that local API, so the console signs in
// against the real admin entry; unset or empty, nothing is proxied and the dev server keeps the
// preview accounts. Runs in the Vite config (Node): no browser code here.

export type DevProxy = Record<string, { target: string; changeOrigin: true }>;

const PROXIED_PREFIX = '/admin/v1';

export function devProxy(target: string | undefined): DevProxy | undefined {
  if (target === undefined || target === '') return undefined;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`COULI_ADMIN_API_TARGET must be an absolute http(s) address: ${target}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`COULI_ADMIN_API_TARGET must be an absolute http(s) address: ${target}`);
  return { [PROXIED_PREFIX]: { target, changeOrigin: true } };
}
