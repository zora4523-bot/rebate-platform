// F1-09c: page save / publish checks (BR-ATTR-29 ①, BR-ID-33 细则, BR-WDR-01 细则, BR-TEXT-17
// 细则; 04 §6.6). Pure: every table and the switch come in through the context; the caller turns
// a non-empty result into 20001 with data.fields.
import type { LinkPatternsSpec, MaterialChannelsSpec } from '../../../../platform/index.ts';
import { hasPersonalPlaceholder, isUnionHost, normalisedHttpsHost } from './external-url.ts';

export interface PageValidationContext {
  readonly unionHostBlock: boolean;
  readonly linkPatterns: LinkPatternsSpec;
  readonly routeNames: ReadonlySet<string>;
  readonly materialChannels: MaterialChannelsSpec;
}

/** Routes whose params must stay empty (BR-WDR-01 细则). */
const FUNDS_ROUTES: ReadonlySet<string> = new Set([
  'Withdraw',
  'PayoutAccount',
  'LaborAgreement',
  'RealName',
]);

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Plain, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

class Collector {
  private readonly seen = new Set<string>();
  readonly fields: string[] = [];

  add(path: string): void {
    if (this.seen.has(path)) return;
    this.seen.add(path);
    this.fields.push(path);
  }
}

function checkExternalUrl(url: unknown, context: PageValidationContext): boolean {
  if (typeof url !== 'string') return false;
  const host = normalisedHttpsHost(url);
  if (host === null) return false;
  if (hasPersonalPlaceholder(url)) return false;
  if (context.unionHostBlock && isUnionHost(host, context.linkPatterns)) return false;
  return true;
}

function checkTarget(
  target: Plain,
  path: string,
  context: PageValidationContext,
  out: Collector,
): void {
  const route = target['route'];
  const routeOk = typeof route === 'string' && context.routeNames.has(route);
  if (!routeOk) out.add(`${path}.route`);

  const hasParams = hasOwn(target, 'params') && target['params'] !== undefined;
  const params = target['params'];
  if (hasParams && !isPlainObject(params)) {
    out.add(`${path}.params`);
    return;
  }
  if (!routeOk) return;
  const paramObject: Plain = isPlainObject(params) ? params : {};

  if (FUNDS_ROUTES.has(route) && Object.keys(paramObject).length > 0) {
    out.add(`${path}.params`);
  }
  if (route === 'ExternalPage' && !checkExternalUrl(paramObject['url'], context)) {
    out.add(`${path}.params.url`);
  }
}

function channelSelectable(entry: unknown, channels: MaterialChannelsSpec): boolean {
  if (!isPlainObject(entry)) return false;
  const platform = entry['platform'];
  const channelId = entry['channel_id'];
  if (typeof platform !== 'string' || typeof channelId !== 'string') return false;
  return channels.channels.some(
    (c) => c.platform === platform && c.channel_id === channelId && c.selectable,
  );
}

function dataSourceAllowed(section: Plain, source: Plain, context: PageValidationContext): boolean {
  const kind = source['kind'];
  if (kind === 'api') {
    return section['type'] === 'notice_bar' && Object.keys(source).length === 1;
  }
  if (kind === 'union_material') {
    const channels = source['channels'];
    return (
      Array.isArray(channels) &&
      channels.length > 0 &&
      channels.every((entry) => channelSelectable(entry, context.materialChannels))
    );
  }
  return true;
}

function walk(
  value: unknown,
  path: string,
  context: PageValidationContext,
  out: Collector,
  visiting: Set<object>,
  section: boolean,
): void {
  if (typeof value !== 'object' || value === null || visiting.has(value)) return;
  visiting.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, `${path}.${index}`, context, out, visiting, false);
    });
  } else {
    const object = value as Plain;
    if (hasOwn(object, 'route')) checkTarget(object, path, context, out);
    for (const key of Object.keys(object)) {
      const child = object[key];
      const childPath = `${path}.${key}`;
      if (section && key === 'data_source' && isPlainObject(child)) {
        if (!dataSourceAllowed(object, child, context)) out.add(childPath);
      }
      walk(child, childPath, context, out, visiting, false);
    }
  }
  visiting.delete(value);
}

/** 通过返回 []；否则返回 data.fields（去重，按遍历顺序）。 */
export function validatePageSections(sections: unknown, context: PageValidationContext): string[] {
  if (!Array.isArray(sections)) return ['sections'];
  const out = new Collector();
  const visiting = new Set<object>();
  sections.forEach((section, index) => {
    walk(section, `sections.${index}`, context, out, visiting, true);
  });
  return out.fields;
}
