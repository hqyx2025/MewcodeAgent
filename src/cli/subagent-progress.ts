import type { SubagentProgress } from '../core/subagents.js';

export function printSubagentProgress(event: SubagentProgress, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(event)}\n`);
  else
    process.stderr.write(
      `子任务 ${event.taskId}：${event.state}；运行${event.active}，排队${event.queued}\n`,
    );
}
