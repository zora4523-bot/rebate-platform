export interface PagePointer {
  readonly currentVersion: number | null;
  readonly grayVersion: number | null;
  readonly grayPercent: number;
}

export function pickPageVersion(input: {
  readonly appId: string;
  readonly deviceId: string | null;
  readonly page: PagePointer;
}): number | null {
  void input;
  throw new Error('NotImplemented: pickPageVersion');
}

export interface PageViewer {
  readonly loggedIn: boolean;
  readonly platform: string;
  readonly appVersion: string | undefined;
}

export function passesVersionGate(section: unknown, viewer: PageViewer): boolean {
  void section;
  void viewer;
  throw new Error('NotImplemented: passesVersionGate');
}

export function matchesCondition(section: unknown, viewer: PageViewer): boolean {
  void section;
  void viewer;
  throw new Error('NotImplemented: matchesCondition');
}

export function selectSections(sections: readonly unknown[], viewer: PageViewer): unknown[] {
  void sections;
  void viewer;
  throw new Error('NotImplemented: selectSections');
}
