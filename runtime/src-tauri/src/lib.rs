mod models;
mod owner_window;
mod hit_region;
mod activity_window;
mod bubble_material;
mod paths;
mod reducer;
mod registry;
mod server;

use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use models::{EVENT_SOURCE, PROTOCOL_VERSION, RuntimeDescriptor, RuntimeSnapshot, RuntimeStatus};
use reducer::PetEventReducer;
use registry::PetRegistry;
use tauri::State;
use uuid::Uuid;

pub type SharedRuntime = Arc<Mutex<RuntimeStore>>;

pub struct RuntimeStore {
    registry: PetRegistry,
    reducer: PetEventReducer,
    visible: bool,
    debug_enabled: bool,
    client_seen: bool,
    port: u16,
    token: String,
    owner_window: Option<owner_window::OwnerWindow>,
}

impl RuntimeStore {
    fn snapshot(&mut self) -> RuntimeSnapshot {
        let state = self.reducer.state(now_ms());
        let selected_pet = self.registry.selected().map(|pet| pet.info.clone());
        let sprite_url = selected_pet.as_ref().map(|pet| {
            format!(
                "http://127.0.0.1:{}/v1/sprite/{}?token={}&revision={}",
                self.port, pet.id, self.token, pet.revision
            )
        });
        RuntimeSnapshot {
            state,
            selected_pet,
            sprite_url,
            debug_enabled: self.debug_enabled,
        }
    }

    fn status(&mut self) -> RuntimeStatus {
        let state = self.reducer.state(now_ms());
        let (clients, active_agents, active_tools, pending_approvals, background_jobs) =
            self.reducer.counts();
        RuntimeStatus {
            visible: self.visible,
            selected_pet_id: self.registry.selected_pet_id(),
            pets: self.registry.list(),
            events_enabled: self.reducer.events_enabled(),
            debug_enabled: self.debug_enabled,
            animation: state.animation,
            bubble: state.bubble,
            background_bubbles: state.background_bubbles,
            clients,
            active_agents,
            active_tools,
            pending_approvals,
            background_jobs,
        }
    }
}

#[tauri::command]
fn get_snapshot(runtime: State<'_, SharedRuntime>) -> Result<RuntimeSnapshot, String> {
    runtime
        .lock()
        .map_err(|_| "Runtime state is unavailable".to_owned())
        .map(|mut runtime| runtime.snapshot())
}

#[tauri::command]
fn focus_omp(runtime: State<'_, SharedRuntime>, bubble_id: String) -> Result<Option<String>, String> {
    let mut runtime = runtime.lock().map_err(|_| "Runtime state is unavailable".to_owned())?;
    if !runtime.reducer.dismiss_completed_bubble(&bubble_id, now_ms()) {
        return Err("该完成提示已过期".to_owned());
    }
    // A missing terminal or a Windows focus restriction must not prevent dismissal.
    Ok(runtime.owner_window.as_ref()
        .ok_or_else(|| "请重启 OMP 以关联终端窗口".to_owned())
        .and_then(|owner| owner.focus(&bubble_id))
        .err())
}

#[tauri::command]
async fn pet_control(app: tauri::AppHandle, runtime: State<'_, SharedRuntime>, request: models::ControlRequest) -> Result<serde_json::Value, String> {
    server::local_control(app, runtime.inner().clone(), request).await
}

pub fn run() {
    if let Err(error) = try_run() {
        eprintln!("OMP pet runtime failed: {error}");
    }
}

fn try_run() -> Result<(), String> {
    let data_root = paths::data_root()?;
    fs::create_dir_all(&data_root).map_err(|error| error.to_string())?;
    let (registry, config) = PetRegistry::load(data_root.clone())?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let token = format!("{}{}", Uuid::new_v4(), Uuid::new_v4());
    let runtime = Arc::new(Mutex::new(RuntimeStore {
        registry,
        reducer: PetEventReducer::new(config.events_enabled, now_ms()),
        visible: false,
        debug_enabled: config.debug_enabled,
        client_seen: false,
        port,
        token: token.clone(),
        owner_window: owner_window::OwnerWindow::from_environment(),
    }));
    let descriptor_path = paths::descriptor_path(&data_root)?;
    let descriptor = RuntimeDescriptor {
        protocol_version: PROTOCOL_VERSION,
        source: EVENT_SOURCE.to_owned(),
        pid: std::process::id(),
        port,
        token,
        started_at: now_ms(),
    };
    write_descriptor(&descriptor_path, &descriptor)?;

    let setup_runtime = runtime.clone();
    let builder = tauri::Builder::default()
        .manage(runtime.clone())
        .invoke_handler(tauri::generate_handler![get_snapshot, pet_control, focus_omp, hit_region::set_hit_regions, activity_window::resize_activity_window])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            bubble_material::install(&app_handle)?;
            let server_app = app_handle.clone();
            let tick_app = app_handle;
            let server_runtime = setup_runtime.clone();
            let tick_runtime = setup_runtime.clone();
            tauri::async_runtime::spawn(async move {
                match tokio::net::TcpListener::from_std(listener) {
                    Ok(listener) => {
                        if let Err(error) =
                            server::serve(listener, server_app, server_runtime).await
                        {
                            eprintln!("OMP pet local server stopped: {error}");
                        }
                    }
                    Err(error) => eprintln!("OMP pet listener failed: {error}"),
                }
            });
            tauri::async_runtime::spawn(server::emit_state_changes(tick_app, tick_runtime));
            Ok(())
        });

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            cleanup_descriptor(&descriptor_path);
            return Err(error.to_string());
        }
    };
    app.run(move |_app, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            cleanup_descriptor(&descriptor_path);
        }
    });
    Ok(())
}

fn write_descriptor(path: &Path, descriptor: &RuntimeDescriptor) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(descriptor).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn cleanup_descriptor(path: &PathBuf) {
    let belongs_to_this_process = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RuntimeDescriptor>(&bytes).ok())
        .is_some_and(|descriptor| descriptor.pid == std::process::id());
    if belongs_to_this_process {
        let _ = fs::remove_file(path);
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
