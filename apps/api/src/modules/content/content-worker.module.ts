import type { DynamicModule } from '@nestjs/common';

/** F1-09p: 仅由 worker 入口装配定时发布任务处理器。 */
export class ContentWorkerModule {
  static forWorker(): DynamicModule {
    throw new Error('NotImplemented: ContentWorkerModule.forWorker');
  }
}
