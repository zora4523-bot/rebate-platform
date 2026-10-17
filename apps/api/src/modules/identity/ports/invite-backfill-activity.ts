/** Only the verified token supplies appId and userId. */
export interface MeSubject {
  readonly appId: string;
  readonly userId: string;
}

/** BR-INV-07 (c): attributed orders and recovery claims, including every status. */
export interface InviteBackfillActivityPort {
  orderCount(subject: MeSubject): Promise<number>;
  hasClaims(subject: MeSubject): Promise<boolean>;
}
