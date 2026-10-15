export interface PlatformIconOptions {
  maxBytes: number;
  deadline: { remainingMs(): number };
}

export type PlatformIconResult =
  | {
      ok: true;
      bytes: Uint8Array;
      sha256: string;
      format: 'svg' | 'png';
      sanitized: boolean;
    }
  | {
      ok: false;
      reason: 'icon_format_invalid' | 'icon_too_large' | 'icon_svg_unconvertible';
    };

export function inspectPlatformIcon(
  input: Uint8Array,
  options: PlatformIconOptions,
): PlatformIconResult {
  void input;
  void options;
  throw new Error('NotImplemented: inspectPlatformIcon');
}
