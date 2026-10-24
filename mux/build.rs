use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=MSMUX_BUILD_VERSION");
    let version =
        env::var("MSMUX_BUILD_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
    fs::write(
        out.join("build_version.rs"),
        format!("pub const BUILD_VERSION: &str = {version:?};\n"),
    )
    .expect("write build version");
}
