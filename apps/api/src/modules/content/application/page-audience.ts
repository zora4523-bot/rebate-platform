/** F1-09g §9.2: request-time facts; null means unavailable, never false. */
export interface AudienceFacts {
  readonly hasParent: boolean | null;
  readonly unionAuthorized: boolean | null;
  readonly hasOrder: boolean | null;
}

/** Assembled by app.module from other modules' public read ports. */
export interface PageAudienceFacts {
  facts(appId: string, userId: string): Promise<AudienceFacts>;
}
