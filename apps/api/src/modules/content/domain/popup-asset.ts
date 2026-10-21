// F1-09r / BR-TEXT-26: pure inspection port; implementation follows the red rule tests.
export type PopupAssetKind = 'lottie' | 'image';
export type PopupAssetRejectReason = 'format' | 'too_large' | 'too_long' | 'external_ref';

export type PopupAssetResult =
  | { readonly ok: false; readonly reason: PopupAssetRejectReason }
  | {
      readonly ok: true;
      readonly format: 'json' | 'png' | 'jpg';
      readonly sha256: string;
      readonly bytes: Uint8Array;
      readonly width?: number;
      readonly height?: number;
      readonly durationMs?: number;
    };

export function inspectPopupAsset(kind: PopupAssetKind, input: Uint8Array): PopupAssetResult {
  void kind;
  void input;
  throw new Error('NotImplemented: inspectPopupAsset');
}
