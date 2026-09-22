use std::{collections::HashMap, path::PathBuf, time::Duration};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use tauri::{Emitter, Manager};

use crate::{
    SharedRuntime,
    models::{ControlRequest, EventBatch, PROTOCOL_VERSION},
    now_ms,
};

#[derive(Clone)]
struct ServerState {
    app: tauri::AppHandle,
    runtime: SharedRuntime,
}

pub async fn serve(
    listener: tokio::net::TcpListener,
    app: tauri::AppHandle,
    runtime: SharedRuntime,
) -> Result<(), String> {
    let state = ServerState { app, runtime };
    let router = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/status", get(status))
        .route("/v1/control", post(control))
        .route("/v1/events", post(events))
        .route("/v1/sprite/{pet_id}", get(sprite))
        .with_state(state);
    axum::serve(listener, router)
        .await
        .map_err(|error| error.to_string())
}

pub async fn emit_state_changes(app: tauri::AppHandle, runtime: SharedRuntime) {
    let mut last_state = None;
    loop {
        tokio::time::sleep(Duration::from_millis(40)).await;
        let (state, owner_gone) = {
            let mut runtime = match runtime.lock() {
                Ok(runtime) => runtime,
                Err(_) => return,
            };
            let state = runtime.reducer.state(now_ms());
            let clients = runtime.reducer.counts().0;
            if clients > 0 {
                runtime.client_seen = true;
            }
            (state, runtime.client_seen && clients == 0)
        };
        if owner_gone {
            app.exit(0);
            return;
        }
        if last_state.as_ref() != Some(&state) {
            let _ = app.emit("pet://state", &state);
            last_state = Some(state);
        }
    }
}

async fn health(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, None, &state.runtime) {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    json_ok(
        "OMP pet runtime is ready",
        json!({ "protocolVersion": PROTOCOL_VERSION }),
    )
}

async fn status(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, None, &state.runtime) {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let data = match state.runtime.lock() {
        Ok(mut runtime) => runtime.status(),
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Runtime state is unavailable",
            );
        }
    };
    json_ok("OMP pet status", data)
}

async fn events(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(batch): Json<EventBatch>,
) -> Response {
    if !authorized(&headers, None, &state.runtime) {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    if batch.protocol_version != PROTOCOL_VERSION {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Unsupported event protocol version",
        );
    }
    if batch.events.len() > 256 {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Event batches are limited to 256 items",
        );
    }

    let current_time = now_ms();
    let (accepted, pet_state) = {
        let mut runtime = match state.runtime.lock() {
            Ok(runtime) => runtime,
            Err(_) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Runtime state is unavailable",
                );
            }
        };
        let mut accepted = 0usize;
        for mut event in batch.events {
            if event.timestamp.abs_diff(current_time) > 60_000 {
                event.timestamp = current_time;
            }
            match runtime.reducer.apply(&event) {
                Ok(()) => accepted += 1,
                Err(message) => return json_error(StatusCode::BAD_REQUEST, &message),
            }
        }
        let pet_state = runtime.reducer.state(current_time);
        (accepted, pet_state)
    };
    let _ = state.app.emit("pet://state", &pet_state);
    json_ok("OMP events accepted", json!({ "accepted": accepted }))
}

async fn control(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(request): Json<ControlRequest>,
) -> Response {
    if !authorized(&headers, None, &state.runtime) {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }

    control_impl(state, request).await
}

// The renderer invokes this through Tauri IPC. HTTP callers still require bearer auth.
pub async fn local_control(app: tauri::AppHandle, runtime: SharedRuntime, request: ControlRequest) -> Result<Value, String> {
    if !matches!(request.action.as_str(), "show" | "hide" | "previous" | "next" | "play") {
        return Err("Unsupported pet menu action".to_owned());
    }
    let response = control_impl(ServerState { app, runtime }, request).await;
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024).await.map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if value["ok"] != true { return Err(value["message"].as_str().unwrap_or("Pet action failed").to_owned()); }
    Ok(value)
}

async fn control_impl(state: ServerState, request: ControlRequest) -> Response {
    let window = state.app.get_webview_window("main");
    let mut emit_selected = false;
    let mut emit_debug = None;
    let mut should_stop = false;
    let message;

    {
        let mut runtime = match state.runtime.lock() {
            Ok(runtime) => runtime,
            Err(_) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Runtime state is unavailable",
                );
            }
        };
        match request.action.as_str() {
            "show" => {
                let Some(window) = &window else {
                    return json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Pet window is unavailable",
                    );
                };
                if let Err(error) = window.show() {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
                }
                let _ = window.set_focus();
                if !runtime.visible { let _ = state.app.emit("pet://shown", ()); }
                runtime.visible = true;
                let _ = crate::bubble_material::sync(&state.app);
                message = if runtime.registry.selected().is_some() {
                    "OMP pet shown".to_owned()
                } else {
                    "OMP pet frame shown; no pet is installed yet".to_owned()
                };
            }
            "hide" => {
                if let Some(window) = &window {
                    if let Err(error) = window.hide() {
                        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
                    }
                }
                runtime.visible = false;
                let _ = crate::bubble_material::sync(&state.app);
                message = "OMP pet hidden".to_owned();
            }
            "stop" => {
                if let Some(window) = &window {
                    let _ = window.hide();
                }
                runtime.visible = false;
                let _ = crate::bubble_material::sync(&state.app);
                should_stop = true;
                message = "OMP pet runtime stopped".to_owned();
            }
            "select" => {
                let Some(id) = request.pet_id.as_deref() else {
                    return json_error(StatusCode::BAD_REQUEST, "petId is required");
                };
                if let Err(error) = runtime.registry.select(id) {
                    return json_error(StatusCode::NOT_FOUND, &error);
                }
                let events_enabled = runtime.reducer.events_enabled();
                let debug_enabled = runtime.debug_enabled;
                if let Err(error) = runtime.registry.save_config(events_enabled, debug_enabled) {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
                }
                emit_selected = true;
                message = format!("Selected OMP pet '{id}'");
            }
            "next" | "previous" => {
                let offset = if request.action == "next" { 1 } else { -1 };
                if let Err(error) = runtime.registry.select_relative(offset) {
                    return json_error(StatusCode::CONFLICT, &error);
                }
                let events_enabled = runtime.reducer.events_enabled();
                let debug_enabled = runtime.debug_enabled;
                if let Err(error) = runtime.registry.save_config(events_enabled, debug_enabled) {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
                }
                emit_selected = true;
                message = format!(
                    "Selected OMP pet '{}'",
                    runtime.registry.selected_pet_id().unwrap_or_default()
                );
            }
            "events" => {
                let Some(enabled) = request.enabled else {
                    return json_error(StatusCode::BAD_REQUEST, "enabled is required");
                };
                runtime.reducer.set_events_enabled(enabled);
                let debug_enabled = runtime.debug_enabled;
                if let Err(error) = runtime.registry.save_config(enabled, debug_enabled) {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
                }
                message = format!(
                    "OMP event animations {}",
                    if enabled { "enabled" } else { "disabled" }
                );
            }
            "debug" => {
                let Some(enabled) = request.enabled else {
                    return json_error(StatusCode::BAD_REQUEST, "enabled is required");
                };
                runtime.debug_enabled = enabled;
                let events_enabled = runtime.reducer.events_enabled();
                if let Err(error) = runtime.registry.save_config(events_enabled, enabled) {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
                }
                emit_debug = Some(enabled);
                message = format!(
                    "OMP pet debug overlay {}",
                    if enabled { "enabled" } else { "disabled" }
                );
            }
            "play" => {
                let Some(animation) = request.animation else {
                    return json_error(StatusCode::BAD_REQUEST, "animation is required");
                };
                if !matches!(
                    animation.as_str(),
                    "idle"
                        | "running-right"
                        | "running-left"
                        | "waving"
                        | "jumping"
                        | "failed"
                        | "waiting"
                        | "running"
                        | "review"
                ) {
                    return json_error(StatusCode::BAD_REQUEST, "Unknown animation");
                }
                runtime.reducer.set_manual(animation.clone(), now_ms());
                message = format!("Playing '{animation}'");
            }
            "import" => {
                let Some(path) = request.path else {
                    return json_error(StatusCode::BAD_REQUEST, "path is required");
                };
                let id = match runtime.registry.import(&PathBuf::from(path), request.force) {
                    Ok(id) => id,
                    Err(error) => return json_error(StatusCode::BAD_REQUEST, &error),
                };
                let events_enabled = runtime.reducer.events_enabled();
                let debug_enabled = runtime.debug_enabled;
                if let Err(error) = runtime.registry.save_config(events_enabled, debug_enabled) {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
                }
                emit_selected = true;
                message = format!("Imported and selected OMP pet '{id}'");
            }
            "doctor" => {
                message = format!(
                    "Runtime healthy on 127.0.0.1:{}; {} compatible pet(s) installed; protocol v{}",
                    runtime.port,
                    runtime.registry.list().len(),
                    PROTOCOL_VERSION
                );
            }
            _ => return json_error(StatusCode::BAD_REQUEST, "Unknown control action"),
        }
    }

    if emit_selected {
        let snapshot = match state.runtime.lock() {
            Ok(mut runtime) => runtime.snapshot(),
            Err(_) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Runtime state is unavailable",
                );
            }
        };
        let _ = state.app.emit("pet://selected", &snapshot);
    }
    if let Some(enabled) = emit_debug {
        let _ = state.app.emit("pet://debug", enabled);
    }

    let data = match state.runtime.lock() {
        Ok(mut runtime) => runtime.status(),
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Runtime state is unavailable",
            );
        }
    };
    if should_stop {
        let app = state.app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            app.exit(0);
        });
    }
    json_ok(&message, data)
}

async fn sprite(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(pet_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(
        &headers,
        query.get("token").map(String::as_str),
        &state.runtime,
    ) {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let path = {
        let runtime = match state.runtime.lock() {
            Ok(runtime) => runtime,
            Err(_) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Runtime state is unavailable",
                );
            }
        };
        let Some(pet) = runtime.registry.by_id(&pet_id) else {
            return json_error(StatusCode::NOT_FOUND, "Pet is not installed");
        };
        pet.spritesheet.clone()
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };
    let content_type = match path.extension().and_then(|value| value.to_str()) {
        Some("webp") => "image/webp",
        Some("jpg" | "jpeg") => "image/jpeg",
        _ => "image/png",
    };
    let mut response = Body::from(bytes).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    response
}

fn authorized(headers: &HeaderMap, query_token: Option<&str>, runtime: &SharedRuntime) -> bool {
    let expected = match runtime.lock() {
        Ok(runtime) => runtime.token.clone(),
        Err(_) => return false,
    };
    if query_token == Some(expected.as_str()) {
        return true;
    }
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == format!("Bearer {expected}"))
}

fn json_ok(message: &str, data: impl serde::Serialize) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "message": message, "data": data })),
    )
        .into_response()
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json::<Value>(json!({ "ok": false, "message": message })),
    )
        .into_response()
}
