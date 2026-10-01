import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { Schema } from '@couli/contracts-ts';
import { APP_ENTRY, CLOCK, type Clock, type EntryName } from '../../../platform/index.ts';

type HealthzResponse = Schema<'HealthzResponse'>;

/** The part of the Fastify request this controller reads: the id set by `genReqId`. */
interface RequestWithId {
  readonly id: string;
}

@Controller()
export class HealthController {
  private readonly clock: Clock;
  private readonly entry: EntryName;

  constructor(@Inject(CLOCK) clock: Clock, @Inject(APP_ENTRY) entry: EntryName) {
    this.clock = clock;
    this.entry = entry;
  }

  /** Contract operation `getHealthz`: liveness only, checks no dependency. */
  @Get('healthz')
  getHealthz(@Req() request: RequestWithId): HealthzResponse {
    return {
      code: 0,
      msg: '',
      data: { status: 'ok', entry: this.entry, now: this.clock.now().toISOString() },
      trace_id: request.id,
    };
  }
}
