import { pid_scene, scene } from '@couli/contracts-ts';
import { describe, expect, it } from 'vitest';
import {
  LinkingError,
  isSwitchOn,
  logsRegistration,
  parseScene,
  pidSceneOf,
  urlLifetimeMs,
} from './rules.ts';

describe('linking registration rules', () => {
  it('[AC-B1-06c] every contract scene maps to a convert pid_scene, never fallback or query', () => {
    for (const value of scene) {
      const derived = pidSceneOf(parseScene(value));
      expect(pid_scene).toContain(derived);
      expect(['fallback', 'query']).not.toContain(derived);
    }
  });

  it('[AC-B1-06c] scenes outside the enum fail with 20001', () => {
    for (const value of ['', 'fallback', 'query', 'SEARCH', undefined, null, 1]) {
      expect(() => parseScene(value)).toThrow(LinkingError);
      expect(() => parseScene(value)).toThrow(expect.objectContaining({ code: 20001 }));
    }
  });

  it('[AC-B1-06c] share URLs live 7 days, the others 15 minutes', () => {
    expect(urlLifetimeMs('share')).toBe(604_800_000);
    expect(urlLifetimeMs('self_buy')).toBe(900_000);
    expect(urlLifetimeMs('agent')).toBe(900_000);
    expect(urlLifetimeMs('taolijin')).toBe(900_000);
  });

  it('[AC-B1-06c] only Agent and watch-alert cards log a registration', () => {
    expect(logsRegistration('agent', 'agent')).toBe(true);
    expect(logsRegistration('mcp', 'agent')).toBe(true);
    expect(logsRegistration('watch_alert', 'self_buy')).toBe(true);
    expect(logsRegistration('search', 'self_buy')).toBe(false);
    expect(logsRegistration('share', 'share')).toBe(false);
  });

  it('[AC-B1-06c] a switch is on only for true or "on"', () => {
    expect(isSwitchOn(true)).toBe(true);
    expect(isSwitchOn('on')).toBe(true);
    for (const value of [false, 'off', null, undefined, 'true', 1, 'ON']) {
      expect(isSwitchOn(value)).toBe(false);
    }
  });
});
