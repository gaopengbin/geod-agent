//! Uses the shipping updater SDK with its test runtime; no app window or install.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::{self, Write}, time::{Duration, Instant}};
use tauri_plugin_updater::{Error, UpdaterExt};

fn error_code(error: &Error) -> &'static str {
    match error {
        Error::Minisign(_) => "MINISIGN",
        Error::MissingSignedVersion => "MISSING_SIGNED_VERSION",
        Error::SignedVersionMismatch { .. } => "SIGNED_VERSION_MISMATCH",
        Error::Reqwest(_) => "HTTP_OR_TLS",
        _ => "OTHER",
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let file = std::env::args().nth(1).ok_or("Pass public acceptance configuration")?;
    let state: Value = serde_json::from_slice(&fs::read(&file)?)?;
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = "dev.geod-agent.update-sdk-acceptance".into();
    context.package_info_mut().name = "GeoD updater SDK acceptance".into();
    context.package_info_mut().version = state["currentVersion"].as_str().ok_or("version")?.parse()?;
    // Match lib.rs: require a signed version and refuse insecure transport/TLS.
    context.config_mut().plugins.0.insert("updater".into(), json!({
        "pubkey":"", "requireSignedVersion":true,
        "dangerousInsecureTransportProtocol":false,
        "dangerousAcceptInvalidCerts":false, "dangerousAcceptInvalidHostnames":false,
        "allowDowngrades":false
    }));
    let app = tauri::test::mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(context)?;
    let certificate = reqwest::Certificate::from_pem(&fs::read(state["rootCertificate"].as_str().ok_or("certificate")?)?)?;
    let started = Instant::now();
    let mut cases = Vec::new();
    for mode in ["valid", "tampered", "wrong-key", "wrong-version", "missing-version", "same-version", "older-version", "truncated", "untrusted-tls"] {
        println!("{}", json!({"stage":"started","case":mode,"completedCases":cases.len(),"installed":false}));
        io::stdout().flush()?;
        let progress = std::path::Path::new(state["resultPath"].as_str().ok_or("result path")?)
            .with_file_name("sdk-progress.json");
        fs::write(&progress, serde_json::to_vec_pretty(&json!({
            "passed":false,"runningCase":mode,"completedCases":cases,
            "installed":false,"elapsedMs":started.elapsed().as_millis()
        }))?)?;
        let case_started = Instant::now();
        let endpoint = format!("{}/manifest/{mode}", state["origin"].as_str().ok_or("origin")?);
        let key = if mode == "wrong-key" { &state["otherPublicKey"] } else { &state["publicKey"] };
        let mut builder = app.handle().updater_builder().endpoints(vec![endpoint.parse()?])?
            .pubkey(key.as_str().ok_or("public key")?).no_proxy().timeout(Duration::from_secs(45));
        if mode != "untrusted-tls" {
            let certificate = certificate.clone();
            builder = builder.configure_client(move |client| client.add_root_certificate(certificate.clone()));
        }
        let checked = builder.build()?.check().await;
        if mode == "untrusted-tls" {
            let error = checked.err().ok_or("An untrusted certificate must fail")?;
            assert_eq!(error_code(&error), "HTTP_OR_TLS");
            cases.push(json!({"name":mode,"passed":true,"sdkError":error_code(&error),"downloaded":false}));
            continue;
        }
        let update = checked?;
        if mode == "same-version" || mode == "older-version" {
            assert!(update.is_none(), "The default SDK comparator must reject an equal/older version");
            cases.push(json!({"name":mode,"passed":true,"updateAvailable":false,"downloaded":false}));
            continue;
        }
        let update = update.ok_or("A newer version must be available")?;
        let mut downloaded = 0_u64;
        let mut chunks = 0_u64;
        let mut finish_called = false;
        let result = update.download(|count, total| {
            chunks += 1;
            downloaded += count as u64;
            if let Some(total) = total { assert_eq!(total, state["bytes"].as_u64().unwrap()); }
        }, || finish_called = true).await;
        if mode == "valid" {
            let bytes = result?;
            assert_eq!(bytes.len() as u64, state["bytes"].as_u64().unwrap());
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), state["sha256"].as_str().unwrap());
            assert_eq!(update.version, state["signedVersion"].as_str().unwrap());
            assert!(chunks > 1 && finish_called);
            cases.push(json!({"name":mode,"passed":true,"downloadedBytes":downloaded,"chunks":chunks,"signatureVerified":true,"version":update.version,"elapsedMs":case_started.elapsed().as_millis()}));
        } else {
            let error = result.err().ok_or("The invalid update must be rejected")?;
            let expected = match mode {
                "wrong-version" => "SIGNED_VERSION_MISMATCH",
                "missing-version" => "MISSING_SIGNED_VERSION",
                "truncated" => "HTTP_OR_TLS",
                _ => "MINISIGN",
            };
            assert_eq!(error_code(&error), expected, "Actual SDK error: {error}");
            cases.push(json!({"name":mode,"passed":true,"sdkError":error_code(&error),"downloadedBytes":downloaded,"elapsedMs":case_started.elapsed().as_millis()}));
        }
    }
    let receipt = json!({"passed":true,"sdk":"tauri-plugin-updater","sdkVersion":"2.13.1", "runtime":"Tauri MockRuntime",
        "transport":"actual loopback HTTPS with an explicitly trusted fixture CA", "requireSignedVersion":true,
        "allowDowngrades":false, "dangerousAcceptInvalidCerts":false, "actualInstallerBytes":state["bytes"],
        "installerSha256":state["sha256"], "cases":cases, "elapsedMs":started.elapsed().as_millis(),
        "applicationWindowOpened":false,"installed":false,"userProfileModified":false});
    fs::write(state["resultPath"].as_str().ok_or("result path")?, serde_json::to_vec_pretty(&receipt)?)?;
    println!("{}", json!({"passed":true,"cases":cases.len(),"actualInstallerBytes":state["bytes"],"installed":false}));
    Ok(())
}
