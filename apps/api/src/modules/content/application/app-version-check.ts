import type { ClientPlatform } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import {
  buildAppVersionCheck,
  InvalidAppVersionError,
  type AppVersionCheck,
} from '../domain/app-version.ts';
import type { ContentReader } from './content-reader.ts';

export class AppVersionCheckService {
  readonly #reader: Pick<ContentReader, 'appVersion'>;
  readonly #logger: Pick<Logger, 'warn' | 'error'>;

  constructor(reader: Pick<ContentReader, 'appVersion'>, logger: Pick<Logger, 'warn' | 'error'>) {
    this.#reader = reader;
    this.#logger = logger;
  }

  async read(
    appId: string,
    platform: ClientPlatform,
    channel: string | null,
  ): Promise<AppVersionCheck> {
    const row = await this.#reader.appVersion(appId, platform, channel);
    if (row === null) {
      this.#logger.warn(
        { event: 'content_app_version_missing', app_id: appId, platform, channel },
        'app version configuration missing',
      );
      throw new Error('content: app version configuration missing');
    }
    try {
      return buildAppVersionCheck(row);
    } catch (error) {
      if (error instanceof InvalidAppVersionError) {
        this.#logger.error(
          { event: 'content_app_version_invalid', column: error.column },
          'app version configuration malformed',
        );
      }
      throw error;
    }
  }
}
