use crate::{plain_file, LAUNCHER, NO_WINDOW};
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{fs, os::windows::process::CommandExt, path::Path, process::Command};

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

fn powershell(script: &str) -> Result<()> {
    let encoded = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .creation_flags(NO_WINDOW)
        .output()?;
    if !output.status.success() {
        #[cfg(test)]
        eprintln!("{}", String::from_utf8_lossy(&output.stderr));
        bail!("修复快捷方式失败");
    }
    Ok(())
}

pub fn repair(root: &Path) -> Result<()> {
    repair_links(root, &crate::shortcuts())
}

fn repair_links(root: &Path, links: &[std::path::PathBuf]) -> Result<()> {
    let mut existing = Vec::new();
    for link in links {
        match fs::symlink_metadata(link) {
            Ok(_) => {
                plain_file(link)?;
                existing.push(quote(link));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    if existing.is_empty() {
        return Ok(());
    }
    // Velopack rewrites the Start menu entry to its execution stub. Only repair
    // that exact target in this installation, preserving other links and their
    // shell metadata. Recheck existence so a deleted link is never recreated.
    powershell(&format!(
        "$ErrorActionPreference='Stop'; $shell=New-Object -ComObject WScript.Shell; \
         foreach ($file in @({})) {{ \
           if (!(Test-Path -LiteralPath $file -PathType Leaf)) {{ continue }}; \
           $link=$shell.CreateShortcut($file); \
           if ($link.TargetPath -eq {}) {{ \
             $link.TargetPath={}; $link.WorkingDirectory={}; \
             $link.IconLocation=({} + ',0'); $link.Save() \
           }} \
         }}",
        existing.join(","),
        quote(&root.join(".runtime").join("zhiji.exe")),
        quote(&root.join(LAUNCHER)),
        quote(root),
        quote(&root.join(LAUNCHER)),
    ))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_only_existing_links_owned_by_this_installation() {
        let temp = tempfile::tempdir().unwrap();
        let canonical = fs::canonicalize(temp.path()).unwrap();
        let canonical = canonical.to_string_lossy();
        let directory = Path::new(canonical.strip_prefix(r"\\?\").unwrap_or(&canonical));
        // Exercise Unicode, apostrophes and spaces through the Windows Shell.
        let root = directory.join("职迹 user's installation").join("JobTrail");
        fs::create_dir_all(root.join(".runtime")).unwrap();
        let launcher = root.join(LAUNCHER);
        let stub = root.join(".runtime").join("zhiji.exe");
        let foreign = temp.path().join("other").join(".runtime").join("zhiji.exe");
        fs::create_dir_all(foreign.parent().unwrap()).unwrap();
        for file in [&launcher, &stub, &foreign] {
            fs::write(file, b"test executable").unwrap();
        }
        let links: Vec<_> = ["runtime.lnk", "root.lnk", "foreign.lnk", "deleted.lnk"]
            .iter()
            .map(|name| temp.path().join(name))
            .collect();
        for (link, target) in links.iter().zip([&stub, &launcher, &foreign]) {
            mslnk::ShellLink::new(target)
                .unwrap()
                .create_lnk(link)
                .unwrap();
        }
        powershell(&format!(
            "$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut({}); \
             $l.Description='Keep this description'; $l.Arguments='--example'; $l.Save()",
            quote(&links[0])
        ))
        .unwrap();
        let original_root = fs::read(&links[1]).unwrap();
        let original_foreign = fs::read(&links[2]).unwrap();
        repair_links(&root, &links).unwrap();
        let first_repair = fs::read(&links[0]).unwrap();
        repair_links(&root, &links).unwrap();
        assert_eq!(first_repair, fs::read(&links[0]).unwrap());
        assert_eq!(original_root, fs::read(&links[1]).unwrap());
        assert_eq!(original_foreign, fs::read(&links[2]).unwrap());
        assert!(!links[3].exists());
        let canonical = fs::canonicalize(&root).unwrap();
        let canonical = canonical.to_string_lossy();
        let expected_root = Path::new(canonical.strip_prefix(r"\\?\").unwrap_or(&canonical));
        powershell(&format!(
            "$ErrorActionPreference='Stop'; $s=New-Object -ComObject WScript.Shell; \
             $l=$s.CreateShortcut({}); \
             if ($l.TargetPath -ne {} -or $l.WorkingDirectory -ne {} \
                 -or $l.Description -ne 'Keep this description' -or $l.Arguments -ne '--example') \
             {{ throw ($l | Select-Object TargetPath,WorkingDirectory,Description,Arguments | ConvertTo-Json -Compress) }}",
            quote(&links[0]),
            quote(&expected_root.join(LAUNCHER)),
            quote(expected_root)
        ))
        .unwrap();
    }
}
