// Checks specs/app-stores.yaml, the store table of 【去更新】 (规划/03 §4.1; 规划/08 BR-ID-01 细则
// 「【去更新】打开哪家商店与保存前的核对」). Run by codegen.ts in both modes, so
// `pnpm contracts:check` fails on a violation. Structure only: values that 08 and 03 do not give
// stay null or empty until filled from each store's documentation. The generator belongs to CT-05.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import type { EnumDef } from './catalog.ts';
import { repoRoot } from './paths.ts';

export const appStoresFile = join(repoRoot, 'specs', 'app-stores.yaml');

const STORE_KEY = /^[a-z][a-z0-9_]*$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const FIELDS = [
  'key',
  'name',
  'platform',
  'channels',
  'install_source_packages',
  'detail_page',
  'source',
];
const APP_PLATFORMS = ['ios', 'android', 'harmony'];
/** Channels with a single store (03 §4.1: iOS, Harmony and the Huawei channel package). */
const SINGLE_STORE_CHANNELS = ['appstore', 'huawei', 'agc'];

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nullOrText(v: unknown): boolean {
  return v === null || (typeof v === 'string' && v.trim() !== '');
}

export function checkAppStoreDoc(
  doc: unknown,
  enums: readonly EnumDef[],
  where = 'specs/app-stores.yaml',
): string[] {
  const problems: string[] = [];
  if (!isObj(doc)) return [`${where}: top level must be a mapping`];
  const extra = Object.keys(doc).filter((k) => k !== 'version' && k !== 'stores');
  if (extra.length > 0) problems.push(`${where}: unknown top-level keys ${extra.join(', ')}`);
  if (typeof doc['version'] !== 'string' || doc['version'] === '') {
    problems.push(`${where}: version must be a non-empty string`);
  }
  const stores = doc['stores'];
  if (!Array.isArray(stores)) return [...problems, `${where}: stores must be a list`];
  const values = (name: string): string[] =>
    enums.find((e) => e.name === name)?.values.map((v) => v.value) ?? [];
  const platforms = values('client_platform').filter((p) => APP_PLATFORMS.includes(p));
  const channels = values('install_channel');
  const keys = new Map<string, number>();
  const packages = new Map<string, number>();
  const channelUse = new Map<string, number[]>();
  stores.forEach((store, i) => {
    const at = `${where}: stores[${String(i)}]`;
    if (!isObj(store)) {
      problems.push(`${at}: must be a mapping`);
      return;
    }
    for (const k of Object.keys(store))
      if (!FIELDS.includes(k)) problems.push(`${at}: unknown key ${k}`);
    for (const k of FIELDS) if (!(k in store)) problems.push(`${at}: missing ${k}`);
    const { key, name, platform, channels: chs, install_source_packages: pkgs } = store;
    if (key !== null) {
      if (typeof key !== 'string' || !STORE_KEY.test(key)) {
        problems.push(`${at}: key must be null or match ${STORE_KEY.source}`);
      } else if (keys.has(key)) {
        problems.push(`${at}: duplicate key ${key} (also stores[${String(keys.get(key))}])`);
      } else keys.set(key, i);
    }
    if (typeof name !== 'string' || name.trim() === '')
      problems.push(`${at}: name must be a non-empty string`);
    if (typeof platform !== 'string' || !platforms.includes(platform)) {
      problems.push(`${at}: platform must be one of ${platforms.join(', ')} (client_platform)`);
    }
    if (!Array.isArray(chs) || chs.length === 0) {
      problems.push(`${at}: channels must be a non-empty list`);
    } else {
      chs.forEach((c, j) => {
        if (typeof c !== 'string' || !channels.includes(c)) {
          problems.push(`${at}: channel ${JSON.stringify(c)} is not an install_channel`);
        } else if (chs.indexOf(c) !== j) {
          problems.push(`${at}: duplicate channel ${c}`);
        } else channelUse.set(c, [...(channelUse.get(c) ?? []), i]);
      });
    }
    if (!Array.isArray(pkgs)) {
      problems.push(`${at}: install_source_packages must be a list`);
    } else {
      if (pkgs.length > 0 && platform !== 'android') {
        problems.push(`${at}: install_source_packages is for android stores only`);
      }
      for (const p of pkgs) {
        if (typeof p !== 'string' || !PACKAGE.test(p)) {
          problems.push(`${at}: package ${JSON.stringify(p)} is not a package name`);
        } else if (packages.has(p)) {
          problems.push(`${at}: package ${p} is also listed by stores[${String(packages.get(p))}]`);
        } else packages.set(p, i);
      }
    }
    const page = store['detail_page'];
    if (!isObj(page)) {
      problems.push(`${at}: detail_page must be a mapping {open_method, target}`);
    } else {
      const px = Object.keys(page).filter((k) => k !== 'open_method' && k !== 'target');
      if (px.length > 0) problems.push(`${at}: detail_page: unknown keys ${px.join(', ')}`);
      if (!('open_method' in page) || !('target' in page)) {
        problems.push(`${at}: detail_page needs open_method and target`);
      }
      if (!nullOrText(page['open_method']) || !nullOrText(page['target'])) {
        problems.push(`${at}: detail_page values must be null or non-empty strings`);
      }
    }
    if (typeof store['source'] !== 'string' || store['source'].trim() === '') {
      problems.push(`${at}: source must be a non-empty string`);
    }
  });
  for (const c of SINGLE_STORE_CHANNELS) {
    const used = channelUse.get(c) ?? [];
    if (used.length > 1) {
      problems.push(
        `${where}: channel ${c} has a single store (03 §4.1) but ${String(used.length)} list it`,
      );
    }
  }
  return problems;
}

export function checkAppStores(enums: readonly EnumDef[], file: string = appStoresFile): string[] {
  const where = 'specs/app-stores.yaml';
  try {
    return checkAppStoreDoc(parseYamlLite(readFileSync(file, 'utf8')), enums, where);
  } catch (err) {
    return [`${where}: ${err instanceof Error ? err.message : String(err)}`];
  }
}
