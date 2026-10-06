import type { SmsDelivery, SmsMessage, SmsSender } from '../application/sms-codes.ts';

export interface FakeSmsSender extends SmsSender {
  enqueueResult(result: SmsDelivery): void;
  outbox(): readonly SmsMessage[];
}

/** Only local/test may construct this adapter; default delivery outcome is accepted. */
export function createFakeSmsSender(appEnv: string): FakeSmsSender {
  void appEnv;
  throw new Error('NotImplemented: createFakeSmsSender');
}

export function smsCredentialEnvNames(): readonly string[] {
  throw new Error('NotImplemented: smsCredentialEnvNames');
}

/** Stable Nest token for the process-owned sender, also used to inspect the HTTP test outbox. */
export function smsSenderToken(): symbol {
  throw new Error('NotImplemented: smsSenderToken');
}
