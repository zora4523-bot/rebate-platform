// BR-ID-33 默认脱敏格式 of a person's name, for the real-name answer (task B1-13d): the same rule as
// platform/masking's maskName, which is not on the platform barrel (modules reach platform through
// its index.ts only). n ≥ 2 code points: n − 1 "*" + the last code point (**三, ***明); one code
// point becomes "*".
//
// Also compiled by the `test` project: erasable syntax only, no imports.

export function maskName(name: string): string {
  const chars = [...name];
  return chars.length < 2 ? '*'.repeat(chars.length) : '*'.repeat(chars.length - 1) + chars.at(-1);
}
