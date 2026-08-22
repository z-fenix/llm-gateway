fn main() {
    #[cfg(windows)]
    embed_windows_manifest();

    // Keep Tauri's icon/version resource generation, but don't let it embed its own
    // app manifest: we embed one ourselves so that the library unit-test harness also
    // gets a Common Controls v6 manifest. Without this, `cargo test --lib` fails on
    // Windows with the GNU toolchain with:
    //   process didn't exit successfully (exit code: 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND)
    let attrs = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}

/// Embeds a Common Controls v6 Windows application manifest.
///
/// This is required on Windows because the test binary links against crates that pull
/// in the Common Controls v6 dependency, but Tauri's build script only embeds its
/// manifest for binary targets (via embed-resource's `rustc-link-arg-bins`). The
/// library unit-test harness therefore has no manifest and crashes at startup with
/// `STATUS_ENTRYPOINT_NOT_FOUND`.
///
/// The `.rsrc merge failure: multiple non-default manifests` linker warning that
/// appears for binary/integration-test targets is pre-existing: it occurs even with
/// the original `fn main() { tauri_build::build() }` build.rs.
#[cfg(windows)]
fn embed_windows_manifest() {
    const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

    let out_dir = std::env::var_os("OUT_DIR").expect("OUT_DIR");
    let out_dir = std::path::PathBuf::from(out_dir);
    let manifest_path = out_dir.join("app.manifest");
    std::fs::write(&manifest_path, MANIFEST).expect("failed to write Windows app manifest");

    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").expect("CARGO_CFG_TARGET_ENV");
    match target_env.as_str() {
        "gnu" => {
            let rc_path = out_dir.join("app.rc");
            let manifest_path_fwd = manifest_path.to_string_lossy().replace('\\', "/");
            std::fs::write(&rc_path, format!(r#"1 24 "{}""#, manifest_path_fwd))
                .expect("failed to write Windows resource script");
            let object_path = out_dir.join("app_manifest.o");
            let status = std::process::Command::new("windres")
                .arg(format!("--input={}", rc_path.display()))
                .arg(format!("--output={}", object_path.display()))
                .arg("--output-format=coff")
                .status()
                .expect("failed to run windres");
            assert!(status.success(), "windres failed to compile manifest");
            println!("cargo:rustc-link-arg={}", object_path.display());
        }
        "msvc" => {
            println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
            println!(
                "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
                manifest_path.display()
            );
        }
        _ => {}
    }
}
