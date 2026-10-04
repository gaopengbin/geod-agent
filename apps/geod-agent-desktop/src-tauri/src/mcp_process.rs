//! stdio MCP transport owns and reaps its process, including failed handshakes.
use rmcp::{RoleClient, service::{RxJsonRpcMessage,TxJsonRpcMessage}, transport::{Transport,async_rw::AsyncRwTransport}};
use std::{future::Future, path::{Path,PathBuf}, process::Stdio, time::Duration};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

fn runtime_error(message: &str) -> crate::AppError {
    crate::AppError{code:"MCP_RUNTIME_MISSING",message:message.into()}
}

/// Only these Windows shims map to a fixed Node CLI; arbitrary scripts stay
/// rejected by credential validation. User arguments never become shell text.
pub(crate) fn package_manager_shim(executable: &str) -> bool {
    cfg!(windows) && Path::new(executable).file_name().and_then(|name|name.to_str())
        .is_some_and(|name|matches!(name.to_ascii_lowercase().as_str(),"npm.cmd"|"npx.cmd"))
}

fn node_cli(root: &Path, manager: &str, bundled: bool) -> Result<(PathBuf,PathBuf),crate::AppError> {
    let node=root.join("node.exe");
    let cli=if bundled {root.join("npm/bin")} else {root.join("node_modules/npm/bin")}.join(format!("{manager}-cli.js"));
    if !node.is_file() || !cli.is_file() {
        return Err(runtime_error("MCP 所需的 Node/npm 运行环境不完整，请修复应用或选择完整的本机 Node 安装"));
    }
    Ok((node,cli))
}

pub(crate) fn prepare_command(executable: &str, args: &[String], bundled: Option<&Path>, directory: &Path) -> Result<(Command,Option<PathBuf>),crate::AppError> {
    let selected=Path::new(executable);
    let bare=selected.components().count()==1;
    let name=selected.file_name().and_then(|name|name.to_str()).unwrap_or("").to_ascii_lowercase();
    if bare && matches!(name.as_str(),"node"|"node.exe") {
        if let Some(root)=bundled {
            let node=root.join("node.exe");
            if !node.is_file(){return Err(runtime_error("MCP 所需的配套 Node 运行环境缺失，请修复应用"));}
            let mut command=Command::new(node);command.args(args);
            return Ok((command,Some(root.to_path_buf())));
        }
    }
    if cfg!(windows) && ((bare && matches!(name.as_str(),"npm"|"npx"|"npm.cmd"|"npx.cmd")) || package_manager_shim(executable)) {
        let manager=if name.starts_with("npx") {"npx"} else {"npm"};
        let (node,cli)=if bare {
            if let Some(root)=bundled {node_cli(root,manager,true)?}
            else {
                let found=std::env::var_os("PATH").into_iter().flat_map(|value|std::env::split_paths(&value).collect::<Vec<_>>())
                    .find_map(|root|node_cli(&root,manager,false).ok());
                found.ok_or_else(||runtime_error("未找到 MCP 所需的 Node/npm，请修复应用或选择完整的本机 Node 安装"))?
            }
        }else{
            // Respect an explicitly selected installation rather than silently
            // substituting another Node version or executing its .cmd file.
            let path=if selected.is_absolute(){selected.to_path_buf()}else{directory.join(selected)};
            if !path.is_file(){return Err(runtime_error("所选 npm/npx 启动文件不存在，请检查本机 Node 安装"));}
            node_cli(path.parent().ok_or_else(||runtime_error("所选 Node 安装路径无效"))?,manager,false)?
        };
        let root=node.parent().map(Path::to_path_buf);
        let mut command=Command::new(node);command.arg(cli).args(args);
        return Ok((command,root));
    }
    let mut command=Command::new(executable);command.args(args);
    Ok((command,None))
}

/// npm's generated bin shims must find the same selected Node as the parent.
/// Preserve the configured PATH after that one application runtime directory.
pub(crate) fn extend_runtime_path(command: &mut Command, node_directory: Option<&Path>) -> Result<(),crate::AppError> {
    let Some(root)=node_directory else{return Ok(());};
    let configured=command.as_std().get_envs().find(|(name,_)|name.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .and_then(|(_,value)|value.map(std::ffi::OsStr::to_os_string)).unwrap_or_default();
    let mut paths=vec![root.to_path_buf()];paths.extend(std::env::split_paths(&configured).filter(|path|path!=root));
    let value=std::env::join_paths(paths).map_err(|_|crate::AppError{code:"MCP_RUNTIME_PATH_INVALID",message:"MCP 的 PATH 配置无效，请检查本机启动环境".into()})?;
    command.env("PATH",value);Ok(())
}

pub(crate) struct ProcessTransport {
    child: Option<Child>,
    io: AsyncRwTransport<RoleClient, ChildStdout, ChildStdin>,
    #[cfg(windows)]
    _tree: crate::codex_runtime::ProcessTree,
}
impl ProcessTransport {
    pub(crate) fn spawn(command: &mut Command) -> std::io::Result<Self> {
        let mut child=command.kill_on_drop(true).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
        #[cfg(windows)] let tree=crate::codex_runtime::ProcessTree::attach_handle(child.raw_handle().ok_or_else(||std::io::Error::other("missing process handle"))?)
            .map_err(|_|std::io::Error::other("MCP process group could not be managed"))?;
        let stdout=child.stdout.take().ok_or_else(||std::io::Error::other("missing MCP stdout"))?;
        let stdin=child.stdin.take().ok_or_else(||std::io::Error::other("missing MCP stdin"))?;
        Ok(Self{child:Some(child),io:AsyncRwTransport::new(stdout,stdin),#[cfg(windows)] _tree:tree})
    }
}
impl Drop for ProcessTransport {
    fn drop(&mut self) {
        if let Some(mut child)=self.child.take() {
            let _=child.start_kill();
            if let Ok(runtime)=tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {let _=child.wait().await;});
            }
        }
    }
}
impl Transport<RoleClient> for ProcessTransport {
    type Error=std::io::Error;
    fn send(&mut self,message:TxJsonRpcMessage<RoleClient>)->impl Future<Output=Result<(),Self::Error>>+Send+'static {self.io.send(message)}
    fn receive(&mut self)->impl Future<Output=Option<RxJsonRpcMessage<RoleClient>>>+Send {self.io.receive()}
    fn close(&mut self)->impl Future<Output=Result<(),Self::Error>>+Send {
        async move {
            let closed=self.io.close().await;
            if let Some(mut child)=self.child.take() {
                if tokio::time::timeout(Duration::from_secs(2),child.wait()).await.is_err() {
                    let _=child.kill().await;
                    let _=child.wait().await;
                }
            }
            closed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bare_node_uses_application_runtime_and_literal_arguments() {
        let temporary=tempfile::tempdir().unwrap();let root=temporary.path().join("runtime with spaces");std::fs::create_dir_all(&root).unwrap();std::fs::write(root.join("node.exe"),[]).unwrap();
        let args=vec!["a file.js".into(),"$(literal); & echo".into()];
        let (mut command,prefix)=prepare_command("node",&args,Some(&root),temporary.path()).ok().unwrap();
        assert_eq!(command.as_std().get_program(),root.join("node.exe"));assert_eq!(command.as_std().get_args().collect::<Vec<_>>(),args.iter().map(std::ffi::OsStr::new).collect::<Vec<_>>());
        command.env_clear().env("PATH",temporary.path());extend_runtime_path(&mut command,prefix.as_deref()).ok().unwrap();
        let value=command.as_std().get_envs().find(|(name,_)|*name=="PATH").unwrap().1.unwrap();assert_eq!(std::env::split_paths(value).collect::<Vec<_>>(),[root,temporary.path().to_path_buf()]);
        assert_eq!(prepare_command("node",&[],Some(&temporary.path().join("absent")),temporary.path()).err().unwrap().code,"MCP_RUNTIME_MISSING");
    }
    #[cfg(windows)]
    #[test]
    fn package_shims_use_fixed_cli_and_respect_explicit_installation() {
        let temporary=tempfile::tempdir().unwrap();let bundled=temporary.path().join("application runtime");let external=temporary.path().join("explicit runtime");
        for (root,subdir) in [(&bundled,"npm/bin"),(&external,"node_modules/npm/bin")] {
            std::fs::create_dir_all(root.join(subdir)).unwrap();std::fs::write(root.join("node.exe"),[]).unwrap();std::fs::write(root.join(subdir).join("npx-cli.js"),[]).unwrap();
        }
        std::fs::write(external.join("npx.CMD"),b"must not execute this shim").unwrap();
        let arguments=vec!["--offline".into(),"package with spaces".into(),"a&b".into()];
        for name in ["npx","npx.cmd","NPX.CMD"] {
            let (command,_)=prepare_command(name,&arguments,Some(&bundled),temporary.path()).ok().unwrap();assert_eq!(command.as_std().get_program(),bundled.join("node.exe"));
            assert_eq!(command.as_std().get_args().next().unwrap(),bundled.join("npm/bin/npx-cli.js"));assert_eq!(command.as_std().get_args().skip(1).collect::<Vec<_>>(),arguments.iter().map(std::ffi::OsStr::new).collect::<Vec<_>>());
        }
        let (command,_)=prepare_command(external.join("npx.CMD").to_str().unwrap(),&arguments,Some(&bundled),temporary.path()).ok().unwrap();assert_eq!(command.as_std().get_program(),external.join("node.exe"));
        assert!(package_manager_shim("npx.CMD"));assert!(!package_manager_shim("server.cmd"));assert!(!package_manager_shim("npm.bat"));
        std::fs::remove_file(bundled.join("npm/bin/npx-cli.js")).unwrap();assert_eq!(prepare_command("npx",&[],Some(&bundled),temporary.path()).err().unwrap().code,"MCP_RUNTIME_MISSING");
    }
}
