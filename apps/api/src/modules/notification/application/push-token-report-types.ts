/** One report: the subject is the verified token principal, the value is the request body. */
export interface PushTokenReport {
  readonly app_id: string;
  readonly user_id: string;
  readonly sid: string;
  readonly device_id: string;
  readonly provider: string;
  readonly token: string;
}
