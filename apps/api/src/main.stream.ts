// Entry `stream`: Agent SSE streaming endpoint. Listens on API_HOST:STREAM_PORT.
// AppModule mounts AgentModule.forStream and identity's token checks. Nest's destroy hook waits
// for the agent runtime before platform closes its stores; only worker starts the sweeper.
import 'reflect-metadata';
import { runEntry } from './entry.ts';

await runEntry('stream');
