//! Keep synchronous native handlers off the window's IPC/UI thread. Network,
//! credential and filesystem waits must not block unrelated window commands.
use tauri::{ipc::Invoke,Wry};
fn blocking<F,T>(work:F)->tauri::async_runtime::JoinHandle<Result<T,()>>
where F:FnOnce()->T+Send+'static,T:Send+'static {
    tauri::async_runtime::spawn_blocking(move||std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).map_err(|_|()))
}
pub(crate) fn dispatch(invoke:Invoke<Wry>,handler:fn(Invoke<Wry>)->bool)->bool {
    let unknown=invoke.resolver.clone();let uncertain=invoke.resolver.clone();
    let task=blocking(move||{
        if !handler(invoke) {unknown.reject(serde_json::json!({"code":"COMMAND_NOT_FOUND","message":"当前版本未提供这个本机操作"}));}
    });
    tauri::async_runtime::spawn(async move {
        if !matches!(task.await,Ok(Ok(()))) {
            uncertain.reject(serde_json::json!({"code":"LOCAL_COMMAND_UNCERTAIN","message":"本机操作的执行结果尚未确认，请核对原任务状态；未自动重试。"}));
        }
    });
    true
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]async fn blocked_native_work_does_not_hold_unrelated_commands(){
        let (release,wait)=std::sync::mpsc::channel();let slow=blocking(move||wait.recv().unwrap());
        let fast=blocking(||42);let result=tokio::time::timeout(std::time::Duration::from_secs(1),fast).await;
        release.send(()).unwrap();slow.await.unwrap().unwrap();assert_eq!(result.unwrap().unwrap().unwrap(),42);
    }
    #[tokio::test]async fn a_panicking_handler_has_an_uncertain_outcome_and_does_not_poison_dispatch(){
        assert!(blocking(||panic!("controlled native failure")).await.unwrap().is_err());
        assert_eq!(blocking(||7).await.unwrap().unwrap(),7);
    }
}
