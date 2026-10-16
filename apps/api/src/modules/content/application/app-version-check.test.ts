import { expect, it, vi } from 'vitest';
import type { AppVersionRow } from '../domain/app-version.ts';
import { AppVersionCheckService } from './app-version-check.ts';

it('[AC-F1-02e#2] missing configuration warns with the lookup dimensions and rejects', async () => {
  const appVersion = vi.fn().mockResolvedValue(null);
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = new AppVersionCheckService({ appVersion }, logger);

  await expect(service.read('app', 'h5', null)).rejects.toThrow('configuration missing');
  expect(appVersion).toHaveBeenCalledWith('app', 'h5', null);
  expect(logger.warn).toHaveBeenCalledWith(
    { event: 'content_app_version_missing', app_id: 'app', platform: 'h5', channel: null },
    'app version configuration missing',
  );
  expect(logger.error).not.toHaveBeenCalled();
});

it('[AC-F1-02e#5] malformed rows log the column name without leaking its value', async () => {
  const row: AppVersionRow = {
    latest_version: '1.0.0',
    min_supported_version: null,
    recommended_version: null,
    update_title: '',
    update_notes: '',
    store_url: 'private malformed address',
    default_store: 'default',
    store_listings: [],
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = new AppVersionCheckService({ appVersion: () => Promise.resolve(row) }, logger);

  await expect(service.read('app', 'android', 'official')).rejects.toThrow(
    'malformed app_versions column store_url',
  );
  expect(logger.error).toHaveBeenCalledExactlyOnceWith(
    { event: 'content_app_version_invalid', column: 'store_url' },
    'app version configuration malformed',
  );
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain(row.store_url);
  expect(logger.warn).not.toHaveBeenCalled();
});

it('[AC-F1-02e#7] a failed read rejects without being mistaken for a missing row', async () => {
  const failure = new Error('database unavailable');
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = new AppVersionCheckService({ appVersion: () => Promise.reject(failure) }, logger);

  await expect(service.read('app', 'android', 'official')).rejects.toBe(failure);
  expect(logger.warn).not.toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();
});
