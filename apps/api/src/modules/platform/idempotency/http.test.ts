import { Controller, Get } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { AppModule } from '../../../app.module.ts';
import { createHttpApp } from '../../../bootstrap.ts';
import { FixedClock, createRootLogger, loadConfig } from '../index.ts';
import { IdempotencyError } from './index.ts';

@Controller('__idempotency')
class ProbeController {
  @Get('uncertain')
  uncertain() {
    throw new IdempotencyError('outcome_unknown');
  }
}

it('[AC-B1-01i#3] uncertain commits close the HTTP response without an envelope', async () => {
  const original = AppModule.forEntry;
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => ({
    ...original(options),
    controllers: [ProbeController],
  }));
  const app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2031-01-01T00:00:00Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  try {
    await app.init();
    await expect(
      app.inject({ method: 'GET', url: '/__idempotency/uncertain' }),
    ).rejects.toMatchObject({
      code: 'LIGHT_ECONNRESET',
    });
    expect(app.getHttpServer().listening).toBe(false);
  } finally {
    await app.close();
    vi.restoreAllMocks();
  }
});
