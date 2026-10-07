export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface QrCodeOptions {
  readonly errorCorrection?: QrErrorCorrection;
  readonly size?: number;
  readonly margin?: number;
}

export type QrCodeErrorCode = 'empty_text' | 'text_too_long' | 'invalid_option' | 'encode_failed';

// Literal types stand in for runtime constants during the test-only skeleton phase.
export type QR_TEXT_MAX_BYTES = 1024;
export type QR_SIZE_MIN = 64;
export type QR_SIZE_MAX = 2048;
export type QR_MARGIN_MIN = 0;
export type QR_MARGIN_MAX = 8;

export class QrCodeError extends Error {
  readonly code!: QrCodeErrorCode;

  constructor(code: QrCodeErrorCode, message: string, options?: ErrorOptions) {
    super();
    void code;
    void message;
    void options;
    throw new Error('NotImplemented: QrCodeError');
  }
}

export async function renderQrCodeSvg(text: string, options?: QrCodeOptions): Promise<string> {
  void text;
  void options;
  throw new Error('NotImplemented: renderQrCodeSvg');
}

export async function renderQrCodePng(text: string, options?: QrCodeOptions): Promise<Buffer> {
  void text;
  void options;
  throw new Error('NotImplemented: renderQrCodePng');
}

export function minimumQrCodeSize(text: string, options?: QrCodeOptions): number {
  void text;
  void options;
  throw new Error('NotImplemented: minimumQrCodeSize');
}
