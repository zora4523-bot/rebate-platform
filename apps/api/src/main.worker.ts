// Entry `worker`: background jobs and domain-event consumers. No HTTP port.
// STUB (ADR-0001 §2 进程入口, 队列): the process initialises the platform module and waits for
// SIGTERM / SIGINT. It runs no jobs: the pg-boss runner arrives with B1-01.
import 'reflect-metadata';
import { runEntry } from './entry.ts';

await runEntry('worker');
