#![windows_subsystem = "windows"]
use anyhow::{bail, Context, Result};
use jobtrail_bootstrap::*;
use std::{
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
};
const SETUP: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/setup.exe"));
const ROOT_LAUNCHER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/launcher.exe"));
const ROOT_UNINSTALLER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/uninstaller.exe"));

fn install(root: &Path) -> Result<()> {
    if SETUP.is_empty() || ROOT_LAUNCHER.is_empty() || ROOT_UNINSTALLER.is_empty() {
        bail!("安装包没有有效载荷，请通过 release:win 构建");
    }
    validate_path(root)?;
    ensure_not_installed()?;
    if root.exists() {
        for entry in fs::read_dir(root)? {
            let name = entry?.file_name();
            if !["config.json", "data", "resumes"]
                .iter()
                .any(|allowed| name == *allowed)
            {
                bail!("目标目录包含现有程序或其他文件，请先卸载原版本或选择其他位置");
            }
        }
    } else {
        fs::create_dir_all(root)?;
    }
    let temp = tempfile::Builder::new()
        .prefix("jobtrail-install-")
        .tempdir()?;
    let marker = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join(MARKER))?;
    drop(marker);

    let operation = (|| -> Result<()> {
        let setup = temp.path().join("Setup.exe");
        fs::write(&setup, SETUP)?;
        let status = Command::new(setup)
            .arg("--silent")
            .arg("--installto")
            .arg(root.join(".runtime"))
            .creation_flags(NO_WINDOW)
            .status()?;
        if !status.success() {
            bail!("Velopack 安装失败: {status}");
        }
        plain_file(&root.join(".runtime/current/zhiji.exe"))?;
        fs::write(root.join(LAUNCHER), ROOT_LAUNCHER)?;
        fs::write(root.join(UNINSTALLER), ROOT_UNINSTALLER)?;
        fs::write(root.join(MARKER), b"jobtrail-root-v1\n")?;
        register(root, env!("JOBTRAIL_VERSION"), true)?;
        Ok(())
    })();
    if operation.is_err() {
        unregister(root)?;
        let runtime = root.join(".runtime");
        if runtime.exists() {
            validate_tree(&runtime)?;
            fs::remove_dir_all(runtime)?;
        }
        for name in [LAUNCHER, UNINSTALLER, MARKER] {
            let _ = fs::remove_file(root.join(name));
        }
        let _ = fs::remove_dir(root);
    }
    operation
}

fn run() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    if let Some(argument) = args.next() {
        if argument != "--install-dir" {
            bail!("未知安装参数");
        }
        let target = PathBuf::from(args.next().context("缺少安装目录")?);
        if args.next().is_some() {
            bail!("未知安装参数");
        }
        return install(&target);
    }
    let parent = dirs::data_local_dir()
        .context("无法定位当前用户目录")?
        .join("Programs");
    let Some(selected) = rfd::FileDialog::new()
        .set_title("选择安装父目录（将创建 JobTrail 文件夹）")
        .set_directory(parent)
        .pick_folder()
    else {
        return Ok(());
    };
    let root = selected.join("JobTrail");
    let answer = rfd::MessageDialog::new()
        .set_title("安装职迹")
        .set_description(format!(
            "安装到 {}\n\n配置、数据库和简历保存在安装根目录，更新和卸载不会删除它们。",
            root.display()
        ))
        .set_buttons(rfd::MessageButtons::OkCancel)
        .show();
    if answer != rfd::MessageDialogResult::Ok {
        return Ok(());
    }
    install(&root)?;
    if rfd::MessageDialog::new()
        .set_title("职迹安装完成")
        .set_description("是否立即启动职迹？")
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        == rfd::MessageDialogResult::Yes
    {
        Command::new(root.join(LAUNCHER))
            .creation_flags(NO_WINDOW)
            .spawn()?;
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        if std::env::args_os().len() == 1 {
            error_dialog(&error);
        } else {
            eprintln!("{error:#}");
        }
        std::process::exit(1);
    }
}
