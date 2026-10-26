/** Wait locally for an actual native approval/start receipt. No model polling. */
export class ApprovalWaitStopped extends Error {
  readonly code = 'USER_STOPPED';
  constructor(){super('已停止等待确认；已提交的本机任务请以任务状态为准。');this.name='ApprovalWaitStopped';}
}
export async function waitForPlanApproval(check:()=>Promise<boolean>,cancelled:()=>boolean,delay=500){
  while(true){if(cancelled())throw new ApprovalWaitStopped();if(await check())return;await new Promise(resolve=>setTimeout(resolve,delay));}
}
