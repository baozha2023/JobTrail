#![windows_subsystem = "windows"]
use anyhow::{bail, Context, Result};
use jobtrail_bootstrap::*;
use std::{
    ffi::OsStr,
    fs, mem,
    os::windows::ffi::OsStrExt,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    ptr, thread,
};
use winapi::{
    shared::{
        minwindef::{DWORD, FALSE, LPARAM, LRESULT, TRUE, UINT, WPARAM},
        windef::{HFONT, HICON, HWND, RECT},
    },
    um::{
        commctrl::{
            InitCommonControlsEx, ICC_PROGRESS_CLASS, INITCOMMONCONTROLSEX, PBM_SETPOS,
            PBM_SETRANGE32, PBS_SMOOTH,
        },
        fileapi::GetDiskFreeSpaceExW,
        libloaderapi::GetModuleHandleW,
        wingdi::{
            CreateFontW, DeleteObject, SetBkMode, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS,
            DEFAULT_CHARSET, DEFAULT_PITCH, FF_DONTCARE, FW_NORMAL, OUT_DEFAULT_PRECIS,
            TRANSPARENT,
        },
        winnt::ULARGE_INTEGER,
        winuser::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnableWindow,
            GetDpiForSystem, GetMessageW, GetSysColorBrush, GetSystemMetrics, GetWindowLongPtrW,
            IsDialogMessageW, KillTimer, LoadCursorW, LoadImageW, MessageBoxW, MoveWindow,
            PostMessageW, PostQuitMessage, RegisterClassW, SendMessageW, SetTimer,
            SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow, TranslateMessage,
            UnregisterClassW, UpdateWindow, BS_DEFPUSHBUTTON, BS_PUSHBUTTON, COLOR_WINDOW,
            CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW, ES_AUTOHSCROLL, ES_LEFT, ES_READONLY,
            GWLP_USERDATA, IDC_ARROW, IMAGE_ICON, LR_DEFAULTSIZE, MAKEINTRESOURCEW, MB_ICONERROR,
            MB_OK, MSG, SM_CXSCREEN, SM_CYSCREEN, SS_ETCHEDHORZ, SS_LEFT, SWP_NOACTIVATE,
            SWP_NOZORDER, SW_HIDE, SW_SHOW, WM_APP, WM_CLOSE, WM_COMMAND, WM_CTLCOLORSTATIC,
            WM_DESTROY, WM_DPICHANGED, WM_NCCREATE, WM_SETFONT, WM_TIMER, WNDCLASSW, WS_CAPTION,
            WS_CHILD, WS_EX_CLIENTEDGE, WS_MINIMIZEBOX, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE,
        },
    },
};
const SETUP: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/setup.exe"));
const ROOT_LAUNCHER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/launcher.exe"));
const ROOT_UNINSTALLER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/uninstaller.exe"));

const WINDOW_WIDTH: i32 = 820;
const WINDOW_HEIGHT: i32 = 540;
const BASE_DPI: u32 = 96;
const BROWSE_BUTTON_ID: i32 = 1001;
const INSTALL_BUTTON_ID: i32 = 1;
const CANCEL_BUTTON_ID: i32 = 2;
const PROGRESS_TIMER_ID: usize = 1;
const FINISH_TIMER_ID: usize = 2;
const INSTALL_COMPLETE_MESSAGE: UINT = WM_APP + 1;

struct InstallerControls {
    heading: HWND,
    separator: HWND,
    description: HWND,
    target_label: HWND,
    path_edit: HWND,
    browse_button: HWND,
    required_label: HWND,
    available_label: HWND,
    progress_label: HWND,
    progress_bar: HWND,
    bottom_separator: HWND,
    version_label: HWND,
    install_button: HWND,
    cancel_button: HWND,
}

impl InstallerControls {
    fn empty() -> Self {
        Self {
            heading: ptr::null_mut(),
            separator: ptr::null_mut(),
            description: ptr::null_mut(),
            target_label: ptr::null_mut(),
            path_edit: ptr::null_mut(),
            browse_button: ptr::null_mut(),
            required_label: ptr::null_mut(),
            available_label: ptr::null_mut(),
            progress_label: ptr::null_mut(),
            progress_bar: ptr::null_mut(),
            bottom_separator: ptr::null_mut(),
            version_label: ptr::null_mut(),
            install_button: ptr::null_mut(),
            cancel_button: ptr::null_mut(),
        }
    }

    fn body(&self) -> [HWND; 13] {
        [
            self.separator,
            self.description,
            self.target_label,
            self.path_edit,
            self.browse_button,
            self.required_label,
            self.available_label,
            self.progress_label,
            self.progress_bar,
            self.bottom_separator,
            self.version_label,
            self.install_button,
            self.cancel_button,
        ]
    }

    fn selection_page(&self) -> [HWND; 8] {
        [
            self.description,
            self.target_label,
            self.path_edit,
            self.browse_button,
            self.required_label,
            self.available_label,
            self.install_button,
            self.cancel_button,
        ]
    }
}

struct InstallerWindow {
    selected_root: PathBuf,
    outcome: Option<PathBuf>,
    dpi: u32,
    controls: InstallerControls,
    normal_font: HFONT,
    heading_font: HFONT,
    installing: bool,
    progress: u32,
}

fn scale(value: i32, dpi: u32) -> i32 {
    ((i64::from(value) * i64::from(dpi) + i64::from(BASE_DPI / 2)) / i64::from(BASE_DPI)) as i32
}

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

fn payload_size() -> u64 {
    (SETUP.len() + ROOT_LAUNCHER.len() + ROOT_UNINSTALLER.len()) as u64
}

fn required_space() -> u64 {
    env!("JOBTRAIL_REQUIRED_SPACE_BYTES")
        .parse::<u64>()
        .unwrap_or(0)
        .max(payload_size())
}

fn format_size(bytes: u64) -> String {
    const MIB: f64 = 1024.0 * 1024.0;
    const GIB: f64 = 1024.0 * MIB;
    if bytes as f64 >= GIB {
        format!("{:.1} GB", bytes as f64 / GIB)
    } else {
        format!("{:.1} MB", bytes as f64 / MIB)
    }
}

fn next_progress(current: u32) -> u32 {
    match current {
        0..=24 => (current + 3).min(92),
        25..=64 => (current + 2).min(92),
        65..=91 => current + 1,
        _ => current,
    }
}

fn existing_ancestor(path: &Path) -> Option<&Path> {
    path.ancestors().find(|candidate| candidate.exists())
}

fn available_space(path: &Path) -> Option<u64> {
    let ancestor = existing_ancestor(path)?;
    let path = wide(ancestor.as_os_str());
    let mut available = 0_u64;
    // SAFETY: `path` is null-terminated and valid for this call. `available` has the same
    // size and alignment as the Windows ULARGE_INTEGER output value.
    let success = unsafe {
        GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available as *mut u64 as *mut ULARGE_INTEGER,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    (success != 0).then_some(available)
}

fn set_text(control: HWND, text: impl AsRef<OsStr>) {
    let text = wide(text);
    // SAFETY: `control` is a live window handle owned by this process and `text` is
    // null-terminated for the duration of the call.
    unsafe {
        SetWindowTextW(control, text.as_ptr());
    }
}

fn refresh_install_location(window: &mut InstallerWindow) {
    set_text(window.controls.path_edit, window.selected_root.as_os_str());
    let available = available_space(&window.selected_root);
    set_text(
        window.controls.available_label,
        available
            .map(|bytes| format!("可用空间：{}", format_size(bytes)))
            .unwrap_or_else(|| "可用空间：无法获取".to_owned()),
    );
    let enough_space = available.is_none_or(|bytes| bytes >= required_space());
    // SAFETY: `install_button` is a live button handle owned by this window.
    unsafe {
        EnableWindow(window.controls.install_button, enough_space.into());
    }
}

fn set_control_visible(control: HWND, visible: bool) {
    // SAFETY: `control` is a live child window owned by the installer window.
    unsafe {
        ShowWindow(control, if visible { SW_SHOW } else { SW_HIDE });
    }
}

fn set_progress(window: &mut InstallerWindow, value: u32, label: &str) {
    window.progress = value.min(100);
    set_text(window.controls.progress_label, label);
    // SAFETY: `progress_bar` is a live common-controls progress bar.
    unsafe {
        SendMessageW(
            window.controls.progress_bar,
            PBM_SETPOS,
            window.progress as WPARAM,
            0,
        );
    }
}

fn show_progress_page(window: &mut InstallerWindow, visible: bool) {
    for control in window.controls.selection_page() {
        set_control_visible(control, !visible);
    }
    set_control_visible(window.controls.progress_label, visible);
    set_control_visible(window.controls.progress_bar, visible);
    set_text(
        window.controls.heading,
        if visible {
            "正在安装职迹"
        } else {
            "选定安装位置"
        },
    );
}

fn start_install(hwnd: HWND, window: &mut InstallerWindow) -> Result<()> {
    validate_path(&window.selected_root)?;
    window.installing = true;
    show_progress_page(window, true);
    set_progress(window, 3, "正在准备安装文件…");
    // SAFETY: `hwnd` is the live installer window. The timer is stopped when installation
    // completes or the window is destroyed.
    unsafe {
        SetTimer(hwnd, PROGRESS_TIMER_ID, 80, None);
    }

    let root = window.selected_root.clone();
    let window_handle = hwnd as isize;
    thread::Builder::new()
        .name("jobtrail-installer".to_owned())
        .spawn(move || {
            let result = install(&root).map_err(|error| format!("{error:#}"));
            let result = Box::into_raw(Box::new(result));
            // SAFETY: the installer window cannot be closed while installation is active.
            // Ownership of `result` transfers to its window procedure when posting succeeds.
            let posted = unsafe {
                PostMessageW(
                    window_handle as HWND,
                    INSTALL_COMPLETE_MESSAGE,
                    0,
                    result as LPARAM,
                )
            };
            if posted == 0 {
                // SAFETY: message delivery failed, so ownership was not transferred.
                unsafe {
                    drop(Box::from_raw(result));
                }
            }
        })
        .context("无法启动安装任务")?;
    Ok(())
}

fn show_window_error(owner: HWND, error: &anyhow::Error) {
    let title = wide("无法使用该安装位置");
    let message = wide(format!("{error:#}"));
    // SAFETY: the owner handle is valid and both strings are null-terminated.
    unsafe {
        MessageBoxW(
            owner,
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

fn create_ui_font(logical_height: i32, dpi: u32) -> HFONT {
    let font_name = wide("Microsoft YaHei UI");
    // SAFETY: all arguments are value types and `font_name` is null-terminated for the call.
    unsafe {
        CreateFontW(
            -scale(logical_height, dpi),
            0,
            0,
            0,
            FW_NORMAL,
            FALSE as DWORD,
            FALSE as DWORD,
            FALSE as DWORD,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            DEFAULT_PITCH | FF_DONTCARE,
            font_name.as_ptr(),
        )
    }
}

fn apply_font(control: HWND, font: HFONT) {
    if control.is_null() || font.is_null() {
        return;
    }
    // SAFETY: both handles were created in this process and outlive this message.
    unsafe {
        SendMessageW(control, WM_SETFONT, font as WPARAM, TRUE as LPARAM);
    }
}

fn refresh_fonts(window: &mut InstallerWindow) {
    let normal_font = create_ui_font(16, window.dpi);
    let heading_font = create_ui_font(30, window.dpi);
    if normal_font.is_null() || heading_font.is_null() {
        // SAFETY: non-null font handles in this branch were just created by CreateFontW.
        unsafe {
            if !normal_font.is_null() {
                DeleteObject(normal_font as _);
            }
            if !heading_font.is_null() {
                DeleteObject(heading_font as _);
            }
        }
        return;
    }
    apply_font(window.controls.heading, heading_font);
    for control in window.controls.body() {
        apply_font(control, normal_font);
    }
    // SAFETY: old non-null font handles were created by CreateFontW and controls now reference
    // their replacements.
    unsafe {
        if !window.normal_font.is_null() {
            DeleteObject(window.normal_font as _);
        }
        if !window.heading_font.is_null() {
            DeleteObject(window.heading_font as _);
        }
    }
    window.normal_font = normal_font;
    window.heading_font = heading_font;
}

fn move_control(control: HWND, dpi: u32, x: i32, y: i32, width: i32, height: i32) {
    if control.is_null() {
        return;
    }
    // SAFETY: `control` is a live child window and all dimensions are finite scaled integers.
    unsafe {
        MoveWindow(
            control,
            scale(x, dpi),
            scale(y, dpi),
            scale(width, dpi),
            scale(height, dpi),
            TRUE,
        );
    }
}

fn layout_controls(window: &InstallerWindow) {
    let dpi = window.dpi;
    let controls = &window.controls;
    move_control(controls.heading, dpi, 48, 34, 500, 48);
    move_control(controls.separator, dpi, 48, 102, 716, 2);
    move_control(controls.description, dpi, 48, 128, 716, 62);
    move_control(controls.target_label, dpi, 72, 246, 100, 30);
    move_control(controls.path_edit, dpi, 176, 238, 390, 36);
    move_control(controls.browse_button, dpi, 582, 236, 150, 40);
    move_control(controls.required_label, dpi, 72, 300, 400, 30);
    move_control(controls.available_label, dpi, 72, 340, 400, 30);
    move_control(controls.progress_label, dpi, 72, 236, 680, 36);
    move_control(controls.progress_bar, dpi, 72, 292, 660, 30);
    move_control(controls.bottom_separator, dpi, 24, 430, 756, 2);
    move_control(controls.version_label, dpi, 48, 461, 300, 28);
    move_control(controls.install_button, dpi, 566, 452, 92, 38);
    move_control(controls.cancel_button, dpi, 674, 452, 92, 38);
}

unsafe extern "system" fn installer_window_proc(
    hwnd: HWND,
    message: UINT,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: Windows invokes this callback with valid message arguments. The state pointer is
    // installed during WM_NCCREATE and remains allocated until the message loop exits.
    unsafe {
        if message == WM_NCCREATE {
            let create = &*(lparam as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
            return TRUE as LRESULT;
        }
        let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut InstallerWindow;
        match message {
            WM_COMMAND if !state.is_null() => {
                let command = (wparam & 0xffff) as i32;
                let state = &mut *state;
                if state.installing {
                    return 0;
                }
                match command {
                    BROWSE_BUTTON_ID => {
                        let initial = state
                            .selected_root
                            .parent()
                            .unwrap_or(&state.selected_root)
                            .to_path_buf();
                        if let Some(parent) = rfd::FileDialog::new()
                            .set_title("选择安装父目录（将创建 JobTrail 文件夹）")
                            .set_directory(initial)
                            .pick_folder()
                        {
                            state.selected_root = parent.join("JobTrail");
                            refresh_install_location(state);
                        }
                    }
                    INSTALL_BUTTON_ID => {
                        if let Err(error) = start_install(hwnd, state) {
                            state.installing = false;
                            KillTimer(hwnd, PROGRESS_TIMER_ID);
                            show_progress_page(state, false);
                            refresh_install_location(state);
                            show_window_error(hwnd, &error);
                        }
                    }
                    CANCEL_BUTTON_ID => {
                        DestroyWindow(hwnd);
                    }
                    _ => {}
                }
                0
            }
            WM_TIMER if !state.is_null() => {
                let state = &mut *state;
                if wparam == PROGRESS_TIMER_ID && state.installing {
                    let progress = next_progress(state.progress);
                    let label = if progress < 35 {
                        "正在准备安装文件…"
                    } else if progress < 75 {
                        "正在写入程序文件…"
                    } else {
                        "正在完成安装配置…"
                    };
                    set_progress(state, progress, label);
                } else if wparam == FINISH_TIMER_ID {
                    KillTimer(hwnd, FINISH_TIMER_ID);
                    DestroyWindow(hwnd);
                }
                0
            }
            INSTALL_COMPLETE_MESSAGE if !state.is_null() => {
                let state = &mut *state;
                KillTimer(hwnd, PROGRESS_TIMER_ID);
                if lparam == 0 {
                    state.installing = false;
                    show_progress_page(state, false);
                    refresh_install_location(state);
                    return 0;
                }
                let result = *Box::from_raw(lparam as *mut std::result::Result<(), String>);
                match result {
                    Ok(()) => {
                        state.outcome = Some(state.selected_root.clone());
                        set_progress(state, 100, "安装完成");
                        SetTimer(hwnd, FINISH_TIMER_ID, 450, None);
                    }
                    Err(error) => {
                        state.installing = false;
                        set_progress(state, 0, "");
                        show_progress_page(state, false);
                        refresh_install_location(state);
                        let error = anyhow::anyhow!(error);
                        show_window_error(hwnd, &error);
                    }
                }
                0
            }
            WM_DPICHANGED if !state.is_null() => {
                let state = &mut *state;
                let new_dpi = ((wparam >> 16) & 0xffff) as u32;
                let suggested = &*(lparam as *const RECT);
                SetWindowPos(
                    hwnd,
                    ptr::null_mut(),
                    suggested.left,
                    suggested.top,
                    suggested.right - suggested.left,
                    suggested.bottom - suggested.top,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                );
                state.dpi = new_dpi.max(1);
                refresh_fonts(state);
                layout_controls(state);
                0
            }
            WM_CTLCOLORSTATIC => {
                SetBkMode(wparam as _, TRANSPARENT as i32);
                GetSysColorBrush(COLOR_WINDOW) as LRESULT
            }
            WM_CLOSE => {
                if state.is_null() || !(*state).installing {
                    DestroyWindow(hwnd);
                }
                0
            }
            WM_DESTROY => {
                KillTimer(hwnd, PROGRESS_TIMER_ID);
                KillTimer(hwnd, FINISH_TIMER_ID);
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn create_control(
    parent: HWND,
    instance: winapi::shared::minwindef::HINSTANCE,
    class_name: &str,
    text: &str,
    style: DWORD,
    extended_style: DWORD,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    id: i32,
) -> Result<HWND> {
    let class_name = wide(class_name);
    let text = wide(text);
    // SAFETY: the parent and instance belong to this process, strings are null-terminated, and
    // the control lifetime is managed by the parent window.
    let control = unsafe {
        CreateWindowExW(
            extended_style,
            class_name.as_ptr(),
            text.as_ptr(),
            style | WS_CHILD | WS_VISIBLE,
            x,
            y,
            width,
            height,
            parent,
            id as usize as _,
            instance,
            ptr::null_mut(),
        )
    };
    if control.is_null() {
        bail!("无法创建安装器控件");
    }
    Ok(control)
}

fn select_install_root(default_root: PathBuf) -> Result<Option<PathBuf>> {
    let class_name = wide("JobTrailInstallerWindow");
    let title = wide("职迹 安装");
    // SAFETY: all Win32 handles created below are owned by this function and remain live through
    // the message loop. Every pointer passed to Win32 is either null or points to live data.
    unsafe {
        let common_controls = INITCOMMONCONTROLSEX {
            dwSize: mem::size_of::<INITCOMMONCONTROLSEX>() as DWORD,
            dwICC: ICC_PROGRESS_CLASS,
        };
        if InitCommonControlsEx(&common_controls) == FALSE {
            bail!("无法初始化安装进度控件");
        }
        let instance = GetModuleHandleW(ptr::null());
        let icon = LoadImageW(
            instance as _,
            MAKEINTRESOURCEW(1),
            IMAGE_ICON,
            0,
            0,
            LR_DEFAULTSIZE,
        ) as HICON;
        let window_class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(installer_window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: icon,
            hCursor: LoadCursorW(ptr::null_mut(), IDC_ARROW),
            hbrBackground: GetSysColorBrush(COLOR_WINDOW),
            lpszMenuName: ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        if RegisterClassW(&window_class) == 0 {
            bail!("无法注册安装器窗口");
        }

        let initial_dpi = GetDpiForSystem().max(1);
        let state = Box::new(InstallerWindow {
            selected_root: default_root,
            outcome: None,
            dpi: initial_dpi,
            controls: InstallerControls::empty(),
            normal_font: ptr::null_mut(),
            heading_font: ptr::null_mut(),
            installing: false,
            progress: 0,
        });
        let state = Box::into_raw(state);
        let window_width = scale(WINDOW_WIDTH, initial_dpi);
        let window_height = scale(WINDOW_HEIGHT, initial_dpi);
        let left = (GetSystemMetrics(SM_CXSCREEN) - window_width).max(0) / 2;
        let top = (GetSystemMetrics(SM_CYSCREEN) - window_height).max(0) / 2;
        let window = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
            left,
            top,
            window_width,
            window_height,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            state.cast(),
        );
        if window.is_null() {
            drop(Box::from_raw(state));
            UnregisterClassW(class_name.as_ptr(), instance);
            bail!("无法创建安装器窗口");
        }

        let heading = create_control(
            window,
            instance,
            "STATIC",
            "选定安装位置",
            SS_LEFT,
            0,
            48,
            34,
            500,
            48,
            0,
        )?;
        let separator = create_control(
            window,
            instance,
            "STATIC",
            "",
            SS_ETCHEDHORZ,
            0,
            48,
            102,
            716,
            2,
            0,
        )?;
        let description = create_control(
            window,
            instance,
            "STATIC",
            "默认安装到下列文件夹。需要安装到其他磁盘时，可点击“更改安装位置”选择父目录，程序会自动创建 JobTrail 子目录。",
            SS_LEFT,
            0,
            48,
            128,
            716,
            62,
            0,
        )?;
        let target_label = create_control(
            window,
            instance,
            "STATIC",
            "目标文件夹",
            SS_LEFT,
            0,
            72,
            246,
            100,
            30,
            0,
        )?;
        let path_edit = create_control(
            window,
            instance,
            "EDIT",
            "",
            ES_LEFT | ES_AUTOHSCROLL | ES_READONLY,
            WS_EX_CLIENTEDGE,
            176,
            238,
            390,
            36,
            0,
        )?;
        let browse = create_control(
            window,
            instance,
            "BUTTON",
            "更改安装位置",
            BS_PUSHBUTTON | WS_TABSTOP,
            0,
            582,
            236,
            150,
            40,
            BROWSE_BUTTON_ID,
        )?;
        let required = create_control(
            window,
            instance,
            "STATIC",
            &format!("所需空间：约 {}", format_size(required_space())),
            SS_LEFT,
            0,
            72,
            300,
            400,
            30,
            0,
        )?;
        let available = create_control(
            window,
            instance,
            "STATIC",
            "可用空间：正在计算…",
            SS_LEFT,
            0,
            72,
            340,
            400,
            30,
            0,
        )?;
        let progress_label = create_control(
            window,
            instance,
            "STATIC",
            "正在准备安装文件…",
            SS_LEFT,
            0,
            72,
            236,
            680,
            36,
            0,
        )?;
        let progress_bar = create_control(
            window,
            instance,
            "msctls_progress32",
            "",
            PBS_SMOOTH,
            0,
            72,
            292,
            660,
            30,
            0,
        )?;
        let bottom_separator = create_control(
            window,
            instance,
            "STATIC",
            "",
            SS_ETCHEDHORZ,
            0,
            24,
            430,
            756,
            2,
            0,
        )?;
        let version = create_control(
            window,
            instance,
            "STATIC",
            &format!("当前版本  {}", env!("JOBTRAIL_VERSION")),
            SS_LEFT,
            0,
            48,
            461,
            300,
            28,
            0,
        )?;
        let install_button = create_control(
            window,
            instance,
            "BUTTON",
            "安装",
            BS_DEFPUSHBUTTON | WS_TABSTOP,
            0,
            566,
            452,
            92,
            38,
            INSTALL_BUTTON_ID,
        )?;
        let cancel_button = create_control(
            window,
            instance,
            "BUTTON",
            "取消",
            BS_PUSHBUTTON | WS_TABSTOP,
            0,
            674,
            452,
            92,
            38,
            CANCEL_BUTTON_ID,
        )?;

        (*state).controls = InstallerControls {
            heading,
            separator,
            description,
            target_label,
            path_edit,
            browse_button: browse,
            required_label: required,
            available_label: available,
            progress_label,
            progress_bar,
            bottom_separator,
            version_label: version,
            install_button,
            cancel_button,
        };
        SendMessageW(progress_bar, PBM_SETRANGE32, 0, 100);
        set_control_visible(progress_label, false);
        set_control_visible(progress_bar, false);
        refresh_fonts(&mut *state);
        layout_controls(&*state);
        refresh_install_location(&mut *state);

        ShowWindow(window, SW_SHOW);
        UpdateWindow(window);
        let mut message: MSG = mem::zeroed();
        while GetMessageW(&mut message, ptr::null_mut(), 0, 0) > 0 {
            if IsDialogMessageW(window, &mut message) == 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }

        let state = Box::from_raw(state);
        let outcome = state.outcome.clone();
        if !state.normal_font.is_null() {
            DeleteObject(state.normal_font as _);
        }
        if !state.heading_font.is_null() {
            DeleteObject(state.heading_font as _);
        }
        UnregisterClassW(class_name.as_ptr(), instance);
        Ok(outcome)
    }
}

fn install(root: &Path) -> Result<()> {
    if SETUP.is_empty() || ROOT_LAUNCHER.is_empty() || ROOT_UNINSTALLER.is_empty() {
        bail!("安装包没有有效载荷，请通过 release:win 构建");
    }
    validate_path(root)?;
    ensure_not_installed()?;
    if root.exists() {
        validate_tree(root)?;
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            let name = entry.file_name();
            let metadata = entry.metadata()?;
            let valid = if name == "config.json" {
                metadata.is_file()
            } else if name == "data" || name == "resumes" {
                metadata.is_dir()
            } else {
                false
            };
            if !valid {
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
    let root = dirs::data_local_dir()
        .context("无法定位当前用户目录")?
        .join("Programs")
        .join("JobTrail");
    let Some(root) = select_install_root(root)? else {
        return Ok(());
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_layout_for_common_windows_dpi_values() {
        assert_eq!(scale(820, 72), 615);
        assert_eq!(scale(820, 96), 820);
        assert_eq!(scale(820, 120), 1025);
        assert_eq!(scale(820, 144), 1230);
        assert_eq!(scale(820, 192), 1640);
    }

    #[test]
    fn formats_installer_sizes_for_display() {
        assert_eq!(format_size(576 * 1024 * 1024), "576.0 MB");
        assert_eq!(format_size(50 * 1024 * 1024 * 1024), "50.0 GB");
    }

    #[test]
    fn required_space_never_undercounts_embedded_payloads() {
        assert!(required_space() >= payload_size());
    }

    #[test]
    fn simulated_progress_never_finishes_before_real_install() {
        let mut progress = 3;
        for _ in 0..500 {
            progress = next_progress(progress);
        }
        assert_eq!(progress, 92);
        assert_eq!(next_progress(100), 100);
    }
}
