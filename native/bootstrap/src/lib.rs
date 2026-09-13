use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs,
    os::windows::{fs::MetadataExt, process::CommandExt},
    path::{Component, Path, PathBuf, Prefix},
    process::Command,
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

pub const LAUNCHER: &str = "JobTrail.exe";
pub const UNINSTALLER: &str = "JobTrail-Uninstall.exe";
pub const MARKER: &str = ".jobtrail-root";
pub const ID: &str = "zhiji";
pub const NO_WINDOW: u32 = 0x08000000;
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\zhiji";

pub fn validate_path(root: &Path) -> Result<()> {
    if !root.is_absolute()
        || !root
            .file_name()
            .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("JobTrail"))
    {
        bail!("安装目录必须是绝对路径，并以 JobTrail 目录结尾");
    }
    for component in root.components() {
        match component {
            Component::Prefix(prefix)
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) => {}
            Component::RootDir => {}
            Component::Normal(name)
                if !name
                    .to_string_lossy()
                    .contains([':', '*', '?', '"', '<', '>', '|'])
                    && !name.to_string_lossy().ends_with(['.', ' ']) => {}
            _ => bail!("不支持网络路径、相对路径或特殊文件名"),
        }
    }
    for ancestor in root.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_attributes() & 0x400 != 0 => {
                bail!("安装路径不能经过符号链接或目录联接")
            }
            Ok(meta) if !meta.is_dir() => bail!("安装路径不是目录"),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    for name in ["WINDIR", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(value) = std::env::var_os(name) {
            let forbidden = value.to_string_lossy().to_lowercase();
            let candidate = root.to_string_lossy().to_lowercase();
            if candidate == forbidden || candidate.starts_with(&(forbidden + "\\")) {
                bail!("请选择当前用户可写的非系统目录");
            }
        }
    }
    Ok(())
}

pub fn plain_file(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).with_context(|| format!("读取 {}", path.display()))?;
    if !meta.is_file() || meta.file_attributes() & 0x400 != 0 {
        bail!("不是普通文件: {}", path.display());
    }
    Ok(())
}

pub fn validate_installation(root: &Path) -> Result<()> {
    validate_path(root)?;
    plain_file(&root.join(MARKER))?;
    if fs::read(root.join(MARKER))? != b"jobtrail-root-v1\n" {
        bail!("安装目录标记无效");
    }
    Ok(())
}

pub fn validate_tree(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_attributes() & 0x400 != 0 {
        bail!("程序目录包含重解析点: {}", path.display());
    }
    if meta.is_dir() {
        for entry in fs::read_dir(path)? {
            validate_tree(&entry?.path())?;
        }
    }
    Ok(())
}

pub fn version(root: &Path) -> Result<String> {
    let path = root.join(".runtime/current/sq.version");
    plain_file(&path)?;
    let xml = fs::read_to_string(path)?;
    let doc = roxmltree::Document::parse(&xml)?;
    let value = doc
        .descendants()
        .find(|n| n.has_tag_name("version"))
        .and_then(|n| n.text())
        .context("程序版本信息缺失")?;
    semver::Version::parse(value)?;
    Ok(value.to_owned())
}

pub fn shortcuts() -> Vec<PathBuf> {
    [
        dirs::desktop_dir().map(|p| p.join("职迹.lnk")),
        dirs::data_dir().map(|p| p.join(r"Microsoft\Windows\Start Menu\Programs\职迹.lnk")),
    ]
    .into_iter()
    .flatten()
    .collect()
}

pub fn ensure_not_installed() -> Result<()> {
    match RegKey::predef(HKEY_CURRENT_USER).open_subkey(UNINSTALL_KEY) {
        Ok(_) => bail!("当前用户已安装职迹，请先备份所需数据并卸载旧程序"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn register(root: &Path, version: &str, create_shortcuts: bool) -> Result<()> {
    semver::Version::parse(version)?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(UNINSTALL_KEY)?;
    key.set_value("DisplayName", &"职迹")?;
    key.set_value("DisplayVersion", &version)?;
    key.set_value("Publisher", &"JobTrail")?;
    key.set_value("InstallLocation", &root.to_string_lossy().as_ref())?;
    key.set_value(
        "DisplayIcon",
        &format!("{},0", root.join(LAUNCHER).display()),
    )?;
    key.set_value(
        "UninstallString",
        &format!("\"{}\"", root.join(UNINSTALLER).display()),
    )?;
    key.set_value("NoModify", &1u32)?;
    key.set_value("NoRepair", &1u32)?;
    let _ = key.delete_value("QuietUninstallString");
    if create_shortcuts {
        for file in shortcuts() {
            fs::create_dir_all(file.parent().context("快捷方式父目录缺失")?)?;
            mslnk::ShellLink::new(root.join(LAUNCHER))?.create_lnk(file)?;
        }
    }
    Ok(())
}

pub fn unregister(root: &Path) -> Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // Resolve each shortcut through Windows Shell; never delete another target.
    let quote = |p: &Path| p.to_string_lossy().replace('\'', "''");
    for shortcut in shortcuts() {
        if shortcut.exists() {
            let script = format!("$ErrorActionPreference='Stop'; $s=New-Object -ComObject WScript.Shell; if ($s.CreateShortcut('{}').TargetPath -eq '{}') {{ Remove-Item -LiteralPath '{}' }}", quote(&shortcut), quote(&root.join(LAUNCHER)), quote(&shortcut));
            let encoded = STANDARD.encode(
                script
                    .encode_utf16()
                    .flat_map(u16::to_le_bytes)
                    .collect::<Vec<_>>(),
            );
            let status = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
                .creation_flags(NO_WINDOW)
                .status()?;
            if !status.success() {
                bail!("清理快捷方式失败");
            }
        }
    }
    if let Ok(key) = hkcu.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        winreg::enums::KEY_READ | winreg::enums::KEY_WRITE,
    ) {
        if let Ok(value) = key.get_value::<String, _>("JobTrail") {
            if value == format!("\"{}\"", root.join(LAUNCHER).display()) {
                key.delete_value("JobTrail")?;
            }
        }
    }
    // Keep the Add/Remove Programs retry entry until all other shell cleanup
    // has succeeded. A later uninstall attempt can recover a partial run.
    if let Ok(key) = hkcu.open_subkey(UNINSTALL_KEY) {
        let location: String = key.get_value("InstallLocation").unwrap_or_default();
        if Path::new(&location) == root || Path::new(&location) == root.join(".runtime") {
            hkcu.delete_subkey_all(UNINSTALL_KEY)?;
        }
    }
    Ok(())
}

pub fn wait_pid(pid: u32) -> Result<()> {
    use winapi::um::{
        handleapi::CloseHandle, processthreadsapi::OpenProcess, synchapi::WaitForSingleObject,
        winnt::SYNCHRONIZE,
    };
    if pid == 0 {
        return Ok(());
    }
    // SAFETY: OpenProcess receives a PID and minimal synchronize rights; the
    // returned handle is checked for null, waited on, then closed exactly once.
    unsafe {
        let handle = OpenProcess(SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(87) {
                return Ok(());
            }
            return Err(error.into());
        }
        let result = WaitForSingleObject(handle, 30_000);
        CloseHandle(handle);
        if result != 0 {
            bail!("应用尚未退出，请关闭职迹后重试");
        }
    }
    Ok(())
}

pub fn schedule_worker_cleanup(directory: &Path) -> Result<()> {
    let worker = directory.join("worker.exe");
    if directory.parent() != Some(std::env::temp_dir().as_path())
        || !directory
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("jobtrail-uninstall-"))
    {
        bail!("临时目录无效");
    }
    let escaped = |p: &Path| p.to_string_lossy().replace('\'', "''");
    let script = format!("Wait-Process -Id {} -ErrorAction SilentlyContinue; Remove-Item -LiteralPath '{}' -Force; Remove-Item -LiteralPath '{}'", std::process::id(), escaped(&worker), escaped(directory));
    let encoded = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .creation_flags(NO_WINDOW)
        .spawn()?;
    Ok(())
}

pub fn error_dialog(error: &anyhow::Error) {
    rfd::MessageDialog::new()
        .set_title("职迹")
        .set_level(rfd::MessageLevel::Error)
        .set_description(format!("{error:#}"))
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_roots() {
        for path in [
            r"C:\",
            r"JobTrail",
            r"\\server\share\JobTrail",
            r"C:\Temp\..\JobTrail",
            r"C:\Temp:stream\JobTrail",
        ] {
            assert!(validate_path(Path::new(path)).is_err(), "{path}");
        }
    }
    #[test]
    fn marker_is_required() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("JobTrail");
        fs::create_dir(&root).unwrap();
        assert!(validate_installation(&root).is_err());
        fs::write(root.join(MARKER), b"jobtrail-root-v1\n").unwrap();
        validate_installation(&root).unwrap();
    }
}
