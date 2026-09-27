use anyhow::{bail, Context, Result};
use jobtrail_bootstrap::{
    plain_file, validate_installation, validate_tree, version, LAUNCHER, NO_WINDOW,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::windows::{fs::OpenOptionsExt, process::CommandExt},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: String,
    sha256: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: String,
    previous_sha256: String,
    next_sha256: String,
}
fn hash(file: &Path) -> Result<String> {
    plain_file(file)?;
    Ok(format!("{:x}", Sha256::digest(fs::read(file)?)))
}
fn probe(file: &Path, expected_version: &str) -> Result<()> {
    plain_file(file)?;
    let mut child = Command::new(file)
        .args(["--bootstrap-check", expected_version])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(NO_WINDOW)
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            bail!("Launcher probe failed");
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Launcher probe timed out");
        }
        thread::sleep(Duration::from_millis(50));
    }
}
// Windows std::fs::rename uses replacement semantics on the same volume. Never
// remove the live executable first: sharing violations leave the old entry intact.
fn replace(source: &Path, target: &Path) -> Result<()> {
    fs::rename(source, target)?;
    Ok(())
}
fn optional_plain(file: &Path) -> Result<()> {
    match fs::symlink_metadata(file) {
        Ok(_) => plain_file(file),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
fn recover(root: &Path, check: impl Fn(&Path, &str) -> Result<()>) -> Result<()> {
    let state = root.join(".runtime/state");
    let journal = state.join("launcher-update.json");
    if !journal.exists() {
        return Ok(());
    }
    plain_file(&journal)?;
    let record: Journal = serde_json::from_slice(&fs::read(&journal)?)?;
    let previous = state.join("launcher.previous.exe");
    let target = root.join(LAUNCHER);
    let next = root.join(".JobTrail.next.exe");
    optional_plain(&next)?;
    if hash(&previous)? != record.previous_sha256 {
        bail!("Invalid previous launcher");
    }
    let current_hash = hash(&target)?;
    if current_hash == record.next_sha256 {
        if check(&target, &record.version).is_err() {
            fs::copy(&previous, &next)?;
            replace(&next, &target)?;
        }
    } else if current_hash != record.previous_sha256 {
        bail!("Unrecognized launcher state");
    }
    if next.exists() {
        fs::remove_file(next)?;
    }
    fs::remove_file(journal)?;
    Ok(())
}
fn healthy(root: &Path, expected: &str) -> Result<bool> {
    if version(root)? != expected {
        bail!("Runtime changed during launcher refresh");
    }
    let state = root.join(".runtime/state");
    if state.join("pending-update.json").exists()
        || state.join("update-freeze").exists()
        || root.join(".runtime/data-restore").exists()
    {
        return Ok(false);
    }
    let file = state.join("last-good.json");
    plain_file(&file)?;
    let health: serde_json::Value = serde_json::from_slice(&fs::read(file)?)?;
    Ok(health["format"] == "jobtrail-health"
        && health["version"] == expected
        && health["processId"].as_u64().is_some_and(|p| p > 0))
}
pub fn run() -> Result<()> {
    let exe = std::env::current_exe()?;
    let root = exe.ancestors().nth(5).context("Invalid worker location")?;
    validate_installation(root)?;
    let payload = root.join(".runtime/current/resources/bootstrap");
    if exe != payload.join(LAUNCHER) {
        bail!("Invalid worker location");
    }
    // validate_tree rejects all directory reparse points, not just file links.
    validate_tree(&root.join(".runtime/state"))?;
    for directory in [
        root.join(".runtime"),
        root.join(".runtime/current"),
        root.join(".runtime/current/resources"),
    ] {
        use std::os::windows::fs::MetadataExt;
        if fs::symlink_metadata(directory)?.file_attributes() & 0x400 != 0 {
            bail!("Unsafe runtime path");
        }
    }
    validate_tree(&payload)?;
    let state = root.join(".runtime/state");
    let lock = state.join("launcher-update.lock");
    optional_plain(&lock)?;
    // The OS releases this exclusive handle even if the helper crashes.
    let _guard = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(lock)?;
    let manifest_path = payload.join("launcher.json");
    plain_file(&manifest_path)?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(manifest_path)?)?;
    if manifest.version != env!("JOBTRAIL_VERSION") || hash(&exe)? != manifest.sha256 {
        bail!("Launcher payload mismatch");
    }
    let deadline = Instant::now() + Duration::from_secs(60);
    while !healthy(root, &manifest.version)? {
        if Instant::now() >= deadline {
            bail!("Launcher refresh deferred");
        }
        thread::sleep(Duration::from_millis(250));
    }
    recover(root, probe)?;
    let target = root.join(LAUNCHER);
    if hash(&target)? == manifest.sha256 {
        return jobtrail_bootstrap::shortcuts::repair(root);
    }
    probe(&exe, &manifest.version)?;
    let previous = state.join("launcher.previous.exe");
    let next = root.join(".JobTrail.next.exe");
    let journal = state.join("launcher-update.json");
    let temp_journal = state.join("launcher-update.json.tmp");
    for file in [&previous, &next, &journal, &temp_journal] {
        optional_plain(file)?;
    }
    let record = Journal {
        version: manifest.version.clone(),
        previous_sha256: hash(&target)?,
        next_sha256: manifest.sha256.clone(),
    };
    fs::copy(&target, &previous)?;
    if hash(&previous)? != record.previous_sha256 {
        bail!("Launcher backup mismatch");
    }
    fs::copy(&exe, &next)?;
    if hash(&next)? != record.next_sha256 {
        bail!("Launcher staging mismatch");
    }
    fs::write(&temp_journal, serde_json::to_vec(&record)?)?;
    replace(&temp_journal, &journal)?;
    loop {
        if !healthy(root, &manifest.version)? {
            bail!("Launcher refresh deferred");
        }
        if replace(&next, &target).is_ok() {
            break;
        }
        if Instant::now() >= deadline {
            bail!("Launcher still in use; retry on next launch");
        }
        thread::sleep(Duration::from_millis(250));
    }
    recover(root, probe)?;
    if hash(&target)? != manifest.sha256 {
        bail!("Launcher verification failed; previous version restored");
    }
    jobtrail_bootstrap::shortcuts::repair(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("JobTrail");
        fs::create_dir_all(root.join(".runtime/state")).unwrap();
        (temp, root)
    }
    fn journal(root: &Path, current: &[u8]) {
        let state = root.join(".runtime/state");
        fs::write(root.join(LAUNCHER), current).unwrap();
        fs::write(state.join("launcher.previous.exe"), b"old").unwrap();
        fs::write(root.join(".JobTrail.next.exe"), b"new").unwrap();
        let j = Journal {
            version: "1.0.0".into(),
            previous_sha256: hash(&state.join("launcher.previous.exe")).unwrap(),
            next_sha256: hash(&root.join(".JobTrail.next.exe")).unwrap(),
        };
        fs::write(
            state.join("launcher-update.json"),
            serde_json::to_vec(&j).unwrap(),
        )
        .unwrap();
    }
    #[test]
    fn interrupted_before_replace_preserves_old() {
        let (_t, r) = fixture();
        journal(&r, b"old");
        recover(&r, |_, _| Ok(())).unwrap();
        assert_eq!(fs::read(r.join(LAUNCHER)).unwrap(), b"old");
    }
    #[test]
    fn interrupted_after_replace_verifies_new() {
        let (_t, r) = fixture();
        journal(&r, b"new");
        recover(&r, |_, _| Ok(())).unwrap();
        assert_eq!(fs::read(r.join(LAUNCHER)).unwrap(), b"new");
    }
    #[test]
    fn failed_probe_restores_previous() {
        let (_t, r) = fixture();
        journal(&r, b"new");
        recover(&r, |_, _| bail!("probe")).unwrap();
        assert_eq!(fs::read(r.join(LAUNCHER)).unwrap(), b"old");
    }
    #[test]
    fn altered_backup_is_not_restored() {
        let (_t, r) = fixture();
        journal(&r, b"new");
        fs::write(r.join(".runtime/state/launcher.previous.exe"), b"bad").unwrap();
        assert!(recover(&r, |_, _| bail!("probe")).is_err());
        assert_eq!(fs::read(r.join(LAUNCHER)).unwrap(), b"new");
    }
    #[test]
    fn sharing_violation_preserves_live_executable() {
        let (_t, r) = fixture();
        journal(&r, b"old");
        let guard = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(r.join(LAUNCHER))
            .unwrap();
        assert!(replace(&r.join(".JobTrail.next.exe"), &r.join(LAUNCHER)).is_err());
        drop(guard);
        assert_eq!(fs::read(r.join(LAUNCHER)).unwrap(), b"old");
        replace(&r.join(".JobTrail.next.exe"), &r.join(LAUNCHER)).unwrap();
        assert_eq!(fs::read(r.join(LAUNCHER)).unwrap(), b"new");
    }
}
