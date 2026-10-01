// Entry `api`: user-facing HTTP API (`/v1`). Listens on API_HOST:API_PORT.
import 'reflect-metadata';
import { runEntry } from './entry.ts';

await runEntry('api');
