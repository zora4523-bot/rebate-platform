// Entry `admin`: back-office HTTP API (`/admin/v1`). Listens on API_HOST:ADMIN_PORT.
// STUB (ADR-0001 §2 进程入口): the process starts and serves only GET /healthz. Admin
// authentication and routes arrive with the admin tasks (F1 line).
import 'reflect-metadata';
import { runEntry } from './entry.ts';

await runEntry('admin');
