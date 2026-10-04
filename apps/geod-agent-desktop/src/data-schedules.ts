import { invoke } from "@tauri-apps/api/core";

export interface DataSchedule {
  id: string; conversationId: string; templateTaskId: string; name: string;
  enabled: boolean; nextRunAt: string; repeatSeconds: number | null; appMustBeRunning: boolean;
}
export interface DataScheduleRun {
  id: string; scheduleId: string; conversationId: string; scheduledAt: string;
  state: string; taskId: string | null; error: string | null; updatedAt: string;
}
export const dataSchedules = {
  create: (conversationId: string, taskId: string, name: string, nextRunAt: string, repeatSeconds: number | null, executionId: string = crypto.randomUUID()) =>
    invoke<DataSchedule>("data_schedules_create", { conversationId, taskId, name, nextRunAt, repeatSeconds, executionId }),
  list: (conversationId: string) => invoke<DataSchedule[]>("data_schedules_list", { conversationId }),
  runs: (conversationId: string) => invoke<DataScheduleRun[]>("data_schedules_runs", { conversationId }),
  setEnabled: (scheduleId: string, enabled: boolean, nextRunAt?: string) => invoke<DataSchedule>("data_schedules_set_enabled", { scheduleId, enabled, nextRunAt }),
  cancelRun: (runId: string) => invoke<DataScheduleRun>("data_schedules_cancel_run", { runId }),
};
