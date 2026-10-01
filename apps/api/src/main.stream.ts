// Entry `stream`: Agent SSE streaming endpoint. Listens on API_HOST:STREAM_PORT.
// STUB (ADR-0001 §2 进程入口): the process starts and serves only GET /healthz. The streaming
// routes arrive with the agent tasks (B3 line); nothing here pretends to stream.
import 'reflect-metadata';
import { runEntry } from './entry.ts';

await runEntry('stream');
