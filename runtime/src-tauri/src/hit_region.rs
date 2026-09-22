use serde::Deserialize;

#[cfg(windows)]
static LAST_FRONT_REGIONS: std::sync::Mutex<Vec<HitRect>> = std::sync::Mutex::new(Vec::new());

#[derive(Clone, Copy, Deserialize)]
pub struct HitRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    #[serde(default)]
    radius: i32,
    #[serde(default)]
    clip: Option<ClipRect>,
}

#[derive(Clone, Copy, Deserialize)]
struct ClipRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[tauri::command]
pub fn set_hit_regions(window: tauri::WebviewWindow, rects: Vec<HitRect>) -> Result<(), String> {
    if rects.len() > 256 {
        return Err("Too many pet hit regions".to_owned());
    }
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        *LAST_FRONT_REGIONS.lock().map_err(|error| error.to_string())? = rects.clone();
        crate::bubble_material::remove_native_frame(hwnd)?;
        apply_region(hwnd, &rects)?;
    }
    #[cfg(not(windows))]
    let _ = (window, rects);
    Ok(())
}

#[cfg(windows)]
pub fn restore_front_region(hwnd: windows::Win32::Foundation::HWND) -> Result<(), String> {
    let rects = LAST_FRONT_REGIONS.lock().map_err(|error| error.to_string())?.clone();
    apply_region(hwnd, &rects)
}

#[cfg(windows)]
pub fn apply_region(hwnd: windows::Win32::Foundation::HWND, rects: &[HitRect]) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::{DeleteObject, SetWindowRgn};
    let region = build_region(rects)?;
    unsafe {
        if SetWindowRgn(hwnd, Some(region), true) == 0 {
            let _ = DeleteObject(region.into());
            return Err("Could not apply pet window region".to_owned());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn build_region(rects: &[HitRect]) -> Result<windows::Win32::Graphics::Gdi::HRGN, String> {
    use windows::Win32::Graphics::Gdi::{CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, RGN_AND, RGN_OR};
    unsafe {
        let region = CreateRectRgn(0, 0, 0, 0);
        if region.0.is_null() {
            return Err("Could not create pet window region".to_owned());
        }
        for rect in rects {
            if rect.right <= rect.left || rect.bottom <= rect.top {
                continue;
            }
            let radius = rect.radius.max(0).min((rect.right - rect.left) / 2).min((rect.bottom - rect.top) / 2);
            // GDI's binary ellipse clips partially covered CSS pixels,
            // especially near arc/straight tangents. Dilate the shape by two
            // physical pixels, then clip back to the original card bounds.
            // CSS alone draws the visible edge; blank outer corners stay out.
            let fringe = 2;
            let part = if radius > 0 {
                CreateRoundRectRgn(rect.left - fringe, rect.top - fringe,
                    rect.right + fringe + 1, rect.bottom + fringe + 1,
                    (radius + fringe) * 2, (radius + fringe) * 2)
            } else {
                CreateRectRgn(rect.left, rect.top, rect.right, rect.bottom)
            };
            if part.0.is_null() {
                let _ = DeleteObject(region.into());
                return Err("Could not create pet hit rectangle".to_owned());
            }
            let clip = rect.clip.unwrap_or(ClipRect { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
            let left = rect.left.max(clip.left);
            let top = rect.top.max(clip.top);
            let right = rect.right.min(clip.right).max(left);
            let bottom = rect.bottom.min(clip.bottom).max(top);
            let clipping = CreateRectRgn(left, top, right, bottom);
            if clipping.0.is_null() {
                let _ = DeleteObject(part.into());
                let _ = DeleteObject(region.into());
                return Err("Could not create pet region clip".to_owned());
            }
            let clipped = CombineRgn(Some(part), Some(part), Some(clipping), RGN_AND);
            let _ = DeleteObject(clipping.into());
            if clipped.0 == 0 {
                let _ = DeleteObject(part.into());
                let _ = DeleteObject(region.into());
                return Err("Could not clip pet hit region".to_owned());
            }
            let result = CombineRgn(Some(region), Some(region), Some(part), RGN_OR);
            let _ = DeleteObject(part.into());
            if result.0 == 0 {
                let _ = DeleteObject(region.into());
                return Err("Could not combine pet hit rectangles".to_owned());
            }
        }
        Ok(region)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Gdi::{DeleteObject, PtInRegion};

    #[test]
    fn native_region_excludes_blank_top_and_gaps_but_keeps_pet_and_bubbles() {
        let region = build_region(&[
            HitRect {
                left: 8,
                top: 100,
                right: 224,
                bottom: 150,
                radius: 0, clip: None,
            },
            HitRect {
                left: 8,
                top: 180,
                right: 224,
                bottom: 250,
                radius: 0, clip: None,
            },
            HitRect {
                left: 20,
                top: 272,
                right: 212,
                bottom: 480,
                radius: 0, clip: None,
            },
        ])
        .unwrap();
        unsafe {
            assert!(!PtInRegion(region, 100, 50).as_bool());
            assert!(PtInRegion(region, 100, 120).as_bool());
            assert!(!PtInRegion(region, 100, 165).as_bool());
            assert!(!PtInRegion(region, 100, 260).as_bool());
            assert!(PtInRegion(region, 100, 200).as_bool());
            assert!(PtInRegion(region, 100, 350).as_bool());
            let _ = DeleteObject(region.into());
        }
    }

    #[test]
    fn native_clip_preserves_css_arc_fringe_and_tangent_pixels() {
        // Radii cover the main/child cards at common Windows display scales,
        // at both their compact height and after multiline expansion.
        for radius in [17, 21, 25, 32, 40, 48, 64] {
            for height in [radius * 2, radius * 2 + 47] {
                let card = HitRect { left: 8, top: 8, right: 288,
                    bottom: 8 + height, radius, clip: None };
                let region = build_region(&[card]).unwrap();
                unsafe {
                    for x in 0..radius {
                        for y in 0..radius {
                            let dx = f64::from(x) + 0.5 - f64::from(radius);
                            let dy = f64::from(y) + 0.5 - f64::from(radius);
                            let distance = dx.hypot(dy);
                            // Pixel squares within half their diagonal of
                            // the ideal CSS arc may contribute antialiasing.
                            if distance < f64::from(radius) - 1.5 || distance > f64::from(radius) + 0.5_f64.sqrt() {
                                continue;
                            }
                            for px in [card.left + x, card.right - 1 - x] {
                                for py in [card.top + y, card.bottom - 1 - y] {
                                    assert!(PtInRegion(region, px, py).as_bool(),
                                        "CSS edge pixel clipped: radius={radius}, height={height}, x={px}, y={py}");
                                }
                            }
                        }
                    }
                    assert!(!PtInRegion(region, card.left, card.top).as_bool());
                    assert!(!PtInRegion(region, card.right - 1, card.bottom - 1).as_bool());
                    assert!(!PtInRegion(region, card.left - 1, card.top + radius).as_bool());
                    let _ = DeleteObject(region.into());
                }
            }
        }
    }

    #[test]
    fn empty_region_is_fully_click_through() {
        let region = build_region(&[]).unwrap();
        unsafe {
            assert!(!PtInRegion(region, 0, 0).as_bool());
            assert!(!PtInRegion(region, 100, 200).as_bool());
            let _ = DeleteObject(region.into());
        }
    }

    #[test]
    fn removed_bubble_does_not_leave_a_stale_native_hit_area() {
        let region = build_region(&[HitRect {
            left: 20,
            top: 272,
            right: 212,
            bottom: 480,
            radius: 0, clip: None,
        }])
        .unwrap();
        unsafe {
            assert!(!PtInRegion(region, 100, 200).as_bool());
            assert!(PtInRegion(region, 100, 350).as_bool());
            let _ = DeleteObject(region.into());
        }
    }

    #[test]
    fn rounded_bubble_excludes_corner_residue_without_cutting_body_or_tail() {
        let region = build_region(&[
            HitRect { left: 8, top: 8, right: 288, bottom: 136, radius: 18, clip: None },
            HitRect { left: 140, top: 134, right: 156, bottom: 145, radius: 0, clip: None },
        ]).unwrap();
        unsafe {
            assert!(!PtInRegion(region, 9, 9).as_bool());
            // Check the empty corner outside the two-pixel AA guard band.
            assert!(!PtInRegion(region, 11, 11).as_bool());
            assert!(!PtInRegion(region, 286, 9).as_bool());
            assert!(PtInRegion(region, 26, 8).as_bool());
            assert!(PtInRegion(region, 8, 26).as_bool());
            assert!(PtInRegion(region, 148, 80).as_bool());
            assert!(PtInRegion(region, 148, 143).as_bool());
            let _ = DeleteObject(region.into());
        }
    }

    #[test]
    fn scrolling_clips_original_rounded_shape_without_new_corners() {
        let region = build_region(&[HitRect {
            left: 8, top: -40, right: 288, bottom: 180, radius: 18,
            clip: Some(ClipRect { left: 8, top: 8, right: 288, bottom: 100 }),
        }]).unwrap();
        unsafe {
            assert!(!PtInRegion(region, 8, 7).as_bool());
            assert!(PtInRegion(region, 8, 8).as_bool());
            assert!(PtInRegion(region, 8, 99).as_bool());
            assert!(!PtInRegion(region, 100, 100).as_bool());
            let _ = DeleteObject(region.into());
        }
    }

}
