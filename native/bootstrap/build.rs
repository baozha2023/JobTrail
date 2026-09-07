use std::{env, fs, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-env-changed=JOBTRAIL_VERSION");
    let version = env::var("JOBTRAIL_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").into());
    println!("cargo:rustc-env=JOBTRAIL_VERSION={version}");
    let icon =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../resource/icon.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    if env::var_os("CARGO_CFG_WINDOWS").is_some() {
        let mut res = winres::WindowsResource::new();
        res.set_icon(icon.to_str().unwrap());
        let parts: Vec<u16> = version
            .split('.')
            .map(|part| part.parse().expect("numeric release version"))
            .collect();
        assert_eq!(parts.len(), 3, "expected major.minor.patch");
        let numeric =
            (u64::from(parts[0]) << 48) | (u64::from(parts[1]) << 32) | (u64::from(parts[2]) << 16);
        res.set_version_info(winres::VersionInfo::FILEVERSION, numeric)
            .set_version_info(winres::VersionInfo::PRODUCTVERSION, numeric);
        res.set("FileVersion", &version);
        res.set("ProductName", "职迹")
            .set("FileDescription", "职迹安装与启动程序")
            .set("ProductVersion", &version);
        res.set_manifest(r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo><application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings><dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware></windowsSettings></application></assembly>"#);
        res.compile().expect("compile application icon");
    }
    for (key, name) in [
        ("JOBTRAIL_SETUP", "setup.exe"),
        ("JOBTRAIL_LAUNCHER", "launcher.exe"),
        ("JOBTRAIL_UNINSTALLER", "uninstaller.exe"),
    ] {
        println!("cargo:rerun-if-env-changed={key}");
        let dest = PathBuf::from(env::var("OUT_DIR").unwrap()).join(name);
        if let Some(source) = env::var_os(key) {
            println!(
                "cargo:rerun-if-changed={}",
                PathBuf::from(&source).display()
            );
            fs::copy(source, dest).expect("embed installer payload");
        } else {
            fs::write(dest, []).unwrap();
        }
    }
}
