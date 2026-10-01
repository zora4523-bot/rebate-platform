import { Module } from '@nestjs/common';
import { HealthController } from './http/public/health.controller.ts';

@Module({ controllers: [HealthController] })
export class HealthModule {}
