/** Wait locally for an actual native approval/start receipt. No model polling. */
export async function waitForPlanApproval(check:()=>Promise<boolean>,cancelled:()=>boolean,delay=500){
  while(true){if(cancelled())throw new Error("执行已停止");if(await check())return;await new Promise(resolve=>setTimeout(resolve,delay));}
}
