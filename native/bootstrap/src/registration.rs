use crate::{shortcuts, LAUNCHER, UNINSTALLER, UNINSTALL_KEY};
use anyhow::{Context, Result};
use std::{fs, io::ErrorKind, path::Path};
use winreg::{
    enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE},
    RegKey,
};

pub fn register(root: &Path, version: &str) -> Result<()> {
    semver::Version::parse(version)?;
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(UNINSTALL_KEY)?;
    write_registration(&key, root, version)?;
    for file in shortcuts() {
        fs::create_dir_all(file.parent().context("快捷方式父目录缺失")?)?;
        mslnk::ShellLink::new(root.join(LAUNCHER))?.create_lnk(file)?;
    }
    Ok(())
}

pub fn refresh_registration(root: &Path, version: &str) -> Result<()> {
    refresh_registration_in(
        &RegKey::predef(HKEY_CURRENT_USER),
        UNINSTALL_KEY,
        root,
        version,
    )
}

fn refresh_registration_in(hive: &RegKey, name: &str, root: &Path, version: &str) -> Result<()> {
    semver::Version::parse(version)?;
    let key = match hive.open_subkey_with_flags(name, KEY_READ | KEY_WRITE) {
        Ok(key) => key,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let location: String = key.get_value("InstallLocation")?;
    // Only the installer may claim this user's installation. Copied launchers
    // and isolated acceptance roots must not create or take over that claim.
    if owns_registration(root, &location) {
        write_registration(&key, root, version)?;
    }
    Ok(())
}

pub(crate) fn owns_registration(root: &Path, location: &str) -> bool {
    let location = Path::new(location);
    // Velopack owns this fixed child directory and can register it while applying
    // an update. The root launcher restores the public uninstall entry afterward.
    location == root || location == root.join(".runtime")
}

fn write_registration(key: &RegKey, root: &Path, version: &str) -> Result<()> {
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
    match key.delete_value("QuietUninstallString") {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        name: String,
        hive: RegKey,
    }
    impl Fixture {
        fn new() -> Self {
            let name = format!(r"Software\JobTrailBootstrapTests\{}", uuid::Uuid::new_v4());
            let (hive, _) = RegKey::predef(HKEY_CURRENT_USER)
                .create_subkey(&name)
                .unwrap();
            Self { name, hive }
        }
        fn registration(&self) -> RegKey {
            self.hive.create_subkey("installation").unwrap().0
        }
        fn refresh(&self, root: &Path, version: &str) -> Result<()> {
            refresh_registration_in(&self.hive, "installation", root, version)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            RegKey::predef(HKEY_CURRENT_USER)
                .delete_subkey_all(&self.name)
                .unwrap();
        }
    }

    #[test]
    fn unregistered_launcher_does_not_create_installation_claim() {
        let f = Fixture::new();
        f.refresh(Path::new(r"C:\isolated-test\JobTrail"), "2.5.0")
            .unwrap();
        assert_eq!(
            f.hive.open_subkey("installation").unwrap_err().kind(),
            ErrorKind::NotFound
        );
    }

    #[test]
    fn foreign_launcher_preserves_all_existing_registration_values() {
        let f = Fixture::new();
        let key = f.registration();
        key.set_value("InstallLocation", &r"C:\installed\JobTrail")
            .unwrap();
        key.set_value("DisplayVersion", &"2.4.0").unwrap();
        key.set_value("QuietUninstallString", &"preserve this")
            .unwrap();
        key.set_value("CustomValue", &42u32).unwrap();
        let values = || {
            key.enum_values()
                .collect::<std::io::Result<Vec<_>>>()
                .unwrap()
        };
        let before = values();
        f.refresh(Path::new(r"C:\isolated-test\JobTrail"), "2.5.0")
            .unwrap();
        assert_eq!(values(), before);
    }

    #[test]
    fn owned_registration_refreshes_upgrade_and_rollback_versions() {
        let f = Fixture::new();
        let key = f.registration();
        let root = Path::new(r"C:\installed\JobTrail");
        key.set_value("InstallLocation", &root.to_string_lossy().as_ref())
            .unwrap();
        key.set_value("InstallDate", &"20260930").unwrap();
        key.set_value("QuietUninstallString", &"obsolete silent uninstall")
            .unwrap();
        for version in ["2.5.0", "2.4.0"] {
            f.refresh(root, version).unwrap();
            assert_eq!(
                key.get_value::<String, _>("DisplayVersion").unwrap(),
                version
            );
            assert_eq!(
                key.get_value::<String, _>("InstallDate").unwrap(),
                "20260930"
            );
            assert_eq!(
                key.get_value::<String, _>("UninstallString").unwrap(),
                format!("\"{}\"", root.join(UNINSTALLER).display())
            );
            assert_eq!(key.get_value::<u32, _>("NoRepair").unwrap(), 1);
        }
        assert_eq!(
            key.get_raw_value("QuietUninstallString")
                .unwrap_err()
                .kind(),
            ErrorKind::NotFound
        );
    }

    #[test]
    fn invalid_version_does_not_modify_owned_registration() {
        let f = Fixture::new();
        let key = f.registration();
        let root = Path::new(r"C:\installed\JobTrail");
        key.set_value("InstallLocation", &root.to_string_lossy().as_ref())
            .unwrap();
        key.set_value("DisplayVersion", &"2.4.0").unwrap();
        assert!(f.refresh(root, "invalid").is_err());
        assert_eq!(
            key.get_value::<String, _>("DisplayVersion").unwrap(),
            "2.4.0"
        );
    }

    #[test]
    fn managed_runtime_registration_is_restored_to_root_after_update() {
        let f = Fixture::new();
        let key = f.registration();
        let root = Path::new(r"C:\installed\JobTrail");
        key.set_value(
            "InstallLocation",
            &root.join(".runtime").to_string_lossy().as_ref(),
        )
        .unwrap();
        key.set_value("UninstallString", &"Velopack updater")
            .unwrap();
        f.refresh(root, "2.5.0").unwrap();
        assert_eq!(
            key.get_value::<String, _>("InstallLocation").unwrap(),
            root.to_string_lossy()
        );
        assert_eq!(
            key.get_value::<String, _>("UninstallString").unwrap(),
            format!("\"{}\"", root.join(UNINSTALLER).display())
        );
    }
}
