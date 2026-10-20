use std::sync::OnceLock;
use winapi::um::{
    winnls::GetUserDefaultUILanguage,
    winnt::{LANG_ENGLISH, PRIMARYLANGID},
};

mod en_us;
mod zh_cn;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Language {
    #[default]
    ZhCn,
    EnUs,
}

impl Language {
    pub fn from_ui_language_id(id: u16) -> Self {
        if PRIMARYLANGID(id) == LANG_ENGLISH {
            Self::EnUs
        } else {
            Self::default()
        }
    }

    pub fn text(self, message: Message) -> &'static str {
        match self {
            Self::ZhCn => zh_cn::text(message),
            Self::EnUs => en_us::text(message),
        }
    }
}

pub fn language() -> Language {
    static LANGUAGE: OnceLock<Language> = OnceLock::new();
    *LANGUAGE.get_or_init(|| {
        // SAFETY: this Win32 function takes no pointers and reads the current user's UI language.
        Language::from_ui_language_id(unsafe { GetUserDefaultUILanguage() })
    })
}

pub fn text(message: Message) -> &'static str {
    language().text(message)
}

#[derive(Clone, Copy, Debug)]
pub enum Message {
    AppName,
    InstallerTitle,
    SelectLocation,
    Installing,
    InstallDescription,
    TargetFolder,
    ChangeLocation,
    RequiredSpace,
    AvailableSpace,
    SpaceUnavailable,
    SpaceCalculating,
    PreparingFiles,
    WritingFiles,
    FinishingSetup,
    InstallComplete,
    CurrentVersion,
    Install,
    Cancel,
    Confirm,
    ChooseParent,
    InvalidLocationTitle,
    StartInstallTaskFailed,
    CreateControlFailed,
    InitProgressFailed,
    RegisterWindowFailed,
    CreateWindowFailed,
    MissingPayload,
    DirectoryNotEmpty,
    InstallFailed,
    InstallCleanupFailed,
    InvalidInstallArgs,
    MissingInstallDirectory,
    MissingUserDirectory,
    LaunchAfterInstallFailed,
    PathMustBeAbsolute,
    InvalidPath,
    LinkedPath,
    PathNotDirectory,
    SystemDirectory,
    ReadFile,
    NotPlainFile,
    InvalidMarker,
    TreeContainsLink,
    MissingVersion,
    AlreadyInstalled,
    ShortcutCleanupFailed,
    MissingShortcutParent,
    AppStillRunning,
    InvalidTempDirectory,
    UninstallTitle,
    UninstallWarning,
    Uninstall,
    UninstallComplete,
    InstallTreeContainsLink,
    InvalidUninstallEntry,
    ClearDirectoryFailed,
    DeleteFileFailed,
    UninstallFailed,
    RestoreUninstallMarker,
    MissingUninstallDirectory,
    MissingWaitProcess,
    MissingParentProcess,
    InvalidUninstallArgs,
    MissingProcessId,
    MissingTempDirectory,
    MissingRootDirectory,
    WorkerCleanupFailed,
}

#[cfg(test)]
const ALL_MESSAGES: &[Message] = &[
    Message::AppName,
    Message::InstallerTitle,
    Message::SelectLocation,
    Message::Installing,
    Message::InstallDescription,
    Message::TargetFolder,
    Message::ChangeLocation,
    Message::RequiredSpace,
    Message::AvailableSpace,
    Message::SpaceUnavailable,
    Message::SpaceCalculating,
    Message::PreparingFiles,
    Message::WritingFiles,
    Message::FinishingSetup,
    Message::InstallComplete,
    Message::CurrentVersion,
    Message::Install,
    Message::Cancel,
    Message::Confirm,
    Message::ChooseParent,
    Message::InvalidLocationTitle,
    Message::StartInstallTaskFailed,
    Message::CreateControlFailed,
    Message::InitProgressFailed,
    Message::RegisterWindowFailed,
    Message::CreateWindowFailed,
    Message::MissingPayload,
    Message::DirectoryNotEmpty,
    Message::InstallFailed,
    Message::InstallCleanupFailed,
    Message::InvalidInstallArgs,
    Message::MissingInstallDirectory,
    Message::MissingUserDirectory,
    Message::LaunchAfterInstallFailed,
    Message::PathMustBeAbsolute,
    Message::InvalidPath,
    Message::LinkedPath,
    Message::PathNotDirectory,
    Message::SystemDirectory,
    Message::ReadFile,
    Message::NotPlainFile,
    Message::InvalidMarker,
    Message::TreeContainsLink,
    Message::MissingVersion,
    Message::AlreadyInstalled,
    Message::ShortcutCleanupFailed,
    Message::MissingShortcutParent,
    Message::AppStillRunning,
    Message::InvalidTempDirectory,
    Message::UninstallTitle,
    Message::UninstallWarning,
    Message::Uninstall,
    Message::UninstallComplete,
    Message::InstallTreeContainsLink,
    Message::InvalidUninstallEntry,
    Message::ClearDirectoryFailed,
    Message::DeleteFileFailed,
    Message::UninstallFailed,
    Message::RestoreUninstallMarker,
    Message::MissingUninstallDirectory,
    Message::MissingWaitProcess,
    Message::MissingParentProcess,
    Message::InvalidUninstallArgs,
    Message::MissingProcessId,
    Message::MissingTempDirectory,
    Message::MissingRootDirectory,
    Message::WorkerCleanupFailed,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_english_ui_language_variants() {
        for id in [0x0409, 0x0809, 0x0c09, 0x1009, 0x4009] {
            assert_eq!(Language::from_ui_language_id(id), Language::EnUs);
        }
    }

    #[test]
    fn defaults_to_simplified_chinese_for_chinese_unknown_or_missing_languages() {
        assert_eq!(Language::default(), Language::ZhCn);
        for id in [0, 0x0404, 0x0804, 0x0c04, 0x0407, 0x040c, 0x0411, 0xffff] {
            assert_eq!(Language::from_ui_language_id(id), Language::ZhCn);
        }
    }

    #[test]
    fn every_message_has_a_nonempty_translation_and_english_has_no_chinese_fallback() {
        for message in ALL_MESSAGES {
            let chinese = Language::ZhCn.text(*message);
            let english = Language::EnUs.text(*message);
            assert!(!chinese.trim().is_empty(), "{message:?}");
            assert!(!english.trim().is_empty(), "{message:?}");
            assert!(
                !english
                    .chars()
                    .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character)),
                "{message:?}"
            );
        }
    }

    #[test]
    fn caches_the_system_choice_across_threads() {
        let selected = language();
        assert_eq!(std::thread::spawn(language).join().unwrap(), selected);
    }
}
