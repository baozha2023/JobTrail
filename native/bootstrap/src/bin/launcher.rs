#![windows_subsystem = "windows"]
use anyhow::{Context, Result};
use jobtrail_bootstrap::*;
use std::{os::windows::process::CommandExt, process::Command};
fn run() -> Result<()> {
    let exe = std::env::current_exe()?;
    let root = exe.parent().context("安装目录缺失")?;
    validate_installation(root)?;
    let client = root.join(".runtime/current/zhiji.exe");
    plain_file(&client)?;
    register(root, &version(root)?, false)?;
    Command::new(client)
        .args(std::env::args_os().skip(1))
        .current_dir(root)
        .creation_flags(NO_WINDOW)
        .spawn()?;
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        error_dialog(&error);
        std::process::exit(1);
    }
}
