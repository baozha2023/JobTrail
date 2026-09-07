#![windows_subsystem = "windows"]
use anyhow::{bail, Context, Result};
use jobtrail_bootstrap::*;
use std::{fs, os::windows::process::CommandExt, path::Path, process::Command};

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
            bail!("Velopack 卸载失败，请关闭职迹后重试: {status}");
        }
    }
    if runtime.exists() {
        validate_tree(&runtime)?;
        fs::remove_dir_all(&runtime)?;
    }
    unregister(root)?;
    for name in [LAUNCHER, UNINSTALLER] {
        let file = root.join(name);
        if file.exists() {
            plain_file(&file)?;
            fs::remove_file(file)?;
        }
    }
    fs::remove_file(root.join(MARKER))?;
    let _ = fs::remove_dir(root); // Only an empty directory is removed; user data stays.
    Ok(())
}
fn run() -> Result<()> {
    let exe = std::env::current_exe()?;
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    if first.as_deref() == Some(std::ffi::OsStr::new("--worker")) {
        let root = args.next().context("缺少卸载目录")?;
        let pid: u32 = args
            .next()
            .context("缺少等待进程")?
            .to_string_lossy()
            .parse()?;
        let parent: u32 = args
            .next()
            .context("缺少父进程")?
            .to_string_lossy()
            .parse()?;
        wait_pid(parent)?;
        if args.next().is_some() {
            bail!("未知卸载参数");
        }
        let result = uninstall(Path::new(&root), pid);
        schedule_worker_cleanup(exe.parent().context("临时目录缺失")?)?;
        return result;
    }
    let mut pid = 0;
    if let Some(arg) = first {
        if arg != "--confirmed" {
            bail!("未知卸载参数");
        }
        if let Some(wait) = args.next() {
            if wait != "--wait-pid" {
                bail!("未知卸载参数");
            }
            pid = args
                .next()
                .context("缺少进程 ID")?
                .to_string_lossy()
                .parse()?;
        }
        if args.next().is_some() {
            bail!("未知卸载参数");
        }
    } else if rfd::MessageDialog::new()
        .set_title("卸载职迹")
        .set_description(
            "将关闭并卸载职迹。配置、求职数据库和简历文件将保留在原安装目录。是否继续？",
        )
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        != rfd::MessageDialogResult::Yes
    {
        return Ok(());
    }
    let root = exe.parent().context("安装目录缺失")?;
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
