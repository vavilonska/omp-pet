// Bind to the launching process, never a title or the most recent terminal.
#[derive(Clone)]
pub struct OwnerWindow {
    pid: u32,
    created_at: u64,
    instance_id: String,
}

impl OwnerWindow {
    pub fn from_environment() -> Option<Self> {
        let pid = std::env::var("OMP_PET_OWNER_PID").ok()?.parse().ok()?;
        let instance_id = std::env::var("OMP_PET_RUNTIME_ID").ok()?
            .strip_prefix("session-")?.to_owned();
        Some(Self { pid, created_at: process_identity(pid).ok()?, instance_id })
    }

    pub fn focus(&self, bubble_id: &str) -> Result<(), String> {
        if !bubble_id.starts_with(&format!("{}:", self.instance_id)) {
            return Err("该气泡不属于此 OMP 进程".to_owned());
        }
        if process_identity(self.pid)? != self.created_at {
            return Err("对应 OMP 进程已退出".to_owned());
        }
        focus_console(self.pid)
    }
}

#[cfg(windows)]
fn process_identity(pid: u32) -> Result<u64, String> {
    use windows::Win32::{Foundation::{CloseHandle, FILETIME}, System::Threading::{OpenProcess, GetProcessTimes, GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION}};
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|e| e.to_string())?;
        let result = (|| {
            let mut code = 0;
            GetExitCodeProcess(process, &mut code).map_err(|e| e.to_string())?;
            if code != 259 { return Err("对应 OMP 进程已退出".to_owned()); }
            let (mut created, mut exit, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            GetProcessTimes(process, &mut created, &mut exit, &mut kernel, &mut user).map_err(|e| e.to_string())?;
            Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
        })();
        let _ = CloseHandle(process);
        result
    }
}

#[cfg(windows)]
fn focus_console(pid: u32) -> Result<(), String> {
    use windows::Win32::{System::Console::{AttachConsole, FreeConsole, GetConsoleWindow}, UI::WindowsAndMessaging::{GetAncestor, IsWindowVisible, IsIconic, ShowWindow, SetForegroundWindow, GA_ROOTOWNER, SW_RESTORE}};
    // Console attachment is process-wide. This command runs under the runtime mutex.
    unsafe {
        if !GetConsoleWindow().0.is_null() { return Err("宠物进程已有控制台，无法安全定位 OMP".to_owned()); }
        AttachConsole(pid).map_err(|_| "无法连接对应 OMP 的控制台".to_owned())?;
        let console = GetConsoleWindow();
        // Windows Terminal owns the pseudoconsole HWND; classic consoles own themselves.
        // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getancestor
        let window = GetAncestor(console, GA_ROOTOWNER);
        let result = if window.0.is_null() || !IsWindowVisible(window).as_bool() {
            Err("未找到对应 OMP 的可见终端窗口".to_owned())
        } else {
            if IsIconic(window).as_bool() { let _ = ShowWindow(window, SW_RESTORE); }
            if SetForegroundWindow(window).as_bool() { Ok(()) }
            else { Err("Windows 未允许切换到 OMP，请点击终端窗口".to_owned()) }
        };
        let _ = FreeConsole();
        result
    }
}

#[cfg(not(windows))]
fn process_identity(_pid: u32) -> Result<u64, String> { Err("当前系统不支持返回 OMP 窗口".to_owned()) }
#[cfg(not(windows))]
fn focus_console(_pid: u32) -> Result<(), String> { Err("当前系统不支持返回 OMP 窗口".to_owned()) }

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn rejects_unrelated_bubble_and_reused_pid_without_focusing() {
        let pid = std::process::id();
        let created_at = process_identity(pid).unwrap();
        let owner = OwnerWindow { pid, created_at, instance_id: "owner".to_owned() };
        assert!(owner.focus("another:session:completed:1").is_err());
        let stale = OwnerWindow { created_at: created_at + 1, ..owner };
        assert!(stale.focus("owner:session:completed:1").is_err());
    }
}
