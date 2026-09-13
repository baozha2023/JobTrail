use anyhow::{bail, Context, Result};
use jobtrail_bootstrap::{
    plain_file, register, validate_installation, validate_tree, version, NO_WINDOW,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::{OsStr, OsString},
    fs,
    io::Read,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command},
    ptr, thread,
    time::{Duration, Instant},
};
use uuid::Uuid;
use winapi::{
    shared::winerror::ERROR_ALREADY_EXISTS,
    um::{
        errhandlingapi::GetLastError,
        handleapi::CloseHandle,
        processthreadsapi::OpenProcess,
        synchapi::{CreateMutexW, WaitForSingleObject},
        winbase::QueryFullProcessImageNameW,
        winnt::{HANDLE, PROCESS_QUERY_LIMITED_INFORMATION, SYNCHRONIZE},
    },
};

const HEALTH_TIMEOUT: Duration = Duration::from_secs(45);
const GUARD_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingUpdate {
    format: String,
    source_version: String,
    target_version: String,
    failure_count: u32,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RollbackState {
    format: String,
    source_version: String,
    target_version: String,
    package_file: String,
    package_sha256: String,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HealthRecord {
    format: String,
    version: String,
    process_id: u32,
    healthy_at: String,
}

struct LauncherGuard(HANDLE);
impl Drop for LauncherGuard {
    fn drop(&mut self) {
        // SAFETY: CreateMutexW returned this owned, non-null handle.
        unsafe { CloseHandle(self.0) };
    }
}

fn normalized_path(path: &Path) -> Option<String> {
    Some(
        fs::canonicalize(path)
            .ok()?
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .to_lowercase(),
    )
}

fn live_application(state_root: &Path, client: &Path) -> bool {
    let path = state_root.join("last-good.json");
    if plain_file(&path).is_err() {
        return false;
    }
    let Ok(content) = fs::read(path) else {
        return false;
    };
    let Ok(health) = serde_json::from_slice::<HealthRecord>(&content) else {
        return false;
    };
    if health.format != "jobtrail-health" || health.process_id == 0 {
        return false;
    }
    // SAFETY: PID is read from a validated local health file; minimal read-only
    // rights are requested and the handle is closed in every branch.
    let handle = unsafe {
        OpenProcess(
            SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            health.process_id,
        )
    };
    if handle.is_null() {
        return false;
    }
    // SAFETY: handle is valid and only queried for signaled state.
    let running = unsafe { WaitForSingleObject(handle, 0) } == 258;
    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` is writable for `length` UTF-16 units, and handle has
    // PROCESS_QUERY_LIMITED_INFORMATION rights.
    let queried =
        unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } != 0;
    // SAFETY: this function owns the OpenProcess handle.
    unsafe { CloseHandle(handle) };
    if !running || !queried {
        return false;
    }
    buffer.truncate(length as usize);
    normalized_path(&PathBuf::from(OsString::from_wide(&buffer))) == normalized_path(client)
}

fn forward_arguments(root: &Path, args: &[OsString]) -> Result<()> {
    let client = root.join(".runtime/current/zhiji.exe");
    plain_file(&client)?;
    let mut child = Command::new(client)
        .args(args)
        .current_dir(root)
        .creation_flags(NO_WINDOW)
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            bail!("职迹参数转发失败: {status}");
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    bail!("职迹参数转发超时")
}

fn acquire_guard(root: &Path) -> Result<Option<LauncherGuard>> {
    let digest = Sha256::digest(root.to_string_lossy().to_lowercase().as_bytes());
    let name = format!("Local\\JobTrailLauncher-{digest:x}");
    let wide: Vec<u16> = OsStr::new(&name).encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL-terminated and remains live throughout the call.
    let handle = unsafe { CreateMutexW(ptr::null_mut(), 0, wide.as_ptr()) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: GetLastError is read immediately after successful CreateMutexW.
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        // SAFETY: this branch still owns the handle returned above.
        unsafe { CloseHandle(handle) };
        return Ok(None);
    }
    Ok(Some(LauncherGuard(handle)))
}

fn wait_for_guard(root: &Path) -> Result<LauncherGuard> {
    let deadline = Instant::now() + GUARD_TIMEOUT;
    loop {
        if let Some(guard) = acquire_guard(root)? {
            return Ok(guard);
        }
        if Instant::now() >= deadline {
            bail!("等待正在进行的职迹启动超时");
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    fs::write(&temporary, serde_json::to_vec(value)?)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn sha256(path: &Path) -> Result<String> {
    let mut source = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    // The Windows GUI main thread has a small default stack; keep the hash
    // buffer on the heap so real Full packages cannot overflow it.
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn valid_package_name(name: &str) -> bool {
    !name.is_empty()
        && Path::new(name).file_name() == Some(OsStr::new(name))
        && name.to_ascii_lowercase().ends_with("-full.nupkg")
}

fn rollback_state(root: &Path, pending: &PendingUpdate) -> Result<(PathBuf, RollbackState)> {
    let rollback_root = root.join(".runtime/rollback");
    validate_tree(&rollback_root)?;
    let state_path = rollback_root.join("rollback-state.json");
    plain_file(&state_path)?;
    let state: RollbackState = serde_json::from_slice(&fs::read(state_path)?)?;
    if state.format != "jobtrail-rollback-state"
        || state.source_version != pending.source_version
        || state.target_version != pending.target_version
        || !valid_package_name(&state.package_file)
        || state.package_sha256.len() != 64
        || !state.package_sha256.bytes().all(|v| v.is_ascii_hexdigit())
        || state.package_sha256 != state.package_sha256.to_ascii_lowercase()
        || state.created_at.is_empty()
    {
        bail!("更新回滚状态无效");
    }
    let package = rollback_root.join(&state.package_file);
    plain_file(&package)?;
    plain_file(&rollback_root.join("config.json"))?;
    if !rollback_root.join("data").is_dir() {
        bail!("更新回滚数据库快照缺失");
    }
    plain_file(&rollback_root.join("data/zhiji.db"))?;
    if sha256(&package)? != state.package_sha256 {
        bail!("更新回滚包校验失败");
    }
    Ok((rollback_root, state))
}

fn read_pending(path: &Path) -> Result<Option<PendingUpdate>> {
    if !path.exists() {
        return Ok(None);
    }
    plain_file(path)?;
    let pending: PendingUpdate = serde_json::from_slice(&fs::read(path)?)?;
    if pending.format != "jobtrail-pending-update"
        || semver::Version::parse(&pending.source_version)?
            >= semver::Version::parse(&pending.target_version)?
        || pending.failure_count > 2
        || pending.created_at.is_empty()
    {
        bail!("待应用更新状态无效");
    }
    Ok(Some(pending))
}

fn start_runtime(root: &Path, args: &[OsString], token: Uuid) -> Result<Child> {
    let client = root.join(".runtime/current/zhiji.exe");
    plain_file(&client)?;
    Command::new(client)
        .args(args)
        .current_dir(root)
        .env("JOBTRAIL_LAUNCH_TOKEN", token.to_string())
        .creation_flags(NO_WINDOW)
        .spawn()
        .context("启动职迹程序")
}

fn wait_health(child: &mut Child, path: &Path, installed_version: &str) -> Result<bool> {
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    while Instant::now() < deadline {
        if path.exists() {
            plain_file(path)?;
            let health: HealthRecord = serde_json::from_slice(&fs::read(path)?)?;
            if health.format != "jobtrail-health"
                || health.version != installed_version
                || health.process_id != child.id()
                || health.healthy_at.is_empty()
            {
                bail!("程序启动健康记录无效");
            }
            fs::remove_file(path)?;
            return Ok(true);
        }
        if child.try_wait()?.is_some() {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(250));
    }
    Ok(false)
}

fn launch_checked(root: &Path, state_root: &Path, args: &[OsString]) -> Result<bool> {
    let installed_version = version(root)?;
    let token = Uuid::new_v4();
    let health_path = state_root.join(format!("healthy-{token}.json"));
    let mut child = start_runtime(root, args, token)?;
    let result = wait_health(&mut child, &health_path, &installed_version);
    match result {
        Ok(true) => Ok(true),
        other => {
            let _ = child.kill();
            let _ = child.wait();
            other
        }
    }
}

fn copy_data_tree(source: &Path, target: &Path) -> Result<()> {
    validate_tree(source)?;
    fs::create_dir(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let destination = target.join(entry.file_name());
        if path.is_dir() {
            copy_data_tree(&path, &destination)?;
        } else {
            plain_file(&path)?;
            fs::copy(path, destination)?;
        }
    }
    Ok(())
}

fn prepare_restored_data(rollback_root: &Path, state_root: &Path) -> Result<PathBuf> {
    let staging = state_root.join(format!("rollback-data-staging-{}", Uuid::new_v4()));
    fs::create_dir(&staging)?;
    let result = (|| -> Result<()> {
        fs::copy(
            rollback_root.join("config.json"),
            staging.join("config.json"),
        )?;
        copy_data_tree(&rollback_root.join("data"), &staging.join("data"))
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    Ok(staging)
}

fn restore_data(root: &Path, staging: &Path, state_root: &Path) -> Result<()> {
    let previous = state_root.join(format!("data-before-rollback-{}", Uuid::new_v4()));
    fs::create_dir(&previous)?;
    let names = ["config.json", "data"];
    let mut backed_up = Vec::new();
    let mut restored = Vec::new();
    let result = (|| -> Result<()> {
        for name in names {
            let current = root.join(name);
            if current.exists() {
                fs::rename(current, previous.join(name))?;
                backed_up.push(name);
            }
        }
        for name in names {
            fs::rename(staging.join(name), root.join(name))?;
            restored.push(name);
        }
        Ok(())
    })();
    if let Err(error) = result {
        for name in restored.into_iter().rev() {
            let current = root.join(name);
            if name == "data" {
                fs::remove_dir_all(current)?;
            } else {
                fs::remove_file(current)?;
            }
        }
        for name in backed_up.into_iter().rev() {
            fs::rename(previous.join(name), root.join(name))?;
        }
        let _ = fs::remove_dir(&previous);
        let _ = fs::remove_dir_all(staging);
        return Err(error).context("恢复回滚数据失败");
    }
    let _ = fs::remove_dir_all(previous);
    let _ = fs::remove_dir_all(staging);
    Ok(())
}

fn apply_rollback(root: &Path, state_root: &Path, pending: &PendingUpdate) -> Result<()> {
    let (rollback_root, rollback) = rollback_state(root, pending)?;
    let package_source = rollback_root.join(&rollback.package_file);
    let packages = root.join(".runtime/packages");
    validate_tree(&packages)?;
    let package_target = packages.join(&rollback.package_file);
    if !package_target.exists() || sha256(&package_target)? != rollback.package_sha256 {
        let temporary = packages.join(format!(".jobtrail-rollback-{}.tmp", Uuid::new_v4()));
        let copy_result = (|| -> Result<()> {
            fs::copy(&package_source, &temporary)?;
            if sha256(&temporary)? != rollback.package_sha256 {
                bail!("暂存回滚包校验失败");
            }
            if package_target.exists() {
                fs::remove_file(&package_target)?;
            }
            fs::rename(&temporary, &package_target)?;
            Ok(())
        })();
        if copy_result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        copy_result?;
    }
    let staging = prepare_restored_data(&rollback_root, state_root)?;
    let updater = root.join(".runtime/Update.exe");
    plain_file(&updater)?;
    let status = Command::new(updater)
        .args(["apply", "--package"])
        .arg(&package_target)
        .args(["--silent", "--norestart"])
        .current_dir(root)
        .creation_flags(NO_WINDOW)
        .status()?;
    if !status.success() {
        let _ = fs::remove_dir_all(staging);
        bail!("Velopack 回滚失败: {status}");
    }
    if version(root)? != rollback.source_version {
        bail!("回滚后程序版本与旧版本不一致");
    }
    restore_data(root, &staging, state_root)?;
    fs::remove_file(state_root.join("pending-update.json"))?;
    Ok(())
}

fn clean_rollback(root: &Path) {
    let directory = root.join(".runtime/rollback");
    if directory.exists() && validate_tree(&directory).is_ok() {
        let _ = fs::remove_dir_all(directory);
    }
}

pub fn launch(root: &Path, args: &[OsString]) -> Result<()> {
    validate_installation(root)?;
    let state_root = root.join(".runtime/state");
    let client = root.join(".runtime/current/zhiji.exe");
    if live_application(&state_root, &client) {
        return forward_arguments(root, args);
    }
    let _guard = wait_for_guard(root)?;
    if live_application(&state_root, &client) {
        return forward_arguments(root, args);
    }
    fs::create_dir_all(&state_root)?;
    validate_tree(&state_root)?;
    let pending_path = state_root.join("pending-update.json");
    let mut pending = read_pending(&pending_path)?;
    let installed_version = version(root)?;
    if let Some(update) = pending.as_ref() {
        if installed_version != update.source_version && installed_version != update.target_version
        {
            bail!("更新后的程序版本与预期不一致");
        }
    }
    if launch_checked(root, &state_root, args)? {
        register(root, &installed_version, false)?;
        if pending.is_some() {
            fs::remove_file(pending_path)?;
        }
        // Once startup is healthy, rollback data is disposable. Failure to
        // prune it cannot turn a running application into a failed launch;
        // the next root launch retries this cleanup.
        clean_rollback(root);
        return Ok(());
    }
    if let Some(update) = pending.as_mut() {
        if installed_version == update.target_version {
            update.failure_count = update.failure_count.saturating_add(1).min(2);
            write_json_atomic(&pending_path, update)?;
            if update.failure_count >= 2 {
                apply_rollback(root, &state_root, update)?;
                if launch_checked(root, &state_root, &[])? {
                    register(root, &update.source_version, false)?;
                    clean_rollback(root);
                    return Ok(());
                }
                bail!("恢复旧版本后仍未通过启动健康检查");
            }
        }
    }
    bail!("职迹未在 45 秒内完成启动，请重试")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_package_names() {
        assert!(valid_package_name("zhiji-0.5.0-full.nupkg"));
        assert!(!valid_package_name("../zhiji-0.5.0-full.nupkg"));
        assert!(!valid_package_name("zhiji-0.5.0-delta.nupkg"));
    }

    #[test]
    fn pending_requires_a_newer_target() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("pending-update.json");
        let state = PendingUpdate {
            format: "jobtrail-pending-update".into(),
            source_version: "0.5.0".into(),
            target_version: "0.4.0".into(),
            failure_count: 0,
            created_at: "2026-09-12T00:00:00.000Z".into(),
        };
        fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
        assert!(read_pending(&path).is_err());
    }

    #[test]
    fn rollback_package_must_match_recorded_sha256() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("JobTrail");
        let rollback = root.join(".runtime/rollback");
        fs::create_dir_all(rollback.join("data")).unwrap();
        fs::write(rollback.join("config.json"), b"{}").unwrap();
        fs::write(rollback.join("data/zhiji.db"), b"database").unwrap();
        let package = "zhiji-0.4.0-full.nupkg";
        fs::write(rollback.join(package), b"valid package").unwrap();
        let pending = PendingUpdate {
            format: "jobtrail-pending-update".into(),
            source_version: "0.4.0".into(),
            target_version: "0.5.0".into(),
            failure_count: 2,
            created_at: "2026-09-12T00:00:00.000Z".into(),
        };
        let state = serde_json::json!({
            "format": "jobtrail-rollback-state",
            "sourceVersion": "0.4.0",
            "targetVersion": "0.5.0",
            "packageFile": package,
            "packageSha256": sha256(&rollback.join(package)).unwrap(),
            "createdAt": "2026-09-12T00:00:00.000Z",
        });
        fs::write(
            rollback.join("rollback-state.json"),
            serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();
        assert!(rollback_state(&root, &pending).is_ok());
        fs::write(rollback.join(package), b"tampered").unwrap();
        assert!(rollback_state(&root, &pending).is_err());
    }

    #[test]
    fn pending_state_replaces_existing_file_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("pending-update.json");
        fs::write(&path, b"old").unwrap();
        let pending = PendingUpdate {
            format: "jobtrail-pending-update".into(),
            source_version: "0.4.0".into(),
            target_version: "0.5.0".into(),
            failure_count: 1,
            created_at: "2026-09-12T00:00:00.000Z".into(),
        };
        write_json_atomic(&path, &pending).unwrap();
        assert_eq!(read_pending(&path).unwrap().unwrap().failure_count, 1);
    }

    #[test]
    fn restores_config_and_database_without_touching_resumes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("JobTrail");
        let rollback_root = root.join(".runtime/rollback");
        let state_root = root.join(".runtime/state");
        fs::create_dir_all(rollback_root.join("data")).unwrap();
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(root.join("resumes")).unwrap();
        fs::create_dir_all(&state_root).unwrap();
        fs::write(root.join("config.json"), b"new").unwrap();
        fs::write(root.join("data/zhiji.db"), b"new database").unwrap();
        fs::write(root.join("resumes/cv.pdf"), b"resume").unwrap();
        fs::write(rollback_root.join("config.json"), b"old").unwrap();
        fs::write(rollback_root.join("data/zhiji.db"), b"old database").unwrap();

        let staging = prepare_restored_data(&rollback_root, &state_root).unwrap();
        restore_data(&root, &staging, &state_root).unwrap();

        assert_eq!(fs::read(root.join("config.json")).unwrap(), b"old");
        assert_eq!(
            fs::read(root.join("data/zhiji.db")).unwrap(),
            b"old database"
        );
        assert_eq!(fs::read(root.join("resumes/cv.pdf")).unwrap(), b"resume");
        assert_eq!(
            fs::read(rollback_root.join("data/zhiji.db")).unwrap(),
            b"old database"
        );
    }
}
