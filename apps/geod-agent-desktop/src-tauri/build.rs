fn main() {
    // Pin the same component identities in full installers and small app updates.
    // The signed executable, not an editable runtime marker, defines compatibility.
    use sha2::{Digest, Sha256};
    let mut components = serde_json::Map::new();
    for (source, name) in [("codex", "codex-runtime"), ("pgedge", "pgedge-runtime"),
        ("documents", "document-runtime"), ("dbhub", "dbhub-runtime"),
        ("audio", "audio-runtime"), ("python", "python-runtime")] {
        let path = format!("resources/{source}/manifest.json");
        println!("cargo:rerun-if-changed={path}");
        let manifest = std::fs::read(path).expect("Prepare release runtimes before building");
        components.insert(name.into(), serde_json::json!(format!("{:x}", Sha256::digest(manifest))));
    }
    std::fs::write(std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("runtime-components.json"),
        serde_json::to_vec(&components).unwrap()).unwrap();
    // Rebuild Windows resources when branding changes, including development builds.
    for icon in ["32x32.png", "128x128.png", "128x128@2x.png", "icon.ico"] {
        println!("cargo:rerun-if-changed=icons/{icon}");
    }
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Tauri embeds this for the app, but Rust's unit-test executable also links rfd.
        // TaskDialogIndirect requires Common Controls 6 rather than the default 5.82.
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
        // The app already has Tauri's manifest in resource.lib. Keep that
        // embedded resource rather than generate a second manifest with ID 1.
        println!("cargo:rustc-link-arg-bin=geod-agent-desktop=/MANIFEST:NO");
    }
}
