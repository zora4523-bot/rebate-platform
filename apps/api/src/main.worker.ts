// Entry `worker`: background jobs and domain-event consumers. No HTTP port.
// Starts queue supervision and the handlers registered by business modules.
import 'reflect-metadata';
import { runEntry } from './entry.ts';

await runEntry('worker');
