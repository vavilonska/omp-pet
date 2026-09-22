const MIN_HEIGHT: f64 = 224.0;

// Keep the pet's bottom anchored; only move it if a screen edge leaves too
// little room for the main bubble and a usable slice of the scrolling list.
fn fit_height(bottom: i32, work_top: i32, work_height: u32, desired: u32, minimum: u32) -> (i32, u32) {
    let minimum = minimum.min(work_height);
    let work_bottom = work_top + work_height as i32;
    let bottom = bottom.clamp(work_top + minimum as i32, work_bottom);
    let height = desired.max(minimum).min((bottom - work_top) as u32);
    (bottom - height as i32, height)
}

#[tauri::command]
pub fn resize_activity_window(window: tauri::WebviewWindow, height: f64, minimum_height: f64) -> Result<(), String> {
    if !height.is_finite() || !minimum_height.is_finite() || height < MIN_HEIGHT
        || height > 1_000_000.0 || minimum_height < MIN_HEIGHT || minimum_height > height {
        return Err("Invalid pet activity height".to_owned());
    }
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let bottom = position.y + size.height as i32;
    let monitor = window.monitor_from_point(
        position.x as f64 + size.width as f64 / 2.0,
        bottom as f64 - 8.0 * scale,
    ).map_err(|error| error.to_string())?
        .or(window.current_monitor().map_err(|error| error.to_string())?)
        .ok_or_else(|| "Pet monitor is unavailable".to_owned())?;
    let area = monitor.work_area();
    let (top, target_height) = fit_height(bottom, area.position.y, area.size.height,
        (height * scale).ceil() as u32, (minimum_height * scale).ceil() as u32);
    if top == position.y && target_height == size.height { return Ok(()); }

    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        // Change origin and height atomically so the bottom-anchored pet doesn't
        // jump between separate resize/move calls. Never steal keyboard focus.
        unsafe { SetWindowPos(hwnd, None, position.x, top, size.width as i32,
            target_height as i32, SWP_NOACTIVATE | SWP_NOZORDER) }
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(windows))]
    {
        window.set_size(tauri::PhysicalSize::new(size.width, target_height)).map_err(|error| error.to_string())?;
        window.set_position(tauri::PhysicalPosition::new(position.x, top)).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grow_and_shrink_without_moving_pet() {
        assert_eq!(fit_height(1000, 0, 1040, 820, 412), (180, 820));
        assert_eq!(fit_height(1000, 0, 1040, 332, 332), (668, 332));
    }

    #[test]
    fn tall_lists_stop_at_work_area_top() {
        assert_eq!(fit_height(1000, 40, 1000, 3000, 412), (40, 960));
    }

    #[test]
    fn near_top_moves_only_enough_to_keep_scroll_area_usable() {
        assert_eq!(fit_height(240, 40, 1000, 900, 412), (40, 412));
    }

    #[test]
    fn scaled_and_negative_monitor_coordinates() {
        assert_eq!(fit_height(-50, -1200, 1200, 1500, 515), (-1200, 1150));
        assert_eq!(fit_height(1350, 0, 1300, 800, 515), (500, 800));
        assert_eq!(fit_height(200, 0, 200, 500, 412), (0, 200));
    }
}
