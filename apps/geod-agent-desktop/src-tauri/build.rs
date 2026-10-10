fn main() {
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
