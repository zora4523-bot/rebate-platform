/** F1-02zd: validate the admin document and reject collisions with user defaults. */
export function parseAdminDefaultTexts(
  document: unknown,
  publicDefaults: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  void document;
  void publicDefaults;
  throw new Error('NotImplemented: parseAdminDefaultTexts');
}

/** Read contracts/texts.admin.default.json lazily, never at process bootstrap. */
export function adminDefaultTexts(): Readonly<Record<string, string>> {
  throw new Error('NotImplemented: adminDefaultTexts');
}
