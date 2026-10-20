use anyhow::{bail, ensure, Result};
use std::{
    mem, thread,
    time::{Duration, Instant},
};
use winapi::{
    shared::{
        minwindef::{BOOL, LPARAM, TRUE},
        windef::{HWND, RECT},
    },
    um::{
        wingdi::{SelectObject, HGDI_ERROR},
        winuser::{
            DrawTextW, EnumChildWindows, EnumWindows, GetClassNameW, GetClientRect, GetDC,
            GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
            PostMessageW, ReleaseDC, SendMessageW, DT_CALCRECT, DT_SINGLELINE, DT_WORDBREAK,
            WM_CLOSE, WM_GETFONT,
        },
    },
};

unsafe extern "system" fn collect_window(window: HWND, data: LPARAM) -> BOOL {
    let mut pid = 0;
    // SAFETY: EnumWindows/EnumChildWindows provides a live HWND and `data` points to
    // the caller's Vec for the duration of the synchronous enumeration.
    unsafe {
        GetWindowThreadProcessId(window, &mut pid);
        if pid == std::process::id() {
            (*(data as *mut Vec<HWND>)).push(window);
        }
    }
    TRUE
}

fn owned_windows() -> Vec<HWND> {
    let mut windows = Vec::new();
    // SAFETY: the callback only reads handles and writes into this live Vec.
    unsafe {
        EnumWindows(
            Some(collect_window),
            &mut windows as *mut Vec<HWND> as LPARAM,
        );
    }
    windows
}

pub fn children(window: HWND) -> Vec<HWND> {
    let mut windows = Vec::new();
    // SAFETY: `window` belongs to this test process and the Vec outlives enumeration.
    unsafe {
        EnumChildWindows(
            window,
            Some(collect_window),
            &mut windows as *mut Vec<HWND> as LPARAM,
        );
    }
    windows
}

pub fn window_text(window: HWND) -> String {
    // SAFETY: the live test window is queried synchronously into an owned UTF-16 buffer.
    unsafe {
        let mut buffer = vec![0; (GetWindowTextLengthW(window) + 1).max(1) as usize];
        let count = GetWindowTextW(window, buffer.as_mut_ptr(), buffer.len() as i32);
        String::from_utf16_lossy(&buffer[..count.max(0) as usize])
    }
}

fn class_name(window: HWND) -> String {
    let mut buffer = [0; 256];
    // SAFETY: the fixed buffer is writable and the handle belongs to this test process.
    let count = unsafe { GetClassNameW(window, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..count.max(0) as usize])
}

pub fn observe_window(
    expected_class: &'static str,
    inspect: impl FnOnce(HWND) -> Result<()> + Send + 'static,
) -> thread::JoinHandle<Result<()>> {
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            for window in owned_windows() {
                // SAFETY: the enumerated window is live and belongs only to this test binary.
                if class_name(window) != expected_class || unsafe { IsWindowVisible(window) } == 0 {
                    continue;
                }
                struct CloseWindow(HWND);
                impl Drop for CloseWindow {
                    fn drop(&mut self) {
                        // SAFETY: cancellation is posted only to the test's own native window.
                        unsafe {
                            PostMessageW(self.0, WM_CLOSE, 0, 0);
                        }
                    }
                }
                let _close = CloseWindow(window);
                return inspect(window);
            }
            if Instant::now() >= deadline {
                for window in owned_windows() {
                    // SAFETY: close any unexpected dialog in this test process, never another app.
                    unsafe {
                        PostMessageW(window, WM_CLOSE, 0, 0);
                    }
                }
                bail!("Native test window did not become ready: {expected_class}");
            }
            thread::sleep(Duration::from_millis(20));
        }
    })
}

pub fn assert_text_fits(window: HWND, multiline: bool) -> Result<()> {
    let text = window_text(window);
    let mut content = text.encode_utf16().collect::<Vec<_>>();
    // SAFETY: RECT is a plain integer struct for which every zeroed field is valid.
    let mut bounds: RECT = unsafe { mem::zeroed() };
    // SAFETY: the window, device context, font and UTF-16 buffer remain live during
    // synchronous GDI measurement. The selected font is restored before releasing the DC.
    unsafe {
        ensure!(
            GetClientRect(window, &mut bounds) != 0,
            "Missing control bounds"
        );
        let dc = GetDC(window);
        ensure!(!dc.is_null(), "Missing control DC");
        let font = SendMessageW(window, WM_GETFONT, 0, 0);
        let previous = SelectObject(dc, font as _);
        if previous.is_null() || previous == HGDI_ERROR {
            ReleaseDC(window, dc);
            bail!("Missing control font");
        }
        let mut measured = bounds;
        let flags = DT_CALCRECT
            | if multiline {
                DT_WORDBREAK
            } else {
                DT_SINGLELINE
            };
        let height = DrawTextW(
            dc,
            content.as_mut_ptr(),
            content.len() as i32,
            &mut measured,
            flags,
        );
        SelectObject(dc, previous);
        ReleaseDC(window, dc);
        ensure!(height != 0, "Text could not be measured: {text}");
        ensure!(
            measured.right - measured.left <= bounds.right - bounds.left
                && measured.bottom - measured.top <= bounds.bottom - bounds.top,
            "Clipped native control: {text}"
        );
    }
    Ok(())
}
