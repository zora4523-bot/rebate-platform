// Public surface of the notification module. Other modules import only from this file.
// B1-12b: the push token commands of a session's start and end (BR-ID-07). identity never imports
// them: app.module hands them to identity's push token port (dependency inversion).
export {
  bindPushTokensForSession,
  unbindPushTokensForSession,
} from './application/session-bindings.ts';
export type { SessionBinding, SessionUnbinding } from './application/session-bindings.ts';
export { createPushTokenReporter } from './application/push-token-report.ts';
export type {
  PushTokenConfigReader,
  PushTokenReport,
  PushTokenReporter,
  PushTokenReporterOptions,
} from './application/push-token-report.ts';
export { PushTokenController } from './http/public/push-token.controller.ts';
export type { PushTokenHttpRequest } from './http/public/push-token.controller.ts';
export { createMessageReader } from './application/message-read.ts';
export type {
  InboxMessageView,
  MessageQuery,
  MessageReader,
  MessageReaderOptions,
} from './application/message-read.ts';
export { InboxCursorError, createInboxMessages } from './application/inbox-messages.ts';
export type {
  InboxListQuery,
  InboxMessages,
  InboxMessagesOptions,
  InboxOwner,
  InboxReadCommand,
} from './application/inbox-messages.ts';
export { MessagesController } from './http/public/messages.controller.ts';
export type { MessageHttpRequest } from './http/public/messages.controller.ts';
export { NotificationModule } from './notification.module.ts';
