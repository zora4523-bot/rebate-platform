// Entry `payout`: withdrawal payout executor, isolated from the other processes. No HTTP port.
// Starts the isolated queue runtime; business payout handlers and fake channels arrive with B2.
import 'reflect-metadata';
import { runEntry } from './entry.ts';

await runEntry('payout');
