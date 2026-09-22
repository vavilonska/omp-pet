use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::models::{
    EVENT_SOURCE, EffectivePetState, PROTOCOL_VERSION, PetBubble, PetEventEnvelope,
};

const CLIENT_TIMEOUT_MS: u64 = 15_000;
const FAILED_DURATION_MS: u64 = 3_660;
const REVIEW_DURATION_MS: u64 = 3_090;
const RUNNING_CYCLE_MS: u64 = 2_460;
const WAITING_CYCLE_MS: u64 = 3_030;

#[derive(Clone)]
struct ActiveOperation {
    title: String,
    detail: Option<String>,
    started_at: u64,
    background: bool,
}

struct BubbleSpec {
    operation: ActiveOperation,
    kind: String,
    duration_ms: Option<u64>,
}

#[derive(Default)]
struct ClientState {
    last_seen: u64,
    active_agent: bool,
    completed_at: Option<u64>,
    dismissed_completed_at: Option<u64>,
    intent: Option<ActiveOperation>,
    active_tools: HashMap<String, ActiveOperation>,
    background_jobs: HashMap<String, ActiveOperation>,
    pending_approvals: HashSet<String>,
    last_sequence: u64,
}

pub struct PetEventReducer {
    clients: HashMap<String, ClientState>,
    failed_until: u64,
    review_until: u64,
    running_until: u64,
    waiting_until: u64,
    manual: Option<(String, u64)>,
    bubble: Option<PetBubble>,
    bubble_owner: Option<String>,
    events_enabled: bool,
    last_state: EffectivePetState,
}

impl PetEventReducer {
    pub fn new(events_enabled: bool, now: u64) -> Self {
        Self {
            clients: HashMap::new(),
            failed_until: 0,
            review_until: 0,
            running_until: 0,
            waiting_until: 0,
            manual: None,
            bubble: None,
            bubble_owner: None,
            events_enabled,
            last_state: EffectivePetState {
                animation: "idle".to_owned(),
                changed_at: now,
                reason: "initial".to_owned(),
                bubble: None,
                background_bubbles: Vec::new(),
            },
        }
    }

    pub fn events_enabled(&self) -> bool {
        self.events_enabled
    }

    pub fn dismiss_completed_bubble(&mut self, bubble_id: &str, now: u64) -> bool {
        if !self.state(now).bubble.is_some_and(|b| b.kind == "completed" && b.id == bubble_id) {
            return false;
        }
        let Some(client) = self.bubble_owner.as_ref().and_then(|owner| self.clients.get_mut(owner)) else {
            return false;
        };
        // Keep the acknowledgement separate: idle snapshots resend completedAt.
        client.dismissed_completed_at = client.completed_at;
        self.bubble = None;
        self.bubble_owner = None;
        true
    }

    pub fn set_events_enabled(&mut self, enabled: bool) {
        self.events_enabled = enabled;
        if !enabled {
            self.failed_until = 0;
            self.review_until = 0;
            self.running_until = 0;
            self.waiting_until = 0;
            self.bubble = None;
            for client in self.clients.values_mut() {
                client.active_agent = false;
                client.completed_at = None;
                client.active_tools.clear();
                client.background_jobs.clear();
                client.pending_approvals.clear();
            }
        }
    }

    pub fn set_manual(&mut self, animation: String, now: u64) {
        let duration_ms = match animation.as_str() {
            "running" => RUNNING_CYCLE_MS,
            "waiting" => WAITING_CYCLE_MS,
            "failed" => FAILED_DURATION_MS,
            "review" => REVIEW_DURATION_MS,
            "waving" => 2_100,
            "jumping" => 2_520,
            "running-left" | "running-right" => 3_180,
            _ => 6_600,
        };
        self.manual = Some((animation, now.saturating_add(duration_ms)));
    }

    pub fn apply(&mut self, event: &PetEventEnvelope) -> Result<(), String> {
        if event.protocol_version != PROTOCOL_VERSION || event.source != EVENT_SOURCE {
            return Err("Event protocol or source is not supported".to_owned());
        }
        if event.instance_id.is_empty() || event.session_id.is_empty() {
            return Err("Event instanceId and sessionId are required".to_owned());
        }
        if !self.events_enabled && !event.event_type.starts_with("client.") {
            return Ok(());
        }

        let key = format!("{}:{}", event.instance_id, event.session_id);
        if event.event_type == "client.snapshot" {
            let prefix = format!("{}:", event.instance_id);
            self.clients.retain(|owner, _| !owner.starts_with(&prefix) || owner == &key);
        }
        if event.event_type == "client.goodbye" {
            self.clients.remove(&key);
            return Ok(());
        }

        let tool_call_id = event
            .payload
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let tool_operation = operation_from_event(event);
        let mut bubble: Option<BubbleSpec> = None;
        let mut needs_latest = false;
        let mut approval_resolved = false;
        let mut bubble_owner = key.clone();

        {
            let client = self.clients.entry(key.clone()).or_default();
            if event.sequence <= client.last_sequence {
                return Ok(());
            }
            client.last_sequence = event.sequence;
            client.last_seen = event.timestamp;

            match event.event_type.as_str() {
                "agent.started" => {
                    client.completed_at = None;
                    client.active_agent = true;
                    client.intent = Some(ActiveOperation { title: "OMP 正在处理".to_owned(), detail: Some("正在处理任务".to_owned()), started_at: event.timestamp, background: false });
                    self.running_until = self
                        .running_until
                        .max(event.timestamp.saturating_add(RUNNING_CYCLE_MS));
                    self.review_until = 0;
                    if self.bubble.is_none() || self.bubble_owner.as_deref() == Some(key.as_str()) {
                        bubble = Some(BubbleSpec {
                            operation: ActiveOperation {
                                title: "OMP 正在处理".to_owned(),
                                detail: Some("准备任务…".to_owned()),
                                started_at: event.timestamp,
                                background: false,
                            },
                            kind: "info".to_owned(),
                            duration_ms: None,
                        });
                    }
                }
                "agent.completed" => {
                    client.completed_at = Some(event.timestamp);
                    client.active_agent = false;
                    client.active_tools.clear();
                    client.pending_approvals.clear();
                    self.running_until = 0;
                    self.review_until = self
                        .review_until
                        .max(event.timestamp.saturating_add(REVIEW_DURATION_MS));
                    if self.bubble_owner.as_deref() == Some(key.as_str())
                        && self.bubble.as_ref().is_some_and(|b| b.kind != "error") {
                        self.bubble = None;
                    }
                }
                "tool.started" => {
                    client
                        .active_tools
                        .insert(tool_call_id, tool_operation.clone());
                    self.running_until = self
                        .running_until
                        .max(event.timestamp.saturating_add(RUNNING_CYCLE_MS));
                    bubble = Some(BubbleSpec {
                        operation: tool_operation,
                        kind: "tool".to_owned(),
                        duration_ms: None,
                    });
                }
                "tool.completed" => {
                    client.active_tools.remove(&tool_call_id);
                    needs_latest = true;
                }
                "tool.failed" => {
                    client.active_tools.remove(&tool_call_id);
                    self.failed_until = self
                        .failed_until
                        .max(event.timestamp.saturating_add(FAILED_DURATION_MS));
                    bubble = Some(BubbleSpec {
                        operation: ActiveOperation {
                            title: "步骤失败".to_owned(),
                            detail: Some(tool_operation.title),
                            started_at: event.timestamp,
                            background: false,
                        },
                        kind: "error".to_owned(),
                        duration_ms: Some(3_000),
                    });
                }
                "approval.requested" => {
                    client.pending_approvals.insert(tool_call_id);
                    self.waiting_until = self
                        .waiting_until
                        .max(event.timestamp.saturating_add(WAITING_CYCLE_MS));
                    bubble = Some(BubbleSpec {
                        operation: ActiveOperation {
                            title: "需要批准".to_owned(),
                            detail: Some(tool_operation.title),
                            started_at: tool_operation.started_at,
                            background: false,
                        },
                        kind: "approval".to_owned(),
                        duration_ms: None,
                    });
                }
                "approval.resolved" => {
                    client.pending_approvals.remove(&tool_call_id);
                    approval_resolved = true;
                    let approved = event
                        .payload
                        .get("approved")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    bubble = Some(BubbleSpec {
                        operation: ActiveOperation {
                            title: if approved {
                                "已批准，继续执行".to_owned()
                            } else {
                                "操作未获批准".to_owned()
                            },
                            detail: None,
                            started_at: event.timestamp,
                            background: false,
                        },
                        kind: if approved { "success" } else { "error" }.to_owned(),
                        duration_ms: Some(2_400),
                    });
                }
                "retry.started" => {
                    self.failed_until = self
                        .failed_until
                        .max(event.timestamp.saturating_add(FAILED_DURATION_MS));
                    bubble = Some(BubbleSpec {
                        operation: ActiveOperation {
                            title: "正在重试".to_owned(),
                            detail: payload_line(&event.payload, "detail", 220),
                            started_at: event.timestamp,
                            background: false,
                        },
                        kind: "retry".to_owned(),
                        duration_ms: None,
                    });
                }
                "background.snapshot" => {
                    let previous_job_ids = client
                        .background_jobs
                        .keys()
                        .cloned()
                        .collect::<HashSet<_>>();
                    client.background_jobs =
                        parse_background_jobs(event.payload.get("jobs"), event.timestamp);
                    if client
                        .background_jobs
                        .keys()
                        .any(|id| !previous_job_ids.contains(id))
                    {
                        self.running_until = self
                            .running_until
                            .max(event.timestamp.saturating_add(RUNNING_CYCLE_MS));
                    }
                    // Background jobs have a separate visual stack and never replace the main bubble.
                }
                "client.snapshot" => {
                    if self.events_enabled {
                        client.active_agent = event.payload.get("active").and_then(Value::as_bool).unwrap_or(false);
                        client.completed_at = if client.active_agent { None } else {
                            event.payload.get("completedAt").and_then(Value::as_u64).filter(|v| *v > 0)
                        };
                        client.intent = Some(tool_operation.clone());
                        client.active_tools = parse_operations(event.payload.get("tools"), event.timestamp);
                        client.pending_approvals = parse_operations(event.payload.get("approvals"), event.timestamp).into_keys().collect();
                        client.background_jobs = parse_background_jobs(event.payload.get("jobs"), event.timestamp);
                        if self.bubble_owner.as_deref() == Some(key.as_str()) && self.bubble.as_ref().is_some_and(|b| b.expires_at.is_none()) {
                            self.bubble = None;
                        }
                    }
                }
                "client.hello" | "client.heartbeat" => {}
                _ => return Err(format!("Unsupported event type: {}", event.event_type)),
            }
        }

        if event.event_type == "agent.completed"
            && !self
                .clients
                .values()
                .any(|client| !client.pending_approvals.is_empty())
        {
            self.waiting_until = 0;
        }
        if needs_latest {
            if let Some((owner, latest)) = self.latest_active_bubble() {
                bubble_owner = owner;
                bubble = Some(latest);
            }
        }
        if approval_resolved
            && self
                .clients
                .values()
                .any(|client| !client.pending_approvals.is_empty())
        {
            bubble_owner = self
                .clients
                .iter()
                .find(|(_, client)| !client.pending_approvals.is_empty())
                .map(|(owner, _)| owner.clone())
                .unwrap_or(bubble_owner);
            bubble = Some(BubbleSpec {
                operation: ActiveOperation {
                    title: "仍有操作等待批准".to_owned(),
                    detail: None,
                    started_at: event.timestamp,
                    background: false,
                },
                kind: "approval".to_owned(),
                duration_ms: None,
            });
        }
        if let Some(bubble) = bubble {
            self.show_bubble(event, bubble);
            self.bubble_owner = Some(bubble_owner);
        }
        Ok(())
    }

    pub fn state(&mut self, now: u64) -> EffectivePetState {
        self.clients
            .retain(|_, client| now.saturating_sub(client.last_seen) <= CLIENT_TIMEOUT_MS);
        if self.manual.as_ref().is_some_and(|(_, until)| *until <= now) {
            self.manual = None;
        }
        if self
            .bubble
            .as_ref()
            .and_then(|bubble| bubble.expires_at)
            .is_some_and(|expires_at| expires_at <= now)
        {
            self.bubble = None;
        }

        if self.bubble_owner.as_ref().is_some_and(|owner| !self.clients.contains_key(owner)) {
            self.bubble = None;
            self.bubble_owner = None;
        }
        if self.bubble.as_ref().is_some_and(|b| b.kind == "completed") && self.active_fallback().is_some() {
            self.bubble = None;
        }
        if self.events_enabled && self.bubble.is_none() {
            if let Some((owner, spec)) = self.active_fallback() {
                self.bubble = Some(PetBubble {
                    id: format!("{owner}:active:{}:{}", spec.kind, spec.operation.started_at),
                    title: spec.operation.title, detail: spec.operation.detail, kind: spec.kind,
                    changed_at: now, expires_at: None, started_at: Some(spec.operation.started_at), background: false,
                });
                self.bubble_owner = Some(owner);
            }
            if self.bubble.is_none() {
                if let Some((owner, completed_at)) = self.clients.iter()
                    .filter(|(_, c)| c.completed_at != c.dismissed_completed_at)
                    .filter_map(|(owner, c)| c.completed_at.map(|at| (owner.clone(), at)))
                    .max_by_key(|(_, at)| *at) {
                    self.bubble = Some(PetBubble {
                        id: format!("{owner}:completed:{completed_at}"), title: "已完成".to_owned(),
                        detail: Some("点击返回 OMP 并关闭提示".to_owned()), kind: "completed".to_owned(),
                        changed_at: completed_at, expires_at: None, started_at: None, background: false,
                    });
                    self.bubble_owner = Some(owner);
                }
            }
        }

        let (animation, reason) = if let Some((animation, until)) = &self.manual {
            if *until > now {
                (animation.clone(), "manual".to_owned())
            } else {
                ("idle".to_owned(), "idle".to_owned())
            }
        } else if self.events_enabled && self.failed_until > now {
            ("failed".to_owned(), "recent failure".to_owned())
        } else if self.events_enabled && self.waiting_until > now {
            ("waiting".to_owned(), "approval pending".to_owned())
        } else if self.events_enabled && self.running_until > now {
            ("running".to_owned(), "OMP work active".to_owned())
        } else if self.events_enabled && self.review_until > now {
            ("review".to_owned(), "OMP work completed".to_owned())
        } else {
            ("idle".to_owned(), "idle".to_owned())
        };

        let bubble = self.bubble.clone();
        let background_bubbles = self.background_bubbles();
        if animation != self.last_state.animation
            || reason != self.last_state.reason
            || bubble != self.last_state.bubble
            || background_bubbles != self.last_state.background_bubbles
        {
            self.last_state = EffectivePetState {
                animation,
                changed_at: now,
                reason,
                bubble,
                background_bubbles,
            };
        }
        self.last_state.clone()
    }

    fn show_bubble(&mut self, event: &PetEventEnvelope, spec: BubbleSpec) {
        self.bubble = Some(PetBubble {
            id: format!(
                "{}:{}:{}",
                event.instance_id, event.session_id, event.sequence
            ),
            title: spec.operation.title,
            detail: spec.operation.detail,
            kind: spec.kind,
            changed_at: event.timestamp,
            expires_at: spec
                .duration_ms
                .map(|duration| event.timestamp.saturating_add(duration)),
            started_at: Some(spec.operation.started_at),
            background: spec.operation.background,
        });
    }

    fn latest_active_bubble(&self) -> Option<(String, BubbleSpec)> {
        self.clients
            .iter()
            .flat_map(|(owner, client)| {
                client
                    .active_tools
                    .values()
                    .map(move |operation| (owner, operation))
            })
            .max_by_key(|(_, operation)| operation.started_at)
            .map(|(owner, operation)| {
                (
                    owner.clone(),
                    BubbleSpec {
                        operation: operation.clone(),
                        kind: "tool".to_owned(),
                        duration_ms: None,
                    },
                )
            })
    }

    fn active_fallback(&self) -> Option<(String, BubbleSpec)> {
        if let Some((owner, client)) = self.clients.iter().find(|(_, c)| !c.pending_approvals.is_empty()) {
            return Some((owner.clone(), BubbleSpec { operation: ActiveOperation {
                title: "需要批准".to_owned(), detail: None,
                started_at: client.intent.as_ref().map(|v| v.started_at).unwrap_or(client.last_seen), background: false,
            }, kind: "approval".to_owned(), duration_ms: None }));
        }
        self.latest_active_bubble().or_else(|| self.clients.iter().filter(|(_, c)| c.active_agent)
            .max_by_key(|(_, c)| c.last_seen).map(|(owner, client)| (owner.clone(), BubbleSpec {
                operation: client.intent.clone().unwrap_or(ActiveOperation { title: "OMP 正在处理".to_owned(), detail: None, started_at: client.last_seen, background: false }),
                kind: "info".to_owned(), duration_ms: None,
            })))
    }

    fn background_bubbles(&self) -> Vec<PetBubble> {
        let mut bubbles = self
            .clients
            .iter()
            .flat_map(|(client_key, client)| {
                client
                    .background_jobs
                    .iter()
                    .map(move |(job_id, operation)| PetBubble {
                        id: format!("{client_key}:background:{job_id}"),
                        title: operation.title.clone(),
                        detail: operation.detail.clone(),
                        kind: "tool".to_owned(),
                        changed_at: operation.started_at,
                        expires_at: None,
                        started_at: Some(operation.started_at),
                        background: true,
                    })
            })
            .collect::<Vec<_>>();
        bubbles.sort_by(|left, right| left.started_at.cmp(&right.started_at).then_with(|| left.id.cmp(&right.id)));
        bubbles
    }

    pub fn counts(&self) -> (usize, usize, usize, usize, usize) {
        let clients = self.clients.len();
        let active_agents = self
            .clients
            .values()
            .filter(|client| client.active_agent)
            .count();
        let active_tools = self
            .clients
            .values()
            .map(|client| client.active_tools.len())
            .sum();
        let pending_approvals = self
            .clients
            .values()
            .map(|client| client.pending_approvals.len())
            .sum();
        let background_jobs = self
            .clients
            .values()
            .map(|client| client.background_jobs.len())
            .sum();
        (
            clients,
            active_agents,
            active_tools,
            pending_approvals,
            background_jobs,
        )
    }
}

fn safe_line(value: &str, max: usize) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    let characters = normalized.chars().collect::<Vec<_>>();
    if characters.len() > max {
        Some(format!(
            "{}…",
            characters[..max.saturating_sub(1)]
                .iter()
                .collect::<String>()
        ))
    } else {
        Some(normalized)
    }
}

fn payload_line(payload: &Value, key: &str, max: usize) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .and_then(|value| safe_line(value, max))
}

fn operation_from_event(event: &PetEventEnvelope) -> ActiveOperation {
    let tool_name = event
        .payload
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    ActiveOperation {
        title: payload_line(&event.payload, "title", 80)
            .unwrap_or_else(|| describe_tool_action(tool_name)),
        detail: payload_line(&event.payload, "detail", 220),
        started_at: event
            .payload
            .get("startedAt")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .unwrap_or(event.timestamp),
        background: event
            .payload
            .get("background")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn parse_operations(value: Option<&Value>, now: u64) -> HashMap<String, ActiveOperation> {
    let mut result = HashMap::new();
    if let Some(items) = value.and_then(Value::as_array) {
        for item in items.iter().take(64) {
            if let Some(id) = payload_line(item, "id", 160) {
                result.insert(id, ActiveOperation {
                    title: payload_line(item, "title", 80).unwrap_or_else(|| "正在执行工具".to_owned()),
                    detail: payload_line(item, "detail", 220),
                    started_at: item.get("startedAt").and_then(Value::as_u64).unwrap_or(now), background: false,
                });
            }
        }
    }
    result
}

fn parse_background_jobs(value: Option<&Value>, fallback: u64) -> HashMap<String, ActiveOperation> {
    let mut jobs = HashMap::new();
    let Some(items) = value.and_then(Value::as_array) else {
        return jobs;
    };
    for item in items {
        let Some(id) = item
            .get("id")
            .and_then(Value::as_str)
            .and_then(|value| safe_line(value, 80))
        else {
            continue;
        };
        let job_type = item
            .get("type")
            .and_then(Value::as_str)
            .and_then(|value| safe_line(value, 24))
            .unwrap_or_else(|| "task".to_owned());
        jobs.insert(
            id,
            ActiveOperation {
                title: item
                    .get("title")
                    .and_then(Value::as_str)
                    .and_then(|value| safe_line(value, 80))
                    .unwrap_or_else(|| "后台任务".to_owned()),
                detail: Some(format!("后台 {job_type} 任务")),
                started_at: item
                    .get("startedAt")
                    .and_then(Value::as_u64)
                    .filter(|value| *value > 0)
                    .unwrap_or(fallback),
                background: true,
            },
        );
    }
    jobs
}

fn describe_tool_action(tool_name: &str) -> String {
    match tool_name.trim().to_ascii_lowercase().as_str() {
        "read" => "正在读取文件",
        "bash" | "shell" | "exec" => "正在运行命令",
        "edit" => "正在编辑文件",
        "write" => "正在写入文件",
        "grep" => "正在搜索工作区",
        "glob" => "正在查找文件",
        "lsp" => "正在检查代码",
        "python" | "eval" => "正在运行代码",
        "notebook" => "正在更新 Notebook",
        "inspect_image" => "正在查看图片",
        "browser" => "正在使用浏览器",
        "computer" => "正在操作桌面",
        "task" => "正在运行子任务",
        "todo" => "正在更新任务列表",
        "web_search" => "正在搜索网页",
        "ask" => "正在等待回答",
        _ => "正在使用工具",
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::PetEventReducer;
    use crate::models::PetEventEnvelope;

    fn event(sequence: u64, event_type: &str, payload: serde_json::Value) -> PetEventEnvelope {
        PetEventEnvelope {
            protocol_version: 1,
            source: "omp".to_owned(),
            instance_id: "test-instance".to_owned(),
            session_id: "test-session".to_owned(),
            sequence,
            timestamp: sequence * 10,
            event_type: event_type.to_owned(),
            payload,
        }
    }

    #[test]
    fn equal_time_background_jobs_keep_stable_order() {
        let mut reducer = PetEventReducer::new(true, 0);
        for sequence in 1..=100 {
            let ids = if sequence % 2 == 0 { vec!["b", "a", "c"] } else { vec!["c", "a", "b"] };
            let jobs: Vec<_> = ids.iter().map(|id| json!({"id":id,"title":id,"startedAt":1})).collect();
            reducer.apply(&event(sequence, "background.snapshot", json!({"jobs":jobs}))).unwrap();
            let state = reducer.state(sequence * 10 + 1);
            assert_eq!(state.background_bubbles.iter().map(|b| b.title.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
        }
    }

    #[test]
    fn completed_snapshot_survives_reconnect_and_clears_on_session_switch() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer.apply(&event(1, "agent.started", json!({}))).unwrap();
        reducer.apply(&event(2, "agent.completed", json!({}))).unwrap();
        let done = reducer.state(21).bubble;
        assert_eq!(done.as_ref().unwrap().kind, "completed");
        reducer.apply(&event(6000, "client.snapshot", json!({"active":false,"completedAt":20}))).unwrap();
        assert_eq!(reducer.state(60001).bubble, done);
        let mut restarted = PetEventReducer::new(true, 60000);
        restarted.apply(&event(6000, "client.snapshot", json!({"active":false,"completedAt":20}))).unwrap();
        assert_eq!(restarted.state(60001).bubble, done);
        let mut switched = event(6001, "client.snapshot", json!({"active":false}));
        switched.session_id = "another-session".to_owned();
        restarted.apply(&switched).unwrap();
        assert!(restarted.state(60011).bubble.is_none());
    }

    #[test]
    fn expired_feedback_restores_active_work() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer.apply(&event(1, "agent.started", json!({}))).unwrap();
        reducer.apply(&event(2, "tool.failed", json!({"toolCallId":"a"}))).unwrap();
        let restored = reducer.state(3020).bubble.unwrap();
        assert_eq!(restored.kind, "info");
        assert_eq!(restored.expires_at, None);
        reducer.apply(&event(303, "tool.started", json!({"toolCallId":"a","title":"still working"}))).unwrap();
        reducer.apply(&event(304, "approval.resolved", json!({"toolCallId":"b","approved":true}))).unwrap();
        assert_eq!(reducer.state(5440).bubble.unwrap().title, "still working");
    }

    #[test]
    fn dismissed_completion_stays_hidden_through_snapshots_and_preserves_background_work() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer.apply(&event(1, "agent.started", json!({}))).unwrap();
        reducer.apply(&event(2, "agent.completed", json!({}))).unwrap();
        let done = reducer.state(21).bubble.unwrap();
        assert!(reducer.dismiss_completed_bubble(&done.id, 22));
        assert!(reducer.state(23).bubble.is_none());
        reducer.apply(&event(3, "client.snapshot", json!({"active":false,"completedAt":20,
            "jobs":[{"id":"job","title":"background work","startedAt":10}]}))).unwrap();
        assert!(reducer.state(31).bubble.is_none());
        assert_eq!(reducer.state(31).background_bubbles.len(), 1);
        assert!(!reducer.dismiss_completed_bubble(&done.id, 32));
        reducer.apply(&event(4, "agent.started", json!({}))).unwrap();
        assert_eq!(reducer.state(41).bubble.unwrap().kind, "info");
        reducer.apply(&event(5, "agent.completed", json!({}))).unwrap();
        let next = reducer.state(51).bubble.unwrap();
        assert_eq!(next.kind, "completed");
        assert_ne!(next.id, done.id);
        assert!(!reducer.dismiss_completed_bubble(&done.id, 52));
        assert_eq!(reducer.state(53).bubble.unwrap(), next);
        assert!(reducer.dismiss_completed_bubble(&next.id, 54));
    }

    #[test]
    fn completion_dismissal_rejects_active_work_and_preserves_other_clients() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer.apply(&event(1, "agent.started", json!({}))).unwrap();
        let active = reducer.state(11).bubble.unwrap();
        assert!(!reducer.dismiss_completed_bubble(&active.id, 12));
        assert_eq!(reducer.state(13).bubble.unwrap(), active);
        reducer.apply(&event(2, "agent.completed", json!({}))).unwrap();
        let first = reducer.state(21).bubble.unwrap();
        let mut other = event(3, "client.snapshot", json!({"active":false,"completedAt":30}));
        other.instance_id = "other".to_owned();
        reducer.apply(&other).unwrap();
        assert!(reducer.dismiss_completed_bubble(&first.id, 31));
        assert_eq!(reducer.state(32).bubble.unwrap().id, "other:test-session:completed:30");
    }

    #[test]
    fn snapshots_recover_and_replace_session_activity() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer.apply(&event(1, "client.snapshot", json!({"active":true,"title":"generating","startedAt":1}))).unwrap();
        assert_eq!(reducer.state(10).bubble.unwrap().title, "generating");
        let mut next = event(2, "client.snapshot", json!({"active":false}));
        next.session_id = "new-session".to_owned();
        reducer.apply(&next).unwrap();
        assert!(reducer.state(20).bubble.is_none());
        assert_eq!(reducer.counts().0, 1);
    }

    #[test]
    fn completion_expires_final_intent_at_end_of_review() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer
            .apply(&event(1, "agent.started", json!({})))
            .unwrap();
        reducer
            .apply(&event(
                2,
                "tool.started",
                json!({"toolCallId": "tool", "title": "运行测试"}),
            ))
            .unwrap();
        reducer
            .apply(&event(3, "tool.completed", json!({"toolCallId": "tool"})))
            .unwrap();
        reducer
            .apply(&event(4, "agent.completed", json!({})))
            .unwrap();
        let reviewing = reducer.state(2_539);
        assert_eq!(reviewing.animation, "review");
        let bubble = reviewing.bubble.unwrap();
        assert_eq!(bubble.title, "已完成");
        assert_eq!(bubble.started_at, None);
        assert_eq!(bubble.expires_at, None);
        let settled = reducer.state(2_540);
        assert_eq!(settled.animation, "review");
        assert_eq!(settled.bubble.unwrap().kind, "completed");
        assert_eq!(reducer.state(3_140).animation, "idle");
    }

    #[test]
    fn new_turn_replaces_old_intent_and_review() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer
            .apply(&event(
                1,
                "tool.started",
                json!({"toolCallId": "old", "title": "旧任务"}),
            ))
            .unwrap();
        reducer
            .apply(&event(2, "agent.completed", json!({})))
            .unwrap();
        reducer
            .apply(&event(3, "agent.started", json!({})))
            .unwrap();
        let state = reducer.state(2_490);
        assert_eq!(state.animation, "idle");
        let bubble = state.bubble.unwrap();
        assert_eq!(bubble.title, "OMP 正在处理");
        assert_eq!(bubble.expires_at, None);
    }

    #[test]
    fn completion_clears_approval_pulse_but_preserves_background_jobs() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer
            .apply(&event(
                1,
                "approval.requested",
                json!({"toolCallId": "approval"}),
            ))
            .unwrap();
        reducer
            .apply(&event(
                2,
                "background.snapshot",
                json!({"jobs": [{"id": "job", "title": "后台任务"}]}),
            ))
            .unwrap();
        reducer
            .apply(&event(3, "agent.completed", json!({})))
            .unwrap();
        assert_eq!(reducer.state(31).animation, "review");
        let state = reducer.state(3_120);
        assert_eq!(state.animation, "idle");
        assert_eq!(state.bubble.unwrap().kind, "completed");
        assert_eq!(state.background_bubbles.len(), 1);
        assert_eq!(reducer.counts().3, 0);
        assert_eq!(reducer.counts().4, 1);
    }

    #[test]
    fn completion_preserves_bounded_failure_feedback() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer
            .apply(&event(1, "tool.failed", json!({"toolCallId": "failed"})))
            .unwrap();
        reducer
            .apply(&event(2, "agent.completed", json!({})))
            .unwrap();
        let state = reducer.state(30);
        assert_eq!(state.animation, "failed");
        let bubble = state.bubble.unwrap();
        assert_eq!(bubble.kind, "error");
        assert_eq!(bubble.expires_at, Some(3_010));
        let settled = reducer.state(3_670);
        assert_eq!(settled.animation, "idle");
        assert_eq!(settled.bubble.unwrap().kind, "completed");
    }

    #[test]
    fn another_clients_tool_or_approval_survives_completion_and_restart() {
        for event_type in ["tool.started", "approval.requested"] {
            let mut reducer = PetEventReducer::new(true, 0);
            reducer
                .apply(&event(1, "agent.started", json!({})))
                .unwrap();
            let mut other = event(
                2,
                event_type,
                json!({"toolCallId": "other", "title": "另一任务"}),
            );
            other.instance_id = "other-client".to_owned();
            reducer.apply(&other).unwrap();
            let active = reducer.state(21).bubble;
            reducer
                .apply(&event(3, "agent.completed", json!({})))
                .unwrap();
            reducer
                .apply(&event(4, "agent.started", json!({})))
                .unwrap();
            assert_eq!(reducer.state(5_000).bubble, active);
            assert_eq!(active.unwrap().expires_at, None);
        }
    }

    #[test]
    fn tool_handoff_retains_actual_owner_after_other_client_completion() {
        let mut reducer = PetEventReducer::new(true, 0);
        let mut other = event(
            1,
            "tool.started",
            json!({"toolCallId": "other", "title": "另一任务"}),
        );
        other.instance_id = "other-client".to_owned();
        reducer.apply(&other).unwrap();
        reducer
            .apply(&event(
                2,
                "tool.started",
                json!({"toolCallId": "mine", "title": "当前任务"}),
            ))
            .unwrap();
        reducer
            .apply(&event(3, "tool.completed", json!({"toolCallId": "mine"})))
            .unwrap();
        reducer
            .apply(&event(4, "agent.completed", json!({})))
            .unwrap();
        let bubble = reducer.state(5_000).bubble.unwrap();
        assert_eq!(bubble.title, "另一任务");
        assert_eq!(bubble.started_at, Some(10));
        assert_eq!(bubble.expires_at, None);
    }

    #[test]
    fn keeps_omp_intent_and_command_while_tool_is_active() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer
            .apply(&event(
                1,
                "tool.started",
                json!({
                    "toolCallId": "tool-1",
                    "toolName": "bash",
                    "title": "等待第十五次训练开始",
                    "detail": "> train --round 15",
                    "startedAt": 5
                }),
            ))
            .unwrap();
        let state = reducer.state(20);
        let bubble = state.bubble.unwrap();
        assert_eq!(bubble.title, "等待第十五次训练开始");
        assert_eq!(bubble.detail.as_deref(), Some("> train --round 15"));
        assert_eq!(bubble.started_at, Some(5));
        assert_eq!(bubble.expires_at, None);
    }

    #[test]
    fn keeps_command_bubble_after_tool_completion_during_active_turn() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer
            .apply(&event(1, "agent.started", json!({ "title": "检查项目" })))
            .unwrap();
        reducer
            .apply(&event(
                2,
                "tool.started",
                json!({
                    "toolCallId": "tool-1",
                    "title": "运行测试",
                    "detail": "> bun test"
                }),
            ))
            .unwrap();
        reducer
            .apply(&event(
                3,
                "tool.completed",
                json!({ "toolCallId": "tool-1" }),
            ))
            .unwrap();
        let bubble = reducer.state(40).bubble.unwrap();
        assert_eq!(bubble.title, "运行测试");
        assert_eq!(bubble.detail.as_deref(), Some("> bun test"));
        assert_eq!(bubble.expires_at, None);
    }

    #[test]
    fn background_snapshot_drives_title_timer_and_running_state() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer
            .apply(&event(
                1,
                "background.snapshot",
                json!({
                    "jobs": [{
                        "id": "job-1",
                        "type": "task",
                        "title": "后台训练",
                        "startedAt": 3
                    }]
                }),
            ))
            .unwrap();
        let state = reducer.state(20);
        assert_eq!(state.animation, "running");
        assert!(state.bubble.is_none());
        let bubble = state.background_bubbles.first().unwrap();
        assert_eq!(bubble.title, "后台训练");
        assert_eq!(bubble.started_at, Some(3));
        assert!(bubble.background);

        let settled = reducer.state(2_470);
        assert_eq!(settled.animation, "idle");
        assert_eq!(settled.background_bubbles.len(), 1);
        assert_eq!(reducer.counts().4, 1);
    }

    #[test]
    fn background_stack_does_not_replace_main_intent() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer
            .apply(&event(
                1,
                "tool.started",
                json!({
                    "toolCallId": "tool-1",
                    "title": "检查当前步骤",
                    "detail": "> bun test"
                }),
            ))
            .unwrap();
        reducer
            .apply(&event(
                2,
                "background.snapshot",
                json!({
                    "jobs": [
                        { "id": "job-1", "type": "bash", "title": "后台训练", "startedAt": 11 },
                        { "id": "job-2", "type": "task", "title": "后台审查", "startedAt": 12 }
                    ]
                }),
            ))
            .unwrap();
        let state = reducer.state(30);
        assert_eq!(state.bubble.unwrap().title, "检查当前步骤");
        assert_eq!(
            state
                .background_bubbles
                .iter()
                .map(|bubble| bubble.title.as_str())
                .collect::<Vec<_>>(),
            vec!["后台训练", "后台审查"]
        );
    }

    #[test]
    fn waiting_returns_to_idle_while_approval_remains_pending() {
        let mut reducer = PetEventReducer::new(true, 0);
        reducer
            .apply(&event(
                1,
                "approval.requested",
                json!({ "toolCallId": "tool-1", "toolName": "bash" }),
            ))
            .unwrap();
        assert_eq!(reducer.state(20).animation, "waiting");
        assert_eq!(reducer.state(3_040).animation, "idle");
        assert_eq!(reducer.counts().3, 1);
    }
}
