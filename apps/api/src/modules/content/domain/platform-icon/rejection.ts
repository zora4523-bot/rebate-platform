export type PlatformIconRejectReason =
  'icon_format_invalid' | 'icon_too_large' | 'icon_svg_unconvertible';

/** Internal control flow: thrown anywhere in inspection, mapped to `{ ok: false }` at the entry. */
export class IconRejection extends Error {
  readonly reason: PlatformIconRejectReason;
  constructor(reason: PlatformIconRejectReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'IconRejection';
    this.reason = reason;
  }
}

export function invalid(detail: string): never {
  throw new IconRejection('icon_format_invalid', detail);
}

export function unconvertible(detail: string): never {
  throw new IconRejection('icon_svg_unconvertible', detail);
}
