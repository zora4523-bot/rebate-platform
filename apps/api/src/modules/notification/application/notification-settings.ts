import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface NotificationSettingsOwner {
  readonly app_id: string;
  readonly user_id: string;
}

export interface NotificationSettingsService {
  get(owner: NotificationSettingsOwner): Promise<Schema<'NotificationSettings'>>;
  update(
    owner: NotificationSettingsOwner,
    settings: Schema<'NotificationSettings'>,
  ): Promise<Schema<'NotificationSettings'>>;
}

export interface NotificationSettingsOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

export function createNotificationSettings(
  options: NotificationSettingsOptions,
): NotificationSettingsService {
  void options;
  throw new Error('NotImplemented: createNotificationSettings');
}
