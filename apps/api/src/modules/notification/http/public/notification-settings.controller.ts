import type { Schema } from '@couli/contracts-ts';
import type { TokenPrincipal } from '../../../platform/index.ts';
import type { NotificationSettingsService } from '../../application/notification-settings.ts';

export interface NotificationSettingsHttpRequest {
  readonly id: string;
  readonly principal?: TokenPrincipal;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

export class NotificationSettingsController {
  constructor(settings: NotificationSettingsService) {
    void settings;
    throw new Error('NotImplemented: NotificationSettingsController');
  }

  async get(
    request: NotificationSettingsHttpRequest,
  ): Promise<Schema<'NotificationSettingsResponse'>> {
    void request;
    throw new Error('NotImplemented: NotificationSettingsController.get');
  }

  async update(
    request: NotificationSettingsHttpRequest,
    body: Schema<'NotificationSettings'>,
  ): Promise<Schema<'NotificationSettingsResponse'>> {
    void request;
    void body;
    throw new Error('NotImplemented: NotificationSettingsController.update');
  }
}
