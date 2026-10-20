use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs,
    os::windows::{fs::MetadataExt, process::CommandExt},
    path::{Component, Path, PathBuf, Prefix},
    process::Command,
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

pub mod localization;
mod registration;
pub mod shortcuts;
use localization::{text, Message};
pub use registration::{refresh_registration, register};

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
        bail!("{}", text(Message::PathMustBeAbsolute));
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
            _ => bail!("{}", text(Message::InvalidPath)),
        }
    }
    for ancestor in root.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_attributes() & 0x400 != 0 => {
                bail!("{}", text(Message::LinkedPath))
            }
            Ok(meta) if !meta.is_dir() => bail!("{}", text(Message::PathNotDirectory)),
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
                bail!("{}", text(Message::SystemDirectory));
            }
        }
    }
    Ok(())
}

pub fn plain_file(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)
        .with_context(|| format!("{}: {}", text(Message::ReadFile), path.display()))?;
    if !meta.is_file() || meta.file_attributes() & 0x400 != 0 {
        bail!("{}: {}", text(Message::NotPlainFile), path.display());
    }
    Ok(())
}

pub fn validate_installation(root: &Path) -> Result<()> {
    validate_path(root)?;
    plain_file(&root.join(MARKER))?;
    if fs::read(root.join(MARKER))? != b"jobtrail-root-v1\n" {
        bail!("{}", text(Message::InvalidMarker));
    }
    Ok(())
}

pub fn validate_tree(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_attributes() & 0x400 != 0 {
        bail!("{}: {}", text(Message::TreeContainsLink), path.display());
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
        .context(text(Message::MissingVersion))?;
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
        Ok(_) => bail!("{}", text(Message::AlreadyInstalled)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
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
                bail!("{}", text(Message::ShortcutCleanupFailed));
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
        if registration::owns_registration(root, &location) {
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
            bail!("{}", text(Message::AppStillRunning));
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
        bail!("{}", text(Message::InvalidTempDirectory));
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
    use winapi::um::winuser::{MessageBoxW, MB_ICONERROR, MB_OK};
    let title = text(Message::AppName)
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let description = format!("{error:#}")
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    // Keep the established error presentation usable for hidden/background launcher starts.
    // SAFETY: both owned UTF-16 buffers are null-terminated and outlive the synchronous dialog.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            description.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
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
