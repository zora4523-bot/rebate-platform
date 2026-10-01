// Entry `payout`: withdrawal payout executor, isolated from the other processes. No HTTP port.
// STUB (ADR-0001 §2 进程入口, §4.2 #20): the process initialises the platform module and waits
// for SIGTERM / SIGINT. It executes no payouts and has no payout channel; those arrive with
// the payout tasks (B2 line).
import 'reflect-metadata';
import { runEntry } from './entry.ts';

await runEntry('payout');
