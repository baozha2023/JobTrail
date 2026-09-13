#![windows_subsystem = "windows"]
use anyhow::{bail, Context, Result};
use jobtrail_bootstrap::{error_dialog, plain_file, validate_installation, version};
#[path = "../rollback.rs"]
mod rollback;
use std::{ffi::OsString, process::Command};

fn is_mcp_mode(args: &[OsString]) -> bool {
    args == [OsString::from("--mcp")]
}

fn validate_args(args: &[OsString]) -> Result<()> {
    if args.iter().any(|arg| arg == "--mcp") && !is_mcp_mode(args) {
        bail!("MCP 启动参数无效");
    }
    Ok(())
}

fn run(args: &[OsString]) -> Result<()> {
    validate_args(args)?;
    let exe = std::env::current_exe()?;
    let root = exe.parent().context("安装目录缺失")?;
    if is_mcp_mode(args) {
        validate_installation(root)?;
        let client = root.join(".runtime/current/zhiji.exe");
        plain_file(&client)?;
        let archive = root.join(".runtime/current/resources/app.asar");
        plain_file(&archive)?;
        let entry = archive.join("out/main/mcp-node.js");
        let status = Command::new(client)
            .arg(entry)
            .current_dir(root)
            .env("ELECTRON_RUN_AS_NODE", "1")
            .env("JOBTRAIL_MCP_ROOT", root)
            .env("JOBTRAIL_MCP_VERSION", version(root)?)
            .status()?;
        // MCP hosts own this launcher's stdio pipes. Keep them inherited and
        // wait so the host observes the real server lifetime and exit code.
        std::process::exit(status.code().unwrap_or(1));
    }
    rollback::launch(root, args)
}
fn main() {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if let Err(error) = run(&args) {
        if args.iter().any(|arg| arg == "--mcp") {
            eprintln!("JobTrail MCP launcher failed");
        } else {
            error_dialog(&error);
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_exact_mcp_argument() {
        let args = vec![OsString::from("--mcp")];
        assert!(is_mcp_mode(&args));
        assert!(validate_args(&args).is_ok());
    }

    #[test]
    fn rejects_mcp_mode_mixed_with_other_arguments() {
        let args = vec![OsString::from("--verbose"), OsString::from("--mcp")];
        assert!(!is_mcp_mode(&args));
        assert!(validate_args(&args).is_err());
    }

    #[test]
    fn ordinary_launch_is_not_mcp_mode() {
        assert!(!is_mcp_mode(&[OsString::from("--verbose")]));
    }
}
