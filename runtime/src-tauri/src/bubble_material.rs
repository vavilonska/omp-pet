// Keep the transparent WebView free of cached native chrome. The rounded
// translucent surface is drawn once in CSS; no rectangular backdrop HWND.
#[cfg(windows)]
mod platform {
    use tauri::Manager;
    use windows::Win32::{Foundation::{HWND, LPARAM, LRESULT, WPARAM}, UI::{WindowsAndMessaging::*, Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass}}};

    const FRAME_SUBCLASS: usize = 0x504554;

    fn suppress_compositor_outline(hwnd: HWND) {
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR,
            DWMWA_COLOR_NONE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND};
        unsafe {
            // DWM's own rectangular outline is independent of WS_CAPTION and
            // our shaped region. CSS owns every visible edge of these windows.
            // These attributes are optional on pre-Windows-11 systems.
            let _ = DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR,
                (&DWMWA_COLOR_NONE as *const u32).cast(), std::mem::size_of::<u32>() as u32);
            let _ = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
                (&DWMWCP_DONOTROUND.0 as *const i32).cast(), std::mem::size_of::<i32>() as u32);
        }
    }

    unsafe fn clear_native_surface(hwnd: HWND) {
        use windows::Win32::Graphics::Gdi::{GetDC, PatBlt, ReleaseDC, BLACKNESS};
        unsafe {
            let mut client = windows::Win32::Foundation::RECT::default();
            if GetClientRect(hwnd, &mut client).is_ok() {
                let dc = GetDC(Some(hwnd));
                if !dc.0.is_null() {
                    // The transparent DWM surface needs zeroed pixels below
                    // the separately composited WebView, not cached GDI chrome.
                    let _ = PatBlt(dc, 0, 0, client.right, client.bottom, BLACKNESS);
                    let _ = ReleaseDC(Some(hwnd), dc);
                }
            }
        }
    }

    unsafe extern "system" fn keep_frameless(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, id: usize, _reference: usize) -> LRESULT {
        unsafe {
            if message == WM_STYLECHANGING && lparam.0 != 0 {
                let style = &mut *(lparam.0 as *mut STYLESTRUCT);
                if wparam.0 as i32 == GWL_STYLE.0 {
                    style.styleNew &= !(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX).0;
                } else if wparam.0 as i32 == GWL_EXSTYLE.0 {
                    style.styleNew &= !(WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE | WS_EX_DLGMODALFRAME).0;
                }
            } else if message == WM_NCDESTROY {
                let _ = RemoveWindowSubclass(hwnd, Some(keep_frameless), id);
            }
            let result = DefSubclassProc(hwnd, message, wparam, lparam);
            if matches!(message, WM_NCACTIVATE | WM_THEMECHANGED | WM_DWMCOMPOSITIONCHANGED) {
                suppress_compositor_outline(hwnd);
            }
            if matches!(message, WM_NCPAINT | WM_NCACTIVATE | WM_ACTIVATE | WM_SETFOCUS | WM_SHOWWINDOW | WM_SETTEXT | WM_SETICON | WM_WINDOWPOSCHANGED) {
                clear_native_surface(hwnd);
            }
            result
        }
    }

    fn install_frame_guard(hwnd: HWND) -> Result<(), String> {
        // Filter style changes before Windows can paint a caption into the
        // transparent backing surface; removing it afterwards is too late.
        if !unsafe { SetWindowSubclass(hwnd, Some(keep_frameless), FRAME_SUBCLASS, 0) }.as_bool() {
            return Err("Could not protect the transparent window frame".to_owned());
        }
        remove_native_frame(hwnd)?;
        suppress_compositor_outline(hwnd);
        Ok(())
    }

    pub fn remove_native_frame(hwnd: HWND) -> Result<bool, String> {
        let mut changed = false;
        unsafe {
            // Tao keeps WS_CAPTION on undecorated top-level windows. Region
            // redraws can expose that title/icon beneath a transparent WebView.
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            let clean = style & !(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX).0;
            let extended = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            let clean_extended = extended & !(WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE | WS_EX_DLGMODALFRAME).0;
            if style != clean || extended != clean_extended {
                changed = true;
                SetWindowLongW(hwnd, GWL_STYLE, clean as i32);
                SetWindowLongW(hwnd, GWL_EXSTYLE, clean_extended as i32);
                SetWindowPos(hwnd, None, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(changed)
    }

    pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
        let main = app.get_webview_window("main").ok_or("Pet window missing")?;
        install_frame_guard(main.hwnd().map_err(|error| error.to_string())?)?;
        let handle = app.clone();
        main.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_)) {
                if let Err(error) = sync(&handle) { eprintln!("Could not restore transparent window frame: {error}"); }
            }
        });
        Ok(())
    }

    pub fn sync(app: &tauri::AppHandle) -> Result<(), String> {
        let Some(main) = app.get_webview_window("main") else { return Ok(()); };
        let hwnd = main.hwnd().map_err(|error| error.to_string())?;
        if remove_native_frame(hwnd)? {
            // Windows can discard SetWindowRgn when frame styles change on
            // hide/show. Reapply even when the DOM layout hasn't changed.
            crate::hit_region::restore_front_region(hwnd)?;
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use platform::*;

#[cfg(not(windows))]
pub fn install(_: &tauri::AppHandle) -> Result<(), String> { Ok(()) }
#[cfg(not(windows))]
pub fn sync(_: &tauri::AppHandle) -> Result<(), String> { Ok(()) }
