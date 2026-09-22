use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 1;
pub const EVENT_SOURCE: &str = "omp";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetManifest {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    pub sprite_version_number: u8,
    pub spritesheet_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetInfo {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub sprite_version_number: u8,
    pub spritesheet_path: String,
    pub selected: bool,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetBubble {
    pub id: String,
    pub title: String,
    pub detail: Option<String>,
    pub kind: String,
    pub changed_at: u64,
    pub expires_at: Option<u64>,
    pub started_at: Option<u64>,
    pub background: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePetState {
    pub animation: String,
    pub changed_at: u64,
    pub reason: String,
    pub bubble: Option<PetBubble>,
    pub background_bubbles: Vec<PetBubble>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetEventEnvelope {
    pub protocol_version: u8,
    pub source: String,
    pub instance_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub timestamp: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventBatch {
    pub protocol_version: u8,
    pub events: Vec<PetEventEnvelope>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub action: String,
    pub pet_id: Option<String>,
    pub enabled: Option<bool>,
    pub animation: Option<String>,
    pub path: Option<String>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub visible: bool,
    pub selected_pet_id: Option<String>,
    pub pets: Vec<PetInfo>,
    pub events_enabled: bool,
    pub debug_enabled: bool,
    pub animation: String,
    pub bubble: Option<PetBubble>,
    pub background_bubbles: Vec<PetBubble>,
    pub clients: usize,
    pub active_agents: usize,
    pub active_tools: usize,
    pub pending_approvals: usize,
    pub background_jobs: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub state: EffectivePetState,
    pub selected_pet: Option<PetInfo>,
    pub sprite_url: Option<String>,
    pub debug_enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    pub protocol_version: u8,
    pub source: String,
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub started_at: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub selected_pet_id: Option<String>,
    #[serde(default = "default_events_enabled")]
    pub events_enabled: bool,
    #[serde(default)]
    pub debug_enabled: bool,
}

fn default_events_enabled() -> bool {
    true
}
