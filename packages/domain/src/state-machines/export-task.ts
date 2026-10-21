// B1-34g 测试阶段骨架；实现阶段由 export-task.yaml 生成并改接包入口。
export type ExportTaskState = 'pending' | 'running' | 'done' | 'failed' | 'expired' | 'cancelled';
export type ExportTaskEvent = 'START' | 'COMPLETE' | 'FAIL' | 'EXPIRE' | 'CANCEL' | 'RETRY';

export function transitionExportTask(from: ExportTaskState | null, event: ExportTaskEvent): never {
  void from;
  void event;
  throw new Error('NotImplemented: transitionExportTask');
}
