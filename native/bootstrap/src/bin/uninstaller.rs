#![windows_subsystem = "windows"]
use anyhow::{bail, Context, Result};
use jobtrail_bootstrap::localization::{language, text, Language, Message};
use jobtrail_bootstrap::*;
use std::{
    fs, io,
    os::windows::{fs::MetadataExt, process::CommandExt},
    path::Path,
    process::Command,
    thread,
    time::Duration,
};

const DELETE_ATTEMPTS: usize = 40;
const DELETE_RETRY_DELAY: Duration = Duration::from_millis(125);

fn transient_delete_error(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32 | 145))
}

fn remove_install_contents_once(root: &Path) -> io::Result<()> {
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "{}: {}",
                    text(Message::InstallTreeContainsLink),
                    path.display()
                ),
            ));
        }
        // These two files keep an interrupted uninstall recoverable. The
        // worker removes them only after every other item and shell entry.
        if path
            .file_name()
            .is_some_and(|name| name == MARKER || name == UNINSTALLER)
        {
            if !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    text(Message::InvalidUninstallEntry),
                ));
            }
            continue;
        }
        if metadata.is_dir() {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn remove_install_contents(root: &Path) -> Result<()> {
    validate_installation(root)?;
    validate_tree(root)?;
    for attempt in 0..DELETE_ATTEMPTS {
        match remove_install_contents_once(root) {
            Ok(()) => return Ok(()),
            Err(error) if transient_delete_error(&error) && attempt + 1 < DELETE_ATTEMPTS => {
                thread::sleep(DELETE_RETRY_DELAY);
            }
            Err(error) => {
                return Err(error).context(text(Message::ClearDirectoryFailed));
            }
        }
    }
    unreachable!("删除重试循环必须返回结果")
}

fn remove_file_with_retry(path: &Path) -> Result<()> {
    plain_file(path)?;
    for attempt in 0..DELETE_ATTEMPTS {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(error) if transient_delete_error(&error) && attempt + 1 < DELETE_ATTEMPTS => {
                thread::sleep(DELETE_RETRY_DELAY);
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("{}: {}", text(Message::DeleteFileFailed), path.display())
                })
            }
        }
    }
    unreachable!("删除重试循环必须返回结果")
}

fn uninstall(root: &Path, pid: u32) -> Result<()> {
    validate_installation(root)?;
    wait_pid(pid)?;
    let runtime = root.join(".runtime");
    if runtime.exists() {
        validate_tree(&runtime)?;
    }
    let updater = runtime.join("Update.exe");
    if updater.exists() {
        plain_file(&updater)?;
        let status = Command::new(updater)
            .args(["uninstall", "--silent"])
            .creation_flags(NO_WINDOW)
            .status()?;
        if !status.success() {
            bail!("{}: {status}", text(Message::UninstallFailed));
        }
    }
    remove_install_contents(root)?;
    unregister(root)?;
    let marker = root.join(MARKER);
    remove_file_with_retry(&marker)?;
    let uninstaller = root.join(UNINSTALLER);
    if let Err(error) = remove_file_with_retry(&uninstaller) {
        // The root uninstaller is the final persistent retry entry. Restore
        // its marker when Windows temporarily refuses to remove that binary.
        fs::write(&marker, b"jobtrail-root-v1\n").context(text(Message::RestoreUninstallMarker))?;
        return Err(error);
    }
    Ok(())
}
fn uninstall_confirmed(language: Language, result: rfd::MessageDialogResult) -> bool {
    result == rfd::MessageDialogResult::Custom(language.text(Message::Uninstall).to_owned())
}

fn confirm_uninstall(language: Language) -> bool {
    let result = rfd::MessageDialog::new()
        .set_title(language.text(Message::UninstallTitle))
        .set_description(language.text(Message::UninstallWarning))
        .set_level(rfd::MessageLevel::Warning)
        .set_buttons(rfd::MessageButtons::OkCancelCustom(
            language.text(Message::Uninstall).to_owned(),
            language.text(Message::Cancel).to_owned(),
        ))
        .show();
    uninstall_confirmed(language, result)
}

fn show_uninstall_complete(language: Language) {
    rfd::MessageDialog::new()
        .set_title(language.text(Message::AppName))
        .set_description(language.text(Message::UninstallComplete))
        .set_level(rfd::MessageLevel::Info)
        .set_buttons(rfd::MessageButtons::OkCustom(
            language.text(Message::Confirm).to_owned(),
        ))
        .show();
}

fn run() -> Result<()> {
    let exe = std::env::current_exe()?;
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    if first.as_deref() == Some(std::ffi::OsStr::new("--worker")) {
        let root = args
            .next()
            .context(text(Message::MissingUninstallDirectory))?;
        let pid: u32 = args
            .next()
            .context(text(Message::MissingWaitProcess))?
            .to_string_lossy()
            .parse()?;
        let parent: u32 = args
            .next()
            .context(text(Message::MissingParentProcess))?
            .to_string_lossy()
            .parse()?;
        wait_pid(parent)?;
        if args.next().is_some() {
            bail!("{}", text(Message::InvalidUninstallArgs));
        }
        let result = uninstall(Path::new(&root), pid);
        let cleanup =
            schedule_worker_cleanup(exe.parent().context(text(Message::MissingTempDirectory))?);
        result?;
        if let Err(error) = cleanup {
            eprintln!("{}: {error:#}", text(Message::WorkerCleanupFailed));
        }
        show_uninstall_complete(language());
        return Ok(());
    }
    let mut pid = 0;
    if let Some(arg) = first {
        if arg != "--confirmed" {
            bail!("{}", text(Message::InvalidUninstallArgs));
        }
        if let Some(wait) = args.next() {
            if wait != "--wait-pid" {
                bail!("{}", text(Message::InvalidUninstallArgs));
            }
            pid = args
                .next()
                .context(text(Message::MissingProcessId))?
                .to_string_lossy()
                .parse()?;
        }
        if args.next().is_some() {
            bail!("{}", text(Message::InvalidUninstallArgs));
        }
    } else if !confirm_uninstall(language()) {
        return Ok(());
    }
    let root = exe.parent().context(text(Message::MissingRootDirectory))?;
    validate_installation(root)?;
    let temp = tempfile::Builder::new()
        .prefix("jobtrail-uninstall-")
        .tempdir()?;
    let worker = temp.path().join("worker.exe");
    fs::copy(&exe, &worker)?;
    Command::new(worker)
        .arg("--worker")
        .arg(root)
        .arg(pid.to_string())
        .arg(std::process::id().to_string())
        .creation_flags(NO_WINDOW)
        .spawn()?;
    let _ = temp.keep();
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        error_dialog(&error);
        std::process::exit(1);
    }
}

#[cfg(test)]
#[path = "../test_support.rs"]
mod test_support;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::windows::fs::OpenOptionsExt, time::Instant};
    use winapi::um::winnt::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    #[test]
    fn only_the_explicit_translated_uninstall_choice_confirms_deletion() {
        for language in [Language::ZhCn, Language::EnUs] {
            assert!(uninstall_confirmed(
                language,
                rfd::MessageDialogResult::Custom(language.text(Message::Uninstall).to_owned())
            ));
            for result in [
                rfd::MessageDialogResult::Cancel,
                rfd::MessageDialogResult::No,
                rfd::MessageDialogResult::Yes,
                rfd::MessageDialogResult::Ok,
                rfd::MessageDialogResult::Custom(language.text(Message::Cancel).to_owned()),
                rfd::MessageDialogResult::Custom("unknown".to_owned()),
            ] {
                assert!(!uninstall_confirmed(language, result));
            }
        }
    }

    #[test]
    fn native_uninstaller_dialogs_translate_both_languages_and_close_without_uninstalling() {
        for language in [Language::ZhCn, Language::EnUs] {
            let observer = test_support::observe_window("#32770", move |window| {
                anyhow::ensure!(
                    test_support::window_text(window) == language.text(Message::UninstallTitle)
                );
                let controls = test_support::children(window);
                for message in [Message::Uninstall, Message::Cancel] {
                    let control = controls
                        .iter()
                        .copied()
                        .find(|control| {
                            test_support::window_text(*control) == language.text(message)
                        })
                        .ok_or_else(|| anyhow::anyhow!("Missing uninstall button: {message:?}"))?;
                    test_support::assert_text_fits(control, false)?;
                }
                Ok(())
            });
            assert!(!confirm_uninstall(language));
            observer.join().unwrap().unwrap();

            let observer = test_support::observe_window("#32770", move |window| {
                anyhow::ensure!(
                    test_support::window_text(window) == language.text(Message::AppName)
                );
                let control = test_support::children(window)
                    .into_iter()
                    .find(|control| {
                        test_support::window_text(*control) == language.text(Message::Confirm)
                    })
                    .ok_or_else(|| anyhow::anyhow!("Missing localized OK button"))?;
                test_support::assert_text_fits(control, false)
            });
            show_uninstall_complete(language);
            observer.join().unwrap().unwrap();
        }
    }

    #[test]
    fn removes_program_and_user_data_but_keeps_empty_install_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("JobTrail");
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(root.join("resumes")).unwrap();
        fs::write(root.join(MARKER), b"jobtrail-root-v1\n").unwrap();
        fs::write(root.join("config.json"), b"{}").unwrap();
        fs::write(root.join("data/zhiji.db"), b"database").unwrap();
        fs::write(root.join("resumes/resume.pdf"), b"resume").unwrap();

        remove_install_contents(&root).unwrap();

        assert!(root.is_dir());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert!(root.join(MARKER).is_file());
    }

    #[test]
    fn retries_only_transient_windows_delete_errors() {
        for code in [5, 32, 145] {
            assert!(transient_delete_error(&io::Error::from_raw_os_error(code)));
        }
        assert!(!transient_delete_error(&io::Error::from_raw_os_error(2)));
    }

    #[test]
    fn retries_until_a_temporarily_locked_file_is_released() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("JobTrail");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MARKER), b"jobtrail-root-v1\n").unwrap();
        let locked_path = root.join("locked.dat");
        fs::write(&locked_path, b"locked").unwrap();
        let locked_file = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(locked_path)
            .unwrap();
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            drop(locked_file);
        });

        let started = Instant::now();
        remove_install_contents(&root).unwrap();
        release.join().unwrap();

        assert!(started.elapsed() >= DELETE_RETRY_DELAY);
        assert!(root.is_dir());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert!(root.join(MARKER).is_file());
    }

    #[test]
    fn interrupted_cleanup_retains_the_root_retry_entry() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("JobTrail");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MARKER), b"jobtrail-root-v1\n").unwrap();
        fs::write(root.join(UNINSTALLER), b"retry").unwrap();
        let locked_path = root.join("data.bin");
        fs::write(&locked_path, b"locked").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&locked_path)
            .unwrap();

        assert!(remove_install_contents_once(&root).is_err());
        assert!(root.join(MARKER).is_file());
        assert!(root.join(UNINSTALLER).is_file());
        drop(lock);
        remove_install_contents(&root).unwrap();
        assert!(!locked_path.exists());
    }
}
