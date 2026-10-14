// Entry `admin`: back-office HTTP API (`/admin/v1`). Listens on API_HOST:ADMIN_PORT.
// Serves GET /healthz and the console login (F1-06k: /admin/v1/auth, the IP whitelist and the
// admin_token check on every /admin/v1 route); the other admin routes arrive with the F1 tasks.
import 'reflect-metadata';
import { runEntry } from './entry.ts';

await runEntry('admin');
