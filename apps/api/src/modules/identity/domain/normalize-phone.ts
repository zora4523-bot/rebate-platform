export type NormalizedPhone =
  | { readonly code: 0; readonly phone: string }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly ['phone']; readonly reason: 'phone_invalid' };
    };

export function normalize_phone(input: string): NormalizedPhone {
  void input;
  throw new Error('NotImplemented: normalize_phone');
}
