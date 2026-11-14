use crate::api_client::{ApiClient, ConnectionSessionResponse};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use std::sync::Arc;

// ============================================================
// Estados da ConnectionSession (Máquina de Estados)
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum SessionStatus {
    Creating,
    StartingProvider,
    WaitingProvider,
    Online,
    Degraded,
    Stopping,
    Stopped,
    Failed,
    Cancelled,
}

impl SessionStatus {
    pub fn to_str(&self) -> &'static str {
        match self {
            SessionStatus::Creating => "creating",
            SessionStatus::StartingProvider => "starting_provider",
            SessionStatus::WaitingProvider => "waiting_provider",
            SessionStatus::Online => "online",
            SessionStatus::Degraded => "degraded",
            SessionStatus::Stopping => "stopping",
            SessionStatus::Stopped => "stopped",
            SessionStatus::Failed => "failed",
            SessionStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "creating" => Some(SessionStatus::Creating),
            "starting_provider" => Some(SessionStatus::StartingProvider),
            "waiting_provider" => Some(SessionStatus::WaitingProvider),
            "online" => Some(SessionStatus::Online),
            "degraded" => Some(SessionStatus::Degraded),
            "stopping" => Some(SessionStatus::Stopping),
            "stopped" => Some(SessionStatus::Stopped),
            "failed" => Some(SessionStatus::Failed),
            "cancelled" => Some(SessionStatus::Cancelled),
            _ => None,
        }
    }
}

// ============================================================
// Razões de Encerramento
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum TerminationReason {
    UserStopped,
    ApplicationClosed,
    ProviderError,
    ApiError,
    Crash,
    Timeout,
    LeaseExpired,
}

impl TerminationReason {
    pub fn to_str(&self) -> &'static str {
        match self {
            TerminationReason::UserStopped => "user_stopped",
            TerminationReason::ApplicationClosed => "application_closed",
            TerminationReason::ProviderError => "provider_error",
            TerminationReason::ApiError => "api_error",
            TerminationReason::Crash => "crash",
            TerminationReason::Timeout => "timeout",
            TerminationReason::LeaseExpired => "lease_expired",
        }
    }
}

// ============================================================
// Timing da Sessão
// ============================================================

#[derive(Debug, Clone)]
pub struct SessionTiming {
    pub api_call_ms: Option<u64>,
    pub provider_start_ms: Option<u64>,
    pub provider_wait_ms: Option<u64>,
    pub total_elapsed_ms: Option<u64>,
    pub started_at: Instant,
}

impl Default for SessionTiming {
    fn default() -> Self {
        Self {
            api_call_ms: None,
            provider_start_ms: None,
            provider_wait_ms: None,
            total_elapsed_ms: None,
            started_at: Instant::now(),
        }
    }
}

// ============================================================
// Estado interno da Sessão
// ============================================================

#[derive(Debug)]
struct SessionState {
    status: SessionStatus,
    session_id: Option<String>,
    short_code: Option<String>,
    correlation_id: Option<String>,
    provider: Option<String>,
    host_ip: Option<String>,
    revision: u64,
    retry_count: u32,
    heartbeat_count: u64,
    timing: SessionTiming,
    termination_reason: Option<TerminationReason>,
}

impl SessionState {
    fn new() -> Self {
        Self {
            status: SessionStatus::Cancelled,
            session_id: None,
            short_code: None,
            correlation_id: None,
            provider: None,
            host_ip: None,
            revision: 0,
            retry_count: 0,
            heartbeat_count: 0,
            timing: SessionTiming::default(),
            termination_reason: None,
        }
    }
}

// ============================================================
// SessionManager — Máquina de Estados
// ============================================================

pub struct SessionManager {
    api: Arc<ApiClient>,
    state: Mutex<SessionState>,
}

impl SessionManager {
    pub fn new(api: Arc<ApiClient>) -> Self {
        Self {
            api,
            state: Mutex::new(SessionState::new()),
        }
    }

    // ============================================================
    // Validação de Transições
    // ============================================================

    fn validate_transition(from: &SessionStatus, to: &SessionStatus) -> Result<(), String> {
        match (from, to) {
            // Transições VÁLIDAS
            (SessionStatus::Cancelled, SessionStatus::Creating) => Ok(()),
            (SessionStatus::Creating, SessionStatus::StartingProvider) => Ok(()),
            (SessionStatus::StartingProvider, SessionStatus::WaitingProvider) => Ok(()),
            (SessionStatus::WaitingProvider, SessionStatus::Online) => Ok(()),
            (SessionStatus::WaitingProvider, SessionStatus::Failed) => Ok(()),
            (SessionStatus::WaitingProvider, SessionStatus::Cancelled) => Ok(()),
            (SessionStatus::Online, SessionStatus::Degraded) => Ok(()),
            (SessionStatus::Online, SessionStatus::Stopping) => Ok(()),
            (SessionStatus::Degraded, SessionStatus::Online) => Ok(()),
            (SessionStatus::Degraded, SessionStatus::Stopping) => Ok(()),
            (SessionStatus::Stopping, SessionStatus::Stopped) => Ok(()),
            (SessionStatus::Failed, SessionStatus::Creating) => Ok(()),
            (SessionStatus::Stopped, SessionStatus::Creating) => Ok(()),
            
            // Transições INVÁLIDAS
            _ => Err(tr!("session.invalidTransition", from = format!("{:?}", from), to = format!("{:?}", to))),
        }
    }

    // ============================================================
    // Iniciar Sessão (ponto de entrada principal)
    // ============================================================

    pub async fn start(&self, short_code: &str, mode: &str, local_port: u16) -> Result<ConnectionSessionResponse, String> {
        self.start_with(short_code, mode, local_port, None).await
    }

    /// Como `start`, escolhendo o transporte: `Some("link-v1")` pede o P2P (cubicase-link).
    pub async fn start_with(&self, short_code: &str, mode: &str, local_port: u16, launcher: Option<&str>) -> Result<ConnectionSessionResponse, String> {
        self.start_with_relay(short_code, mode, local_port, launcher, false).await
    }

    /// Como `start_with`; `relay_only` liga o modo privado (só vale com o P2P).
    pub async fn start_with_relay(&self, short_code: &str, mode: &str, local_port: u16, launcher: Option<&str>, relay_only: bool) -> Result<ConnectionSessionResponse, String> {
        // Verificar concorrência
        {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.status == SessionStatus::Creating
                || state.status == SessionStatus::StartingProvider
                || state.status == SessionStatus::WaitingProvider
                || state.status == SessionStatus::Online
                || state.status == SessionStatus::Degraded
            {
                return Err(tr!("session.busy"));
            }
        }

        // Transição: CANCELLED → CREATING
        Self::validate_transition(&SessionStatus::Cancelled, &SessionStatus::Creating)
            .map_err(|e| tr!("session.internal", error = e))?;

        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.status = SessionStatus::Creating;
            state.short_code = Some(short_code.to_string());
            state.timing = SessionTiming::default();
            state.timing.started_at = Instant::now();
        }

        // Chamar API para criar sessão
        let result = self.api.create_connection_session_with(short_code, mode, launcher, relay_only).await;

        match result {
            Ok(session) => {
                // Transição: CREATING → STARTING_PROVIDER
                {
                    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.session_id = Some(session.session_id.clone());
                    state.provider = Some(session.launcher.clone());
                    state.revision = 1;
                    state.timing.api_call_ms = Some(state.timing.started_at.elapsed().as_millis() as u64);
                    state.status = SessionStatus::StartingProvider;
                }

                Ok(session)
            }
            Err(err) => {
                // Transição: CREATING → FAILED
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state.status = SessionStatus::Failed;
                state.termination_reason = Some(TerminationReason::ApiError);
                state.timing.total_elapsed_ms = Some(state.timing.started_at.elapsed().as_millis() as u64);

                Err(format!("{}", err))
            }
        }
    }

    // ============================================================
    // Atualizar para WaitingProvider
    // ============================================================

    pub fn set_waiting_provider(&self) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Self::validate_transition(&state.status, &SessionStatus::WaitingProvider)?;
        state.timing.provider_start_ms = Some(state.timing.started_at.elapsed().as_millis() as u64);
        state.status = SessionStatus::WaitingProvider;
        Ok(())
    }

    // ============================================================
    // Notificar que o sidecar conectou (ONLINE)
    // ============================================================

    /// A sessão usa o transporte P2P (a presença do host é a própria sala de sinalização:
    /// não há PATCH de hostIp nem heartbeat para a API). Hoje é o único transporte.
    pub fn is_link(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).provider.as_deref() == Some("link-v1")
    }

    /// WaitingProvider → Online sem falar com a API (transporte P2P).
    pub fn set_online_local(&self) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Self::validate_transition(&state.status, &SessionStatus::Online)?;
        state.status = SessionStatus::Online;
        state.timing.provider_wait_ms = Some(state.timing.started_at.elapsed().as_millis() as u64);
        state.timing.total_elapsed_ms = state.timing.provider_wait_ms;
        Ok(())
    }

    // ============================================================
    // Notificar falha (FAILED)
    // ============================================================

    pub async fn set_failed(&self, reason: TerminationReason, error_msg: &str) {
        let session_id;

        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.status = SessionStatus::Failed;
            state.termination_reason = Some(reason);
            state.timing.total_elapsed_ms = Some(state.timing.started_at.elapsed().as_millis() as u64);
            session_id = state.session_id.clone();
        }

        // Avisar API
        if let Some(sid) = session_id {
            let _ = self.api.delete_connection_session(&sid, reason.to_str()).await;
        }
    }

    // ============================================================
    // Parar a sessão
    // ============================================================

    pub async fn stop(&self) -> Result<(), String> {
        let session_id;
        let revision;

        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            Self::validate_transition(&state.status, &SessionStatus::Stopping)?;
            state.status = SessionStatus::Stopping;
            session_id = state.session_id.clone();
            revision = state.revision;
        }

        // Notificar API
        if let Some(sid) = session_id {
            let _ = self.api.update_connection_session(
                &sid, "stopping", None, revision,
                None, None, None, Some("user_stopped"),
            ).await;
            let _ = self.api.delete_connection_session(&sid, "user_stopped").await;
        }

        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.status = SessionStatus::Stopped;
            state.termination_reason = Some(TerminationReason::UserStopped);
            state.revision += 1;
        }

        Ok(())
    }

    // ============================================================
    // Cleanup (onCloseRequested)
    // ============================================================

    pub async fn cleanup(&self) {
        let session_id;

        {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            session_id = state.session_id.clone();
        }

        if let Some(sid) = session_id {
            let _ = self.api.delete_connection_session(&sid, "application_closed").await;
        }

        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.status = SessionStatus::Cancelled;
        state.termination_reason = Some(TerminationReason::ApplicationClosed);
    }

    // ============================================================
    // Getters
    // ============================================================

    pub fn get_status(&self) -> SessionStatus {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).status
    }

    pub fn get_session_id(&self) -> Option<String> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).session_id.clone()
    }

    pub fn get_host_ip(&self) -> Option<String> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).host_ip.clone()
    }

    pub fn get_heartbeat_count(&self) -> u64 {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).heartbeat_count
    }
}

// ============================================================
// Testes automatizados — lógica de retry/estado, sem rede real
// ============================================================
// `ApiTransport` já é um trait (pensado pra HTTP/WebSocket/gRPC — ver
// api_client.rs), então dá pra injetar um transporte roteirizado aqui e
// testar exatamente o comportamento de retry do SessionManager sem
// depender de rede/Worker de verdade. O que NÃO dá (e não deveria
// tentar) pra testar assim: subir o processo Java de verdade ou o sidecar
// cubicase-link de verdade — isso continua sendo teste manual com duas
// máquinas.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_client::{ApiClient, ApiConfig, ApiError, ApiRequest, ApiResponse, ApiTransport};
    use async_trait::async_trait;
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;

    /// Transporte falso que devolve, em ordem, uma lista pré-definida de
    /// respostas — uma por chamada a `send`, independente do endpoint.
    struct ScriptedTransport {
        responses: StdMutex<VecDeque<Result<ApiResponse, ApiError>>>,
    }

    impl ScriptedTransport {
        fn new(responses: Vec<Result<ApiResponse, ApiError>>) -> Self {
            Self { responses: StdMutex::new(responses.into_iter().collect()) }
        }
    }

    #[async_trait]
    impl ApiTransport for ScriptedTransport {
        async fn send(&self, _request: ApiRequest) -> Result<ApiResponse, ApiError> {
            self.responses.lock().unwrap_or_else(|e| e.into_inner()).pop_front().unwrap_or_else(|| {
                fake_err("EXHAUSTED", "ScriptedTransport sem mais respostas roteirizadas")
            })
        }
    }

    fn fake_err(code: &str, message: &str) -> Result<ApiResponse, ApiError> {
        Err(ApiError { code: code.into(), message: message.into(), technical_id: "test".into(), status_code: 500 })
    }

    fn fake_ok(data: serde_json::Value) -> Result<ApiResponse, ApiError> {
        Ok(ApiResponse {
            success: true,
            code: "SUCCESS".into(),
            message: "ok".into(),
            data: Some(data),
            details: None,
            technical_id: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
            request_id: None,
        })
    }

    fn connection_session_json(session_id: &str) -> serde_json::Value {
        serde_json::json!({
            "sessionId": session_id,
            "launcher": "link-v1",
            "launcherVersion": 1,
            "protocolVersion": 1,
            "credentials": {},
            "leaseDurationMs": 90000,
            "expiresAt": "2026-01-01T00:01:30Z",
        })
    }

    fn session_manager_with(responses: Vec<Result<ApiResponse, ApiError>>) -> SessionManager {
        let client = ApiClient::with_transport(Box::new(ScriptedTransport::new(responses)), ApiConfig::default());
        SessionManager::new(Arc::new(client))
    }

    #[tokio::test]
    async fn start_then_set_online_local_succeeds_without_extra_api_calls() {
        // Único transporte: o P2P. Depois de criar a sessão, ficar online só avança o estado local
        // (a presença do host é a sala de sinalização) — nenhuma chamada extra à API.
        let sm = session_manager_with(vec![fake_ok(connection_session_json("sess-3"))]);

        sm.start("ABCDEF", "host", 25565).await.expect("start deveria funcionar");
        sm.set_waiting_provider().expect("set_waiting_provider deveria funcionar");
        sm.set_online_local().expect("set_online_local deveria funcionar");

        assert_eq!(sm.get_status(), SessionStatus::Online);
        assert_eq!(sm.get_session_id(), Some("sess-3".to_string()));
        assert!(sm.is_link());
    }
}
#[cfg(test)]
mod link_tests {
    use super::*;
    use crate::api_client::{ApiConfig, ApiError, ApiRequest, ApiResponse, ApiTransport};
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;

    /// Grava os pedidos e responde sempre com uma sessão `link-v1`.
    struct Recorder {
        seen: Arc<StdMutex<Vec<ApiRequest>>>,
    }

    #[async_trait]
    impl ApiTransport for Recorder {
        async fn send(&self, request: ApiRequest) -> Result<ApiResponse, ApiError> {
            self.seen.lock().unwrap().push(request);
            Ok(ApiResponse {
                success: true, code: "SUCCESS".into(), message: "ok".into(),
                data: Some(serde_json::json!({
                    "sessionId": "sess-link", "launcher": "link-v1", "launcherVersion": 1, "protocolVersion": 1,
                    "credentials": { "signalUrl": "wss://x/ws", "signalToken": "t", "peerId": "sess-link" },
                    "leaseDurationMs": 86400000, "expiresAt": "2026-01-02T00:00:00Z",
                })),
                details: None, technical_id: None, timestamp: "2026-01-01T00:00:00Z".into(), request_id: None,
            })
        }
    }

    #[tokio::test]
    async fn link_session_requests_the_launcher_and_goes_online_without_calling_the_api() {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let client = ApiClient::with_transport(Box::new(Recorder { seen: seen.clone() }), ApiConfig::default());
        let sm = SessionManager::new(Arc::new(client));

        let resp = sm.start_with("ABCDEF", "guest", 25565, Some("link-v1")).await.expect("start");
        assert_eq!(resp.launcher, "link-v1");
        assert!(sm.is_link());
        {
            let reqs = seen.lock().unwrap();
            assert_eq!(reqs.len(), 1);
            assert_eq!(reqs[0].body.as_ref().unwrap()["launcher"], "link-v1");
        }

        sm.set_waiting_provider().unwrap();
        sm.set_online_local().expect("P2P fica online localmente");
        assert_eq!(sm.get_status(), SessionStatus::Online);
        // Nenhum PATCH de hostIp (a API recusaria "p2p"): só o pedido de criação existe.
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn private_mode_sends_relay_only_only_with_the_p2p_launcher() {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let client = ApiClient::with_transport(Box::new(Recorder { seen: seen.clone() }), ApiConfig::default());
        let sm = SessionManager::new(Arc::new(client));
        let _ = sm.start_with_relay("ABCDEF", "host", 25565, Some("link-v1"), true).await.expect("start");
        assert_eq!(seen.lock().unwrap()[0].body.as_ref().unwrap()["relayOnly"], true);

        // Sem o launcher P2P o modo privado não existe: nada de relayOnly no pedido.
        let seen2 = Arc::new(StdMutex::new(Vec::new()));
        let client2 = ApiClient::with_transport(Box::new(Recorder { seen: seen2.clone() }), ApiConfig::default());
        let sm2 = SessionManager::new(Arc::new(client2));
        let _ = sm2.start_with_relay("ABCDEF", "host", 25565, None, true).await;
        assert!(seen2.lock().unwrap()[0].body.as_ref().unwrap().get("relayOnly").is_none());

        // E o padrão (modo privado desligado) nunca manda a chave.
        let seen3 = Arc::new(StdMutex::new(Vec::new()));
        let client3 = ApiClient::with_transport(Box::new(Recorder { seen: seen3.clone() }), ApiConfig::default());
        let sm3 = SessionManager::new(Arc::new(client3));
        let _ = sm3.start_with("ABCDEF", "host", 25565, Some("link-v1")).await.expect("start");
        assert!(seen3.lock().unwrap()[0].body.as_ref().unwrap().get("relayOnly").is_none());
    }

    #[tokio::test]
    async fn default_start_does_not_ask_for_the_p2p_launcher() {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let client = ApiClient::with_transport(Box::new(Recorder { seen: seen.clone() }), ApiConfig::default());
        let sm = SessionManager::new(Arc::new(client));
        let _ = sm.start("ABCDEF", "host", 25565).await;
        assert!(seen.lock().unwrap()[0].body.as_ref().unwrap().get("launcher").is_none());
    }
}
