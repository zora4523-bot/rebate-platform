// B1-28b: the domain error of the favorites use cases; the route layer (B1-28c) maps it to the
// 20001 envelope.

/** Envelope `data`: reason favorites_full (cap reached) or fields (e.g. [items]). */
export interface FavoriteErrorData {
  readonly reason?: 'favorites_full';
  readonly fields?: readonly string[];
}

export class FavoriteError extends Error {
  readonly code: 20001;
  readonly data: FavoriteErrorData;

  constructor(data: FavoriteErrorData, message?: string) {
    super(message ?? data.reason ?? 'Invalid favorites request');
    this.name = 'FavoriteError';
    this.code = 20001;
    this.data = data;
  }
}
