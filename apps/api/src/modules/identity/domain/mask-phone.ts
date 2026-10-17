// BR-ID-33 默认脱敏格式 for the console's user views (F1-07a): the same rule as platform/masking's
// maskPhone, which is not on the platform barrel (modules reach platform through its index.ts
// only). An 11-digit mainland mobile number shows its first 3 and last 4 digits (138****5678);
// anything else is one "*" per code point, so no character is revealed.
//
// Also compiled by the `test` project: erasable syntax only, no imports.

const MOBILE = /^1[0-9]{10}$/;

export function maskPhone(phone: string): string {
  return MOBILE.test(phone)
    ? `${phone.slice(0, 3)}****${phone.slice(7)}`
    : '*'.repeat([...phone].length);
}
