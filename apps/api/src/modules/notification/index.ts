// Public surface of the notification module. Other modules import only from this file.
// B1-12b: the push token commands of a session's start and end (BR-ID-07). identity never imports
// them: app.module hands them to identity's push token port (dependency inversion).
export {
  bindPushTokensForSession,
  unbindPushTokensForSession,
} from './application/session-bindings.ts';
export type { SessionBinding, SessionUnbinding } from './application/session-bindings.ts';
