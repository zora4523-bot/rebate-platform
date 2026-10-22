// Page version selection and section filtering for GET /v1/pages/{page_key} (规划/04 §6.2, §3.2;
// 08 BR-ID-11 细则「首页人群与灰度」; 03 §6.1; BR-INV-23). Pure: no database, clock, config,
// HTTP or logging.
//
// - Version: gray rollout is bucketed by device_id only (no user_id, no page_key salt); a request
//   without a device_id always gets the current (full) version.
// - min_app_version is per platform {ios, android, harmony}; only a "not lower than" gate.
//   Anything unreadable (missing entry for this platform, malformed threshold, missing or
//   malformed client version) fails closed: the section is not served.
// - condition: login from the token; has_parent / union_authorized / has_order from the request's
//   audience facts (F1-09g, 编排者默认 G1–G4): `any` always matches, `yes` / `no` need the fact to be
//   exactly true / false. An unknown fact (null) or a viewer without facts matches only `any`.
//   Unknown keys or values fail closed.
import { compareClientVersions, isVersionGatedPlatform } from '../../../../platform/index.ts';
import { h5Bucket } from '../../client-config.ts';

export interface PagePointer {
  /** Current full-rollout version. */
  readonly currentVersion: number | null;
  readonly grayVersion: number | null;
  /** Integer percent 0..100. */
  readonly grayPercent: number;
  /**
   * The pending scheduled publish (F1-09p; app.pages.scheduled_*), all four set or none. Optional
   * so that stores without schedules keep working; pickPageVersion ignores them (the reader
   * applies a due schedule first, ../schedule.ts).
   */
  readonly scheduledVersion?: number | null;
  readonly scheduledGrayPercent?: number | null;
  readonly scheduledAt?: Date | null;
  readonly scheduledByAdminId?: string | null;
}

/** Bucket count per percent: h5Bucket has 10000 buckets. */
const BUCKETS_PER_PERCENT = 100;

/**
 * The page version to serve: the gray version when the device's bucket falls below
 * grayPercent × 100, else the current version. No device id → current version. null when the
 * chosen pointer is empty (the caller answers 30701).
 */
export function pickPageVersion(input: {
  readonly appId: string;
  readonly deviceId: string | null;
  readonly page: PagePointer;
}): number | null {
  const { appId, deviceId, page } = input;
  if (deviceId === null || deviceId === '' || page.grayVersion === null) {
    return page.currentVersion;
  }
  return h5Bucket(appId, deviceId) < page.grayPercent * BUCKETS_PER_PERCENT
    ? page.grayVersion
    : page.currentVersion;
}

export interface PageViewer {
  readonly loggedIn: boolean;
  /** Raw X-Platform. */
  readonly platform: string;
  /** Raw X-App-Version. */
  readonly appVersion: string | undefined;
  /** Request-time audience facts (F1-09g); absent → only `any` matches the three fact keys. */
  readonly audience?: AudienceFacts;
}

/** F1-09g §9.2: request-time facts; null means unavailable, never false. */
export interface AudienceFacts {
  readonly hasParent: boolean | null;
  readonly unionAuthorized: boolean | null;
  readonly hasOrder: boolean | null;
}

/** The condition keys judged from AudienceFacts, and the fact each one reads. */
export const AUDIENCE_FACT_KEYS: ReadonlyMap<string, keyof AudienceFacts> = new Map([
  ['has_parent', 'hasParent'],
  ['union_authorized', 'unionAuthorized'],
  ['has_order', 'hasOrder'],
]);

type Fields = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(record: Fields, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Whether the section's per-platform min_app_version admits the viewer ("not lower than"). */
export function passesVersionGate(section: unknown, viewer: PageViewer): boolean {
  if (!isRecord(section)) return false;
  const gate = field(section, 'min_app_version');
  if (gate === undefined || gate === null) return true;
  if (!isVersionGatedPlatform(viewer.platform)) return true;
  if (!isRecord(gate)) return false;
  const minimum = field(gate, viewer.platform);
  if (typeof minimum !== 'string') return false;
  let order: -1 | 0 | 1 | null;
  try {
    order = compareClientVersions(viewer.appVersion, minimum);
  } catch {
    // A malformed threshold is a configuration fault: do not serve the section.
    return false;
  }
  return order !== null && order >= 0;
}

const ANY = 'any';

function matchesLogin(value: unknown, loggedIn: boolean): boolean {
  if (value === ANY) return true;
  if (value === 'yes') return loggedIn;
  if (value === 'no') return !loggedIn;
  return false;
}

function matchesFact(value: unknown, fact: boolean | null): boolean {
  if (value === ANY) return true;
  if (value === 'yes') return fact === true;
  if (value === 'no') return fact === false;
  return false;
}

/**
 * Which audience facts the sections' conditions actually need (a value other than `any` under a
 * fact key), so a page that never filters on a fact does not read it.
 */
export function neededAudienceFacts(sections: readonly unknown[]): Set<keyof AudienceFacts> {
  const needed = new Set<keyof AudienceFacts>();
  for (const section of sections) {
    if (!isRecord(section)) continue;
    const condition = field(section, 'condition');
    if (!isRecord(condition)) continue;
    for (const key of Object.keys(condition)) {
      const fact = AUDIENCE_FACT_KEYS.get(key);
      if (fact !== undefined && condition[key] !== ANY) needed.add(fact);
    }
  }
  return needed;
}

/** Whether the viewer is in the section's audience; absent / null condition matches everyone. */
export function matchesCondition(section: unknown, viewer: PageViewer): boolean {
  if (!isRecord(section)) return false;
  const condition = field(section, 'condition');
  if (condition === undefined || condition === null) return true;
  if (!isRecord(condition)) return false;
  return Object.keys(condition).every((key) => {
    const value = condition[key];
    if (key === 'login') return matchesLogin(value, viewer.loggedIn);
    const fact = AUDIENCE_FACT_KEYS.get(key);
    if (fact !== undefined) return matchesFact(value, viewer.audience?.[fact] ?? null);
    return false;
  });
}

/** Sections passing both the version gate and the audience condition, in input order, as-is. */
export function selectSections(sections: readonly unknown[], viewer: PageViewer): unknown[] {
  return sections.filter(
    (section) => passesVersionGate(section, viewer) && matchesCondition(section, viewer),
  );
}
