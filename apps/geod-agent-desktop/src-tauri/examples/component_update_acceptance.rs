//! Exercise the shipping component-update code and official verifier without
//! opening a window, installing an executable, or touching the real user profile.
#[path = "../src/runtime_components.rs"]
mod runtime_components;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, time::Duration};
use tauri::ipc::Channel;
use tauri_plugin_updater::UpdaterExt;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path=PathBuf::from(std::env::args().nth(1).ok_or("public fixture config")?);
    let config:Value=serde_json::from_slice(&fs::read(path)?)?;
    let base=PathBuf::from(config["cache"].as_str().ok_or("cache")?);
    let resources=PathBuf::from(config["resources"].as_str().ok_or("resources")?);
    let mut context=tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier="dev.geod-agent.component-update-qa".into();
    context.package_info_mut().version="0.2.4".parse()?;
    context.config_mut().plugins.0.insert("updater".into(),json!({"pubkey":"","requireSignedVersion":true,"dangerousInsecureTransportProtocol":true}));
    let app=tauri::test::mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(context)?;
    let mut cases=vec![];
    for name in ["unchanged","retry-cached","changed-one","missing-one","tampered-index","wrong-version-index","tampered-archive","truncated-archive","legacy-full","future-schema-full"] {
        let endpoint=format!("{}/manifest/{name}",config["origin"].as_str().ok_or("origin")?);
        if name=="missing-one" {
            let folder=resources.join("python-runtime");fs::rename(&folder,resources.join("python-hidden"))?;
            let manifests:std::collections::BTreeMap<String,String>=serde_json::from_str(include_str!(concat!(env!("OUT_DIR"),"/runtime-components.json")))?;
            let target=runtime_components::component_path(&base,"python-runtime",&manifests["python-runtime"]);
            fs::rename(&target,target.with_extension("held"))?;
        }
        let update=app.handle().updater_builder().pubkey(config["pubkey"].as_str().ok_or("key")?).endpoints(vec![endpoint.parse()?])?.no_proxy().timeout(Duration::from_secs(30)).build()?.check().await?.ok_or("update missing")?;
        let events=Channel::new(|_|Ok(()));
        let result=runtime_components::prepare(update,&events,base.clone(),resources.clone(),|_|Ok(None)).await;
        if ["tampered-index","wrong-version-index","tampered-archive","truncated-archive"].contains(&name) {
            assert!(result.is_err(),"{name} must be rejected");cases.push(json!({"case":name,"passed":true,"rejected":true}));continue;
        }
        let (application,index,transferred,reused)=result.map_err(|v|format!("{name}: {v}"))?;
        let (bytes,mode)=if let Some(index)=index {
            let bytes=runtime_components::download_artifact(&application,&index.application,&events,transferred,|_|Ok(None)).await.map_err(|v|v.to_string())?;
            assert_eq!(reused,if matches!(name,"changed-one"|"missing-one"){5}else{6});
            for component in &index.runtimes {runtime_components::verify(&runtime_components::component_path(&base,&component.id,&component.manifest_sha256),&component.manifest_sha256).map_err(|v|v.to_string())?;}
            (bytes,"components")
        } else {assert!(matches!(name,"legacy-full"|"future-schema-full"));(application.download(|_,_|{},||{}).await?,"full")};
        cases.push(json!({"case":name,"passed":true,"mode":mode,"reusedRuntimes":reused,"downloadedBytes":transferred+bytes.len() as u64}));
    }
    // A thin distribution can resolve every required real runtime after all
    // application-directory runtime folders have been removed.
    runtime_components::initialize_directory(base.clone());
    let empty=resources.join("empty-application");fs::create_dir_all(&empty)?;
    for id in runtime_components::IDS {
        let catalog:std::collections::BTreeMap<String,String>=serde_json::from_str(include_str!(concat!(env!("OUT_DIR"),"/runtime-components.json")))?;
        runtime_components::verify(&runtime_components::component_path(&base,id,&catalog[*id]),&catalog[*id]).map_err(|v|v.to_string())?;
        assert!(runtime_components::resolve(&empty,id).is_some(),"thin app must find {id}");
    }
    let mut engines=vec![];
    for (id,file,args,expected) in [("codex-runtime","node.exe",vec!["--version"],"v24.21.0"),
        ("codex-runtime","codex.exe",vec!["--version"],"0.159.2"),
        ("python-runtime","python.exe",vec!["--version"],"Python 3.13")] {
        let root=runtime_components::resolve(&empty,id).ok_or("cached runtime")?;
        let mut command=std::process::Command::new(root.join(file));command.args(args);
        #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x0800_0000);}
        let output=command.output()?;assert!(output.status.success());
        let version=String::from_utf8_lossy(&output.stdout).trim().to_owned();assert!(version.contains(expected),"{file}: {version}");
        engines.push(json!({"executable":file,"version":version,"loadedFromCachedRuntime":true}));
    }
    let report=json!({"passed":true,"cases":cases,"engines":engines,"shippingCode":true,"officialUpdaterSignatureVerification":true,"installed":false,"realUserProfileModified":false});
    fs::write(config["result"].as_str().ok_or("result")?,serde_json::to_vec_pretty(&report)?)?;
    println!("{report}");Ok(())
}
