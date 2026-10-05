//! Hospedagem unificada: servidor Minecraft + rede mesh como UMA ação.
//!
//! O usuário comum só quer "ligar o servidor e os amigos entrarem". Este módulo
//! orquestra os dois ciclos de vida (processo Java e túnel mesh) a partir de um
//! único comando (`start_hosting`) e publica um único status (`hosting-status`):
//!
//! ```text
//! Idle → Starting → Connecting → OnlineFriends
//!                 ↘ LocalOnly (rede falhou/caiu/opção do usuário)
//! qualquer → Stopping → Idle        ·        Minecraft travou → Crashed
//! ```
//!
//! Regras de projeto (cada uma existe por causa de um cenário de falha real):
//! - Minecraft e rede sobem **em paralelo**; a falha da rede NUNCA derruba o
//!   Minecraft (o servidor segue em `LocalOnly` e a rede é retomada com backoff).
//! - Minecraft encerrado (crash, falha ao iniciar ou `/stop` digitado no
//!   console) derruba a rede — não faz sentido expor um servidor que não existe.
//! - Um supervisor (1 tick/s) reconcilia o estado REAL (`AppState`) com o
//!   desejado; todas as decisões dele ficam em funções puras ([`decide`],
//!   [`derive_phase`], [`NetTracker`]) testadas sem precisar de AppHandle.
//! - Cada sessão tem uma `generation`: qualquer task/supervisor de uma sessão
//!   anterior (parada, trocada) descobre que ficou obsoleto e sai sem tocar em
//!   nada — é o que impede, por exemplo, uma tentativa de rede atrasada de
//!   religar um sidecar depois do usuário já ter parado tudo.

use super::*;
use tauri::Listener;

// ------------------------------------------------------------
// Constantes
// ------------------------------------------------------------

/// Esperas entre tentativas de religar a rede depois de uma falha. Cada
/// "tentativa" aqui já embute os 3 retries internos de
/// `start_network_node_with_retry`. Esgotada a lista, para de tentar sozinho
/// (credencial revogada, conta sem acesso etc. não se resolvem em loop) e deixa
/// o botão manual "Tentar de novo".
const NET_BACKOFF_SECS: [u64; 5] = [10, 30, 60, 120, 300];

/// Sidecar iniciado mas sem reportar IP (autenticação travada, DERP fora…).
const NET_CONNECT_TIMEOUT: Duration = Duration::from_secs(90);

/// Rede que ficou online por pelo menos isto é considerada saudável: zera o
/// contador de falhas. Queda ANTES disso conta como falha (evita loop rápido de
/// reconexão numa rede que conecta e cai em seguida).
const NET_STABLE_AFTER: Duration = Duration::from_secs(60);

/// Quanto o supervisor espera o monitor do Minecraft classificar o fim do
/// processo (crash × parada limpa) antes de decidir sozinho.
const MC_CLASSIFY_GRACE: Duration = Duration::from_secs(4);

/// Código devolvido por `start_hosting` quando este app está conectado como
/// convidado de outro servidor e o usuário ainda não confirmou sair.
pub const ERR_GUEST_ACTIVE: &str = "GUEST_ACTIVE";

// ------------------------------------------------------------
// Tipos de estado (puros)
// ------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum McState {
    Offline,
    Starting,
    Online,
    Crashed,
}

impl McState {
    pub fn as_str(self) -> &'static str {
        match self {
            McState::Offline => "offline",
            McState::Starting => "starting",
            McState::Online => "online",
            McState::Crashed => "crashed",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NetState {
    /// Nenhum sidecar nem mock ativo.
    Off,
    /// Sidecar (ou mock) de pé, ainda sem IP na malha.
    Connecting,
    /// IP atribuído: o host já é alcançável pelos convidados.
    Online,
}

impl NetState {
    pub fn as_str(self) -> &'static str {
        match self {
            NetState::Off => "off",
            NetState::Connecting => "connecting",
            NetState::Online => "online",
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum HostingPhase {
    #[default]
    Idle,
    /// Preparando/subindo o Minecraft (rede em paralelo).
    Starting,
    /// Minecraft pronto; conectando com os amigos.
    Connecting,
    /// Minecraft pronto e rede online — os amigos conseguem entrar.
    OnlineFriends,
    /// Minecraft pronto, mas sem rede (ver `local_only_reason`).
    LocalOnly,
    Stopping,
    /// O Minecraft travou (terminal até o próximo start).
    Crashed,
}

pub struct PhaseInputs {
    pub stopping: bool,
    pub mc_crashed_final: bool,
    pub mc: McState,
    pub want_network: bool,
    pub net: NetState,
    /// Já houve falha de rede nesta sessão (tentativa falhou, caiu ou esgotou).
    pub net_failed: bool,
}

/// Fase mostrada ao usuário, derivada do estado real. Pura.
pub fn derive_phase(i: &PhaseInputs) -> HostingPhase {
    if i.stopping {
        return HostingPhase::Stopping;
    }
    if i.mc_crashed_final {
        return HostingPhase::Crashed;
    }
    match i.mc {
        // `Offline`/`Crashed` transitórios (processo ainda não nasceu, ou acabou
        // de morrer e o supervisor ainda não tratou) contam como "subindo".
        McState::Offline | McState::Starting | McState::Crashed => HostingPhase::Starting,
        McState::Online => {
            if !i.want_network {
                HostingPhase::LocalOnly
            } else if i.net == NetState::Online {
                HostingPhase::OnlineFriends
            } else if i.net_failed {
                HostingPhase::LocalOnly
            } else {
                HostingPhase::Connecting
            }
        }
    }
}

/// Por que o servidor está só local (para a UI escolher a mensagem).
pub fn local_only_reason(want_network: bool, net_ever_online: bool) -> &'static str {
    if !want_network {
        "userChoice"
    } else if net_ever_online {
        "networkDropped"
    } else {
        "networkFailed"
    }
}

// ------------------------------------------------------------
// Backoff e acompanhamento da rede (puros)
// ------------------------------------------------------------

/// Espera antes da próxima tentativa após `failures` falhas consecutivas
/// (`failures >= 1`). `None` = desistir do automático.
pub fn next_retry_delay(failures: u32) -> Option<Duration> {
    if failures == 0 {
        return Some(Duration::ZERO);
    }
    NET_BACKOFF_SECS
        .get((failures - 1) as usize)
        .map(|s| Duration::from_secs(*s))
}

#[derive(Default, Clone, Debug)]
pub struct NetRetry {
    pub failures: u32,
    pub wait_until: Option<Instant>,
    pub gave_up: bool,
}

impl NetRetry {
    pub fn record_failure(&mut self, now: Instant) {
        self.failures += 1;
        match next_retry_delay(self.failures) {
            Some(d) => {
                self.wait_until = Some(now + d);
                self.gave_up = false;
            }
            None => {
                self.wait_until = None;
                self.gave_up = true;
            }
        }
    }

    pub fn reset(&mut self) {
        *self = NetRetry::default();
    }

    /// Há (ou já houve) falha nesta sessão — a UI deixa de mostrar "conectando".
    pub fn has_failed(&self) -> bool {
        self.failures > 0 || self.gave_up
    }
}

/// Observa o estado da rede a cada tick e mantém os contadores que dependem do
/// tempo (estabilidade, queda, timeout de conexão). Pura: o relógio entra como
/// parâmetro.
#[derive(Default, Clone, Debug)]
pub struct NetTracker {
    pub retry: NetRetry,
    pub online_since: Option<Instant>,
    pub connecting_since: Option<Instant>,
    pub ever_online: bool,
}

impl NetTracker {
    pub fn observe(&mut self, net: NetState, now: Instant) {
        match net {
            NetState::Online => {
                if self.online_since.is_none() {
                    self.online_since = Some(now);
                    self.ever_online = true;
                    self.connecting_since = None;
                }
                if let Some(since) = self.online_since {
                    if now.duration_since(since) >= NET_STABLE_AFTER && self.retry.has_failed() {
                        self.retry.reset();
                    }
                }
            }
            NetState::Connecting | NetState::Off => {
                // Estava online e deixou de estar: queda.
                if let Some(since) = self.online_since.take() {
                    if now.duration_since(since) >= NET_STABLE_AFTER {
                        // Rede estava saudável: religa já, sem penalidade.
                        self.retry.reset();
                    } else {
                        self.retry.record_failure(now);
                    }
                }
                if net == NetState::Connecting {
                    self.connecting_since.get_or_insert(now);
                } else {
                    self.connecting_since = None;
                }
            }
        }
    }
}

// ------------------------------------------------------------
// Decisão do supervisor (pura)
// ------------------------------------------------------------

pub struct TickInputs {
    pub mc: McState,
    /// `start_minecraft_server` já retornou Ok (o processo existe). Antes disso
    /// "Offline" significa "ainda não nasceu", não "morreu".
    pub mc_launch_done: bool,
    pub mc_start_failed: bool,
    pub want_network: bool,
    pub net: NetState,
    pub net_task_running: bool,
    pub connecting_for: Option<Duration>,
    pub retry_gave_up: bool,
    pub retry_wait_until: Option<Instant>,
    pub now: Instant,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TickAction {
    None,
    /// `start_minecraft_server` falhou: derrubar tudo e reportar o erro.
    McStartFailed,
    /// O processo do Minecraft acabou (crash ou parada limpa fora do app).
    McEnded,
    /// Subir (ou religar) a rede.
    StartNetwork,
    /// Sidecar vivo mas sem IP há tempo demais: matar e tratar como falha.
    NetConnectTimeout,
}

pub fn decide(i: &TickInputs) -> TickAction {
    if i.mc_start_failed {
        return TickAction::McStartFailed;
    }
    if i.mc_launch_done && matches!(i.mc, McState::Offline | McState::Crashed) {
        return TickAction::McEnded;
    }
    if !i.want_network || i.net == NetState::Online {
        return TickAction::None;
    }
    // Uma tentativa (com seus retries internos) em andamento: não atropelar.
    if i.net_task_running {
        return TickAction::None;
    }
    if i.net == NetState::Connecting {
        return match i.connecting_for {
            Some(d) if d >= NET_CONNECT_TIMEOUT => TickAction::NetConnectTimeout,
            _ => TickAction::None,
        };
    }
    // net == Off e nenhuma tentativa em andamento.
    if i.retry_gave_up {
        return TickAction::None;
    }
    match i.retry_wait_until {
        Some(t) if i.now < t => TickAction::None,
        _ => TickAction::StartNetwork,
    }
}

// ------------------------------------------------------------
// Wake-on-demand depois que a sessão termina — pura
// ------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WakeAfterStop {
    /// Não há wake-on-demand armado: nada a fazer.
    Nothing,
    /// Volta ao modo de espera (loop de "sleeping" reaberto).
    ResumeStandby,
    /// Fica parado e a espera PAUSADA até o usuário reativá-la.
    PauseStandby,
}

/// O servidor foi parado pelo usuário (botão Parar) → a espera pausa: clicar em
/// Parar é uma intenção explícita ("ninguém entra agora") e um amigo não pode
/// acordar o servidor no meio de uma troca de mods ou de um backup. Qualquer
/// outro fim (inatividade, `/stop` no console, fim limpo) volta à espera — é o
/// propósito do recurso.
pub fn wake_after_stop(armed: bool, stopped_by_user: bool) -> WakeAfterStop {
    match (armed, stopped_by_user) {
        (false, _) => WakeAfterStop::Nothing,
        (true, true) => WakeAfterStop::PauseStandby,
        (true, false) => WakeAfterStop::ResumeStandby,
    }
}

// ------------------------------------------------------------
// Inatividade (wake-on-demand) — pura
// ------------------------------------------------------------

/// Aviso "desligando por inatividade" com esta antecedência.
const IDLE_WARN_LEAD: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IdleAction {
    None,
    /// Falta ~1 min para desligar: a UI oferece "Manter ligado".
    Warn,
    Shutdown,
}

/// Conta o tempo CONSECUTIVO sem jogadores. Qualquer jogador, ou o "Manter
/// ligado" da UI, recomeça a contagem. Pura: o relógio entra como parâmetro.
#[derive(Default, Clone, Debug)]
pub struct IdleTracker {
    pub idle_since: Option<Instant>,
    pub warned: bool,
}

impl IdleTracker {
    pub fn observe(&mut self, players: u32, reset: bool, now: Instant, timeout: Duration) -> IdleAction {
        if reset || players > 0 {
            // "Manter ligado" com a sala vazia recomeça a contagem DAQUI (não a
            // desliga): sem isso o aviso reapareceria no tick seguinte.
            self.idle_since = if players == 0 { Some(now) } else { None };
            self.warned = false;
            return IdleAction::None;
        }
        let since = *self.idle_since.get_or_insert(now);
        let elapsed = now.saturating_duration_since(since);
        if elapsed >= timeout {
            IdleAction::Shutdown
        } else if !self.warned && timeout > IDLE_WARN_LEAD && elapsed + IDLE_WARN_LEAD >= timeout {
            self.warned = true;
            IdleAction::Warn
        } else {
            IdleAction::None
        }
    }
}

// ------------------------------------------------------------
// Configuração, runtime e snapshot
// ------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostingConfig {
    pub name: String,
    pub version: String,
    pub server_type: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub forge_version: Option<String>,
    #[serde(default)]
    pub mod_loader_version: Option<String>,
    pub short_code: String,
    pub server_dir: String,
    pub java_path: String,
    pub ram_gb: u32,
    #[serde(default)]
    pub server_jar_name: Option<String>,
    #[serde(default)]
    pub launch_args_dir: Option<String>,
}

#[derive(Serialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostingSnapshot {
    pub phase: HostingPhase,
    pub mc: &'static str,
    pub net: &'static str,
    /// "userChoice" | "networkFailed" | "networkDropped" — só em `LocalOnly`.
    pub local_only_reason: Option<&'static str>,
    /// Há uma tentativa de rede em andamento agora.
    pub net_retrying: bool,
    /// Instante (ms Unix) da próxima tentativa automática, se agendada.
    pub net_retry_at_ms: Option<u64>,
    /// As tentativas automáticas acabaram; só o botão manual resolve.
    pub net_gave_up: bool,
    pub net_error: Option<String>,
    /// Falha ao iniciar o Minecraft (mensagem já traduzida).
    pub error: Option<String>,
    pub short_code: Option<String>,
    pub server_name: Option<String>,
    pub ip: Option<String>,
    /// O wake-on-demand está armado mas PAUSADO porque o usuário parou o servidor
    /// à mão — a UI precisa deixar isso explícito (ninguém consegue acordá-lo).
    pub wake_paused: bool,
}

#[derive(Default)]
pub struct HostingRuntime {
    pub active: bool,
    pub stopping: bool,
    pub generation: u64,
    pub cfg: Option<Arc<HostingConfig>>,
    pub want_network: bool,
    pub tracker: NetTracker,
    pub net_task: Option<tauri::async_runtime::JoinHandle<()>>,
    pub net_task_running: bool,
    pub net_task_id: u64,
    pub mc_task: Option<tauri::async_runtime::JoinHandle<()>>,
    pub mc_launch_done: bool,
    pub mc_start_error: Option<String>,
    /// Último "minecraft-status-changed" visto nesta sessão (classifica o fim do
    /// processo: o monitor decide crash × parada limpa DEPOIS do processo sair).
    pub mc_event: Option<String>,
    pub mc_listener: Option<tauri::EventId>,
    pub last_net_error: Option<String>,
    /// Snapshot congelado de quando a sessão terminou (Idle/Crashed + erro).
    pub final_snapshot: Option<HostingSnapshot>,
    pub last_emitted: Option<HostingSnapshot>,
    /// Contagem de inatividade do wake-on-demand (só avança com ele armado).
    pub idle: IdleTracker,
}

fn lock_rt(state: &AppState) -> std::sync::MutexGuard<'_, HostingRuntime> {
    state.hosting.lock().unwrap_or_else(|e| e.into_inner())
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn build_snapshot(rt: &HostingRuntime, mc: McState, net: NetState, ip: Option<String>) -> HostingSnapshot {
    let net_failed = rt.tracker.retry.has_failed() || rt.last_net_error.is_some();
    let phase = derive_phase(&PhaseInputs {
        stopping: rt.stopping,
        mc_crashed_final: false,
        mc,
        want_network: rt.want_network,
        net,
        net_failed,
    });
    let now = Instant::now();
    let retry_at = rt.tracker.retry.wait_until.map(|t| {
        let remaining = t.saturating_duration_since(now);
        unix_ms() + remaining.as_millis() as u64
    });
    HostingSnapshot {
        phase,
        mc: mc.as_str(),
        net: net.as_str(),
        local_only_reason: if phase == HostingPhase::LocalOnly {
            Some(local_only_reason(rt.want_network, rt.tracker.ever_online))
        } else {
            None
        },
        net_retrying: rt.net_task_running,
        net_retry_at_ms: retry_at,
        net_gave_up: rt.tracker.retry.gave_up,
        net_error: rt.last_net_error.clone(),
        error: rt.mc_start_error.clone(),
        short_code: rt.cfg.as_ref().map(|c| c.short_code.clone()),
        server_name: rt.cfg.as_ref().map(|c| c.name.clone()),
        ip,
        wake_paused: false,
    }
}

fn final_snapshot(rt: &HostingRuntime, phase: HostingPhase, error: Option<String>) -> HostingSnapshot {
    HostingSnapshot {
        phase,
        mc: if phase == HostingPhase::Crashed { "crashed" } else { "offline" },
        net: "off",
        local_only_reason: None,
        net_retrying: false,
        net_retry_at_ms: None,
        net_gave_up: false,
        net_error: None,
        error,
        short_code: rt.cfg.as_ref().map(|c| c.short_code.clone()),
        server_name: rt.cfg.as_ref().map(|c| c.name.clone()),
        ip: None,
        wake_paused: false,
    }
}

// ------------------------------------------------------------
// Leitura do estado real
// ------------------------------------------------------------

/// Estado do processo Minecraft a partir do `AppState`. É a mesma regra que
/// `get_system_status` sempre usou (agora compartilhada): processo vivo ≠
/// servidor pronto — "online" só depois de `minecraft_was_online`.
pub fn mc_state_from_app(state: &AppState) -> McState {
    enum Proc {
        Alive,
        NoProcess,
        CrashExit,
    }
    let classify = |guard: &mut Option<Box<dyn portable_pty::Child + Send>>| match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => Proc::Alive,
            Ok(Some(status)) => {
                if status.success() {
                    Proc::NoProcess
                } else {
                    Proc::CrashExit
                }
            }
            Err(_) => Proc::NoProcess,
        },
        None => Proc::NoProcess,
    };
    let proc_state = match state.minecraft_process.try_lock() {
        Ok(mut guard) => classify(&mut guard),
        Err(std::sync::TryLockError::Poisoned(e)) => classify(&mut e.into_inner()),
        // A thread de monitoramento só segura o lock durante child.wait(): lock
        // ocupado = processo ainda vivo.
        Err(std::sync::TryLockError::WouldBlock) => Proc::Alive,
    };
    match proc_state {
        Proc::NoProcess => McState::Offline,
        Proc::CrashExit => McState::Crashed,
        Proc::Alive => {
            if state.minecraft_was_online.load(Ordering::SeqCst) {
                McState::Online
            } else {
                McState::Starting
            }
        }
    }
}

pub fn net_state_from_app(state: &AppState) -> (NetState, Option<String>) {
    let ip = state.network_ip.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if ip.is_some() {
        return (NetState::Online, ip);
    }
    let sidecar = state.sidecar_process.lock().unwrap_or_else(|e| e.into_inner()).is_some();
    let mock = *state.is_mock_active.lock().unwrap_or_else(|e| e.into_inner());
    if sidecar || mock {
        (NetState::Connecting, None)
    } else {
        (NetState::Off, None)
    }
}

/// `server-port` do server.properties (25565 se ausente/ilegível/inválido).
/// Lido aqui, no backend, no momento de subir: a UI não precisa (nem deve)
/// repassar uma porta que pode estar desatualizada.
pub fn parse_server_port(contents: &str) -> u16 {
    for line in contents.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("server-port") {
            if let Some(v) = rest.trim_start().strip_prefix('=') {
                if let Ok(p) = v.trim().parse::<u16>() {
                    if p != 0 {
                        return p;
                    }
                }
            }
        }
    }
    25565
}

fn read_server_port(server_dir: &str) -> u16 {
    std::fs::read_to_string(std::path::Path::new(server_dir).join("server.properties"))
        .map(|c| parse_server_port(&c))
        .unwrap_or(25565)
}

// ------------------------------------------------------------
// Emissão de status
// ------------------------------------------------------------

fn current_snapshot(app: &tauri::AppHandle) -> HostingSnapshot {
    let state = app.state::<AppState>();
    let mc = mc_state_from_app(&state);
    let (net, ip) = net_state_from_app(&state);
    let wake_paused = state.wake_paused.load(Ordering::SeqCst);
    let rt = lock_rt(&state);
    let mut snap = if !rt.active {
        rt.final_snapshot.clone().unwrap_or_default()
    } else {
        build_snapshot(&rt, mc, net, ip)
    };
    snap.wake_paused = wake_paused;
    snap
}

/// Emite `hosting-status` só quando algo mudou (o supervisor chama todo tick).
fn emit_if_changed(app: &tauri::AppHandle) {
    let snap = current_snapshot(app);
    let state = app.state::<AppState>();
    let changed = {
        let mut rt = lock_rt(&state);
        if rt.last_emitted.as_ref() == Some(&snap) {
            false
        } else {
            rt.last_emitted = Some(snap.clone());
            true
        }
    };
    if changed {
        let _ = app.emit("hosting-status", snap);
    }
}

// ------------------------------------------------------------
// Tasks (Minecraft, rede) e supervisor
// ------------------------------------------------------------

async fn register_server_best_effort(app: &tauri::AppHandle, cfg: &HostingConfig) {
    // Servidor sem código de convite (nunca registrado): nada a registrar.
    if cfg.short_code.is_empty() {
        return;
    }
    let telemetry = app.state::<Arc<Mutex<SyncTelemetry>>>();
    // sync_register_server já degrada para "QUEUED" quando a API está fora —
    // aqui só registramos em log o erro inesperado; nunca bloqueia a hospedagem.
    if let Err(e) = sync_register_server(
        app.clone(),
        app.state::<AppState>(),
        telemetry,
        cfg.name.clone(),
        cfg.version.clone(),
        cfg.server_type.clone(),
        cfg.description.clone(),
        Some(cfg.short_code.clone()),
        None,
        cfg.forge_version.clone(),
        cfg.mod_loader_version.clone(),
        Some(cfg.server_dir.clone()),
    )
    .await
    {
        log_to_file(app, &format!("[Hosting] Falha ao registrar servidor: {}", e));
    }
}

fn spawn_minecraft_task(app: &tauri::AppHandle, generation: u64, cfg: Arc<HostingConfig>) {
    let app2 = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let port = read_server_port(&cfg.server_dir);
        let result = start_minecraft_server(
            app2.clone(),
            app2.state::<AppState>(),
            cfg.server_dir.clone(),
            cfg.java_path.clone(),
            cfg.ram_gb,
            port,
            cfg.server_jar_name.clone(),
            cfg.launch_args_dir.clone(),
        )
        .await;
        let state = app2.state::<AppState>();
        let mut rt = lock_rt(&state);
        if rt.generation != generation {
            return;
        }
        match result {
            Ok(()) => rt.mc_launch_done = true,
            Err(e) => {
                log_to_file(&app2, &format!("[Hosting] Falha ao iniciar o Minecraft: {}", e));
                rt.mc_start_error = Some(e);
            }
        }
    });
    let state = app.state::<AppState>();
    let mut rt = lock_rt(&state);
    if rt.generation == generation {
        rt.mc_task = Some(handle);
    } else {
        handle.abort();
    }
}

fn spawn_network_task(app: &tauri::AppHandle, generation: u64) {
    let state = app.state::<AppState>();
    let (cfg, id) = {
        let mut rt = lock_rt(&state);
        if !rt.active || rt.stopping || rt.generation != generation || rt.net_task_running {
            return;
        }
        let Some(cfg) = rt.cfg.clone() else { return };
        rt.net_task_running = true;
        rt.net_task_id += 1;
        (cfg, rt.net_task_id)
    };

    let app2 = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        register_server_best_effort(&app2, &cfg).await;
        let port = read_server_port(&cfg.server_dir);
        let result = start_network_node_with_retry(
            app2.clone(),
            "host".to_string(),
            cfg.short_code.clone(),
            None,
            port,
        )
        .await;
        let state = app2.state::<AppState>();
        let mut rt = lock_rt(&state);
        if rt.generation != generation || rt.net_task_id != id {
            return;
        }
        rt.net_task_running = false;
        if let Err(e) = result {
            log_to_file(&app2, &format!("[Hosting] Rede não subiu: {}", e));
            rt.tracker.retry.record_failure(Instant::now());
            rt.last_net_error = Some(e);
        }
    });

    let mut rt = lock_rt(&state);
    if rt.generation == generation && rt.net_task_id == id {
        rt.net_task = Some(handle);
    } else {
        handle.abort();
    }
}

/// Aborta e AGUARDA uma task: depois disto ela não executa mais nada (sem isso,
/// uma tentativa de rede cancelada poderia ainda subir um sidecar logo depois
/// da parada).
async fn abort_and_join(handle: Option<tauri::async_runtime::JoinHandle<()>>) {
    if let Some(h) = handle {
        h.abort();
        let _ = h.await;
    }
}

fn unlisten_mc(app: &tauri::AppHandle, id: Option<tauri::EventId>) {
    if let Some(id) = id {
        app.unlisten(id);
    }
}

/// Derruba o que resta da sessão do `generation` dado e congela o snapshot
/// final. Se a sessão já foi trocada/parada por outro caminho, não faz nada.
///
/// O CHAMADOR deve segurar `AppState::hosting_lifecycle`: é isso que impede um
/// stop/start concorrente de intercalar com o teardown (e deste encerrar, ao
/// terminar, uma sessão nova que já tomou o lugar da antiga).
async fn finalize(
    app: &tauri::AppHandle,
    generation: u64,
    stop_minecraft: bool,
    phase: HostingPhase,
    error: Option<String>,
) {
    let (net_task, mc_task, listener) = {
        let state = app.state::<AppState>();
        let mut rt = lock_rt(&state);
        if rt.generation != generation || !rt.active {
            return;
        }
        // Invalida o supervisor/tasks desta sessão já (qualquer escrita tardia
        // delas vê generation diferente e descarta).
        rt.generation += 1;
        (rt.net_task.take(), rt.mc_task.take(), rt.mc_listener.take())
    };
    unlisten_mc(app, listener);
    abort_and_join(net_task).await;
    abort_and_join(mc_task).await;

    let state = app.state::<AppState>();
    if stop_minecraft {
        stop_minecraft_server_internal(app, &state).await;
    }
    let _ = stop_network_node_internal(app, &state).await;

    {
        let mut rt = lock_rt(&state);
        let snap = final_snapshot(&rt, phase, error);
        rt.active = false;
        rt.stopping = false;
        rt.net_task_running = false;
        rt.final_snapshot = Some(snap);
    }
    emit_if_changed(app);
    // Fim limpo (parada, `/stop` no console, falha ao iniciar): um servidor com
    // wake-on-demand armado volta ao modo de espera. Crash não — mostrar
    // "dormindo" esconderia o problema dos convidados e reiniciaria o que travou.
    if phase == HostingPhase::Idle {
        resume_sleeping_if_armed(app);
    }
}

/// A sessão desta `generation` ainda é a vigente (ativa e não em parada)?
fn session_is_current(state: &AppState, generation: u64) -> bool {
    let rt = lock_rt(state);
    rt.active && !rt.stopping && rt.generation == generation
}

/// Há uma sessão de hospedagem (iniciando, rodando ou parando) agora?
pub fn session_active(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    let rt = lock_rt(&state);
    rt.active
}

/// Com o wake-on-demand armado, reabre o loop de espera (heartbeat "sleeping").
pub fn resume_sleeping_if_armed(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let cfg = state.wake_on_demand.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(cfg) = cfg {
        let generation = state.wake_loop_generation.fetch_add(1, Ordering::SeqCst) + 1;
        log_to_file(app, "[WakeOnDemand] Sessão encerrada — voltando ao modo de espera.");
        spawn_sleeping_loop(app.clone(), cfg, generation);
    }
}

async fn supervise(app: tauri::AppHandle, generation: u64) {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let state = app.state::<AppState>();
        if state.is_shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let mc = mc_state_from_app(&state);
        let (net, _) = net_state_from_app(&state);
        let now = Instant::now();

        let action = {
            let mut rt = lock_rt(&state);
            if !rt.active || rt.stopping || rt.generation != generation {
                return;
            }
            let want_network = rt.want_network;
            if want_network {
                rt.tracker.observe(net, now);
            }
            decide(&TickInputs {
                mc,
                mc_launch_done: rt.mc_launch_done,
                mc_start_failed: rt.mc_start_error.is_some(),
                want_network,
                net,
                net_task_running: rt.net_task_running,
                connecting_for: rt.tracker.connecting_since.map(|t| now.saturating_duration_since(t)),
                retry_gave_up: rt.tracker.retry.gave_up,
                retry_wait_until: rt.tracker.retry.wait_until,
                now,
            })
        };

        match action {
            TickAction::None => {}
            TickAction::StartNetwork => spawn_network_task(&app, generation),
            TickAction::NetConnectTimeout => {
                log_to_file(&app, "[Hosting] Rede sem IP há tempo demais — reiniciando o túnel.");
                let _ = stop_network_node_internal(&app, &state).await;
                let mut rt = lock_rt(&state);
                if rt.generation == generation {
                    rt.tracker.connecting_since = None;
                    rt.tracker.retry.record_failure(Instant::now());
                    rt.last_net_error = Some("connect_timeout".to_string());
                }
            }
            TickAction::McStartFailed => {
                let _life = state.hosting_lifecycle.lock().await;
                if !session_is_current(&state, generation) {
                    return;
                }
                let error = lock_rt(&state).mc_start_error.clone();
                finalize(&app, generation, true, HostingPhase::Idle, error).await;
                return;
            }
            TickAction::McEnded => {
                // Segura o ciclo de vida JÁ, antes da folga de classificação: um
                // "Iniciar" do usuário nesse intervalo espera o teardown terminar e
                // então inicia de verdade (em vez de ser tratado como "já rodando"
                // e engolido pelo finalize logo depois).
                let _life = state.hosting_lifecycle.lock().await;
                if !session_is_current(&state, generation) {
                    return;
                }
                // O monitor do Minecraft decide crash × parada limpa só DEPOIS do
                // processo sair; dá uma folga curta para o evento chegar.
                let deadline = Instant::now() + MC_CLASSIFY_GRACE;
                let crashed = loop {
                    let ev = lock_rt(&state).mc_event.clone();
                    match ev.as_deref() {
                        Some("crashed") => break true,
                        Some("offline") => break false,
                        _ => {}
                    }
                    if Instant::now() >= deadline {
                        break mc == McState::Crashed;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                };
                log_to_file(&app, &format!("[Hosting] Minecraft encerrou (crashed={}). Derrubando a rede.", crashed));
                let phase = if crashed { HostingPhase::Crashed } else { HostingPhase::Idle };
                finalize(&app, generation, false, phase, None).await;
                return;
            }
        }

        // Wake-on-demand: auto-shutdown por inatividade. Só com o recurso armado
        // e o Minecraft de fato online; hospedagem comum fica exatamente igual.
        let wake_cfg = state.wake_on_demand.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let idle_action = {
            let mut rt = lock_rt(&state);
            if rt.generation != generation {
                return;
            }
            match (wake_cfg, mc) {
                (Some(w), McState::Online) => {
                    let players = state.minecraft_online_players.lock().unwrap_or_else(|e| e.into_inner()).len() as u32;
                    let reset = state.idle_shutdown_reset_requested.swap(false, Ordering::SeqCst);
                    let timeout = Duration::from_secs(u64::from(w.idle_timeout_minutes.max(1)) * 60);
                    rt.idle.observe(players, reset, now, timeout)
                }
                _ => {
                    rt.idle = IdleTracker::default();
                    IdleAction::None
                }
            }
        };
        match idle_action {
            IdleAction::None => {}
            IdleAction::Warn => {
                let _ = app.emit("idle-shutdown-warning", serde_json::json!({ "secondsRemaining": 60 }));
            }
            IdleAction::Shutdown => {
                log_to_file(&app, "[WakeOnDemand] Desligando por inatividade, voltando ao modo de espera.");
                // stop_hosting para na ordem certa e já devolve o servidor à espera.
                let _ = stop_hosting_impl(&app, false).await;
                return;
            }
        }
        emit_if_changed(&app);
    }
}

// ------------------------------------------------------------
// Comandos
// ------------------------------------------------------------

/// Liga o servidor Minecraft e (a menos que `local_only`) a rede mesh, juntos.
/// Retorna assim que a sessão é aceita; o progresso vem por `hosting-status`.
///
/// Erros síncronos (a UI decide o que mostrar): [`ERR_GUEST_ACTIVE`] quando
/// este app é convidado de outro servidor e `leave_guest` é falso; demais são
/// mensagens já traduzidas.
#[tauri::command]
pub async fn start_hosting(
    app: tauri::AppHandle,
    config: HostingConfig,
    local_only: bool,
    leave_guest: bool,
) -> Result<(), String> {
    begin_hosting(app, config, local_only, leave_guest).await
}

/// Implementação de `start_hosting`, também usada pelo despertar do
/// wake-on-demand (ver `wake_from_sleep` em lib.rs) — um único caminho de
/// início para tudo.
pub async fn begin_hosting(
    app: tauri::AppHandle,
    config: HostingConfig,
    local_only: bool,
    leave_guest: bool,
) -> Result<(), String> {
    let state = app.state::<AppState>();

    if !std::path::Path::new(&config.server_dir).is_dir() {
        return Err(tr!("hosting.err.noServerDir", dir = config.server_dir));
    }
    if !std::path::Path::new(&config.java_path).exists() {
        return Err(tr!("hosting.err.noJava"));
    }

    // Sem código de convite não há como a rede apontar para este servidor: sobe
    // só local (a UI avisa) em vez de falhar em loop.
    let local_only = local_only || config.short_code.is_empty();
    let cfg = Arc::new(config);

    // Espera qualquer parada/teardown em andamento terminar e impede outro ciclo
    // de vida de intercalar com este início (ver AppState::hosting_lifecycle).
    let _life = state.hosting_lifecycle.lock().await;

    // Reivindica a sessão de forma atômica: dois cliques rápidos (ou duas
    // abas/janelas) nunca iniciam duas hospedagens.
    let generation = {
        let mut rt = lock_rt(&state);
        if rt.active {
            if rt.stopping {
                return Err(tr!("hosting.err.stopping"));
            }
            let same = rt.cfg.as_ref().map(|c| c.server_dir == cfg.server_dir).unwrap_or(false);
            return if same { Ok(()) } else { Err(tr!("hosting.err.alreadyRunning")) };
        }
        let next_gen = rt.generation + 1;
        *rt = HostingRuntime {
            active: true,
            generation: next_gen,
            cfg: Some(cfg.clone()),
            want_network: !local_only,
            ..Default::default()
        };
        next_gen
    };

    // Papel de rede: este app não pode ser host e convidado ao mesmo tempo.
    let active_mode = state.active_network_mode.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if active_mode.as_deref() == Some("guest") {
        if !leave_guest {
            let mut rt = lock_rt(&state);
            if rt.generation == generation {
                *rt = HostingRuntime { generation, ..Default::default() };
            }
            return Err(ERR_GUEST_ACTIVE.to_string());
        }
        let _ = stop_network_node_internal(&app, &state).await;
    }

    // Classifica o fim do processo (crash × limpo) — ver HostingRuntime::mc_event.
    let app_for_event = app.clone();
    let listener = app.listen("minecraft-status-changed", move |event| {
        let status = event.payload().trim_matches('"').to_string();
        let state = app_for_event.state::<AppState>();
        let mut rt = lock_rt(&state);
        if rt.generation == generation && rt.active && rt.mc_launch_done {
            rt.mc_event = Some(status);
        }
    });
    {
        let mut rt = lock_rt(&state);
        if rt.generation == generation {
            rt.mc_listener = Some(listener);
        } else {
            app.unlisten(listener);
        }
    }

    // `report_mc_status` e a rota mesh "GET /mods" dependem destes dois valores
    // já a partir do primeiro status "starting" — não esperar o registro na API.
    if !cfg.short_code.is_empty() {
        *state.active_short_code.lock().unwrap_or_else(|e| e.into_inner()) = Some(cfg.short_code.clone());
    }
    *state.active_server_dir.lock().unwrap_or_else(|e| e.into_inner()) = Some(cfg.server_dir.clone());

    log_to_file(
        &app,
        &format!("=== HOSPEDAGEM (servidor={}, localOnly={}, gen={}) ===", cfg.name, local_only, generation),
    );

    // Comprometido com a sessão: o loop de espera do wake-on-demand (se houver)
    // para de anunciar "sleeping" — o status real passa a vir do Minecraft. Só
    // aqui, depois dos retornos que podem recusar (convidado ativo), para uma
    // recusa não deixar o servidor armado sem ninguém em espera.
    state.wake_loop_generation.fetch_add(1, Ordering::SeqCst);
    // Iniciar à mão encerra a pausa: o wake-on-demand volta a valer a partir daqui.
    state.wake_paused.store(false, Ordering::SeqCst);

    spawn_minecraft_task(&app, generation, cfg.clone());
    if local_only {
        // Mesmo sem rede, o convidado precisa enxergar o status na API Central.
        let app2 = app.clone();
        let cfg2 = cfg.clone();
        tauri::async_runtime::spawn(async move {
            register_server_best_effort(&app2, &cfg2).await;
        });
    } else {
        spawn_network_task(&app, generation);
    }
    tauri::async_runtime::spawn(supervise(app.clone(), generation));
    emit_if_changed(&app);
    Ok(())
}

/// Para tudo na ordem certa: Minecraft (com `stop` gracioso, salva o mundo) e
/// só depois a rede. Idempotente.
#[tauri::command]
pub async fn stop_hosting(app: tauri::AppHandle) -> Result<(), String> {
    // Vindo do comando (botão Parar) a parada é do USUÁRIO.
    stop_hosting_impl(&app, true).await
}

/// `by_user`: a parada foi pedida pelo usuário (decide se a espera do
/// wake-on-demand pausa ou continua — ver `wake_after_stop`). O desligamento por
/// inatividade chama com `false`.
async fn stop_hosting_impl(app: &tauri::AppHandle, by_user: bool) -> Result<(), String> {
    let app = app.clone();
    let state = app.state::<AppState>();
    // Um teardown já em curso (ex.: crash) termina antes; ao entrar aqui a sessão
    // dele já foi encerrada e cai no caminho "sem sessão" — sem sobrescrever o
    // snapshot final (Crashed) nem competir pela rede.
    let _life = state.hosting_lifecycle.lock().await;
    // O guard do Mutex não pode atravessar um `.await` (a future precisa ser
    // Send): decide o plano dentro do bloco e executa fora dele.
    enum Plan {
        AlreadyStopping,
        NoSession,
        Session(u64, Option<tauri::async_runtime::JoinHandle<()>>, Option<tauri::async_runtime::JoinHandle<()>>, Option<tauri::EventId>),
    }
    let plan = {
        let mut rt = lock_rt(&state);
        if rt.stopping {
            Plan::AlreadyStopping
        } else if !rt.active {
            Plan::NoSession
        } else {
            rt.stopping = true;
            // Invalida o supervisor e as tasks desta sessão.
            rt.generation += 1;
            Plan::Session(rt.generation, rt.net_task.take(), rt.mc_task.take(), rt.mc_listener.take())
        }
    };
    let (generation, net_task, mc_task, listener) = match plan {
        Plan::AlreadyStopping => return Ok(()),
        Plan::NoSession => {
            // Nenhuma sessão do orquestrador, mas pode haver um Minecraft/rede de
            // host de outro caminho (ex.: wake-on-demand, ou estado de antes de um
            // reload). "Parar" precisa valer para qualquer um deles — ambos são
            // idempotentes quando não há nada rodando.
            stop_minecraft_server_internal(&app, &state).await;
            let host_net = state.active_network_mode.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some("host");
            if host_net {
                let _ = stop_network_node_internal(&app, &state).await;
            }
            return Ok(());
        }
        Plan::Session(g, n, m, l) => (g, n, m, l),
    };
    unlisten_mc(&app, listener);
    emit_if_changed(&app);

    // Primeiro as tasks de subida (sem elas, nada novo nasce durante a parada)…
    abort_and_join(net_task).await;
    abort_and_join(mc_task).await;
    // …depois o Minecraft (até ~15 s para salvar) e por fim a rede.
    stop_minecraft_server_internal(&app, &state).await;
    let _ = stop_network_node_internal(&app, &state).await;

    {
        let mut rt = lock_rt(&state);
        if rt.generation == generation {
            let snap = final_snapshot(&rt, HostingPhase::Idle, None);
            rt.active = false;
            rt.stopping = false;
            rt.net_task_running = false;
            rt.final_snapshot = Some(snap);
        }
    }
    // Com o wake-on-demand armado: parada do usuário PAUSA a espera (e a UI avisa
    // claramente); inatividade/fim limpo volta à espera. A flag entra no snapshot,
    // então precisa ser gravada ANTES de emitir.
    let armed = state.wake_on_demand.lock().unwrap_or_else(|e| e.into_inner()).is_some();
    let wake_action = wake_after_stop(armed, by_user);
    state.wake_paused.store(wake_action == WakeAfterStop::PauseStandby, Ordering::SeqCst);
    emit_if_changed(&app);
    if wake_action == WakeAfterStop::ResumeStandby {
        resume_sleeping_if_armed(&app);
    }
    Ok(())
}

/// "Voltar à espera": o usuário pausou o wake-on-demand ao parar o servidor e
/// agora quer que amigos possam acordá-lo de novo.
#[tauri::command]
pub async fn resume_wake_standby(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    // Mesmo lock das demais operações: não reabrir a espera no meio de um início.
    let _life = state.hosting_lifecycle.lock().await;
    if lock_rt(&state).active {
        return Err(tr!("hosting.err.alreadyRunning"));
    }
    state.wake_paused.store(false, Ordering::SeqCst);
    resume_sleeping_if_armed(&app);
    emit_if_changed(&app);
    Ok(())
}

/// Limpa a pausa (iniciar à mão, armar ou desarmar o wake-on-demand) e avisa a UI.
pub fn clear_wake_paused(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.wake_paused.swap(false, Ordering::SeqCst) {
        emit_if_changed(app);
    }
}

/// "Tentar de novo" / "Abrir para amigos": retoma (ou liga pela primeira vez,
/// se a sessão foi iniciada como só-local) a rede, zerando o backoff.
#[tauri::command]
pub async fn retry_hosting_network(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut rt = lock_rt(&state);
        if !rt.active || rt.stopping {
            return Err(tr!("hosting.err.notRunning"));
        }
        rt.want_network = true;
        rt.tracker.retry.reset();
        rt.tracker.connecting_since = None;
        rt.last_net_error = None;
    }
    emit_if_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn get_hosting_status(app: tauri::AppHandle) -> HostingSnapshot {
    current_snapshot(&app)
}

// ------------------------------------------------------------
// Testes das partes puras
// ------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> TickInputs {
        TickInputs {
            mc: McState::Online,
            mc_launch_done: true,
            mc_start_failed: false,
            want_network: true,
            net: NetState::Off,
            net_task_running: false,
            connecting_for: None,
            retry_gave_up: false,
            retry_wait_until: None,
            now: Instant::now(),
        }
    }

    fn phase(mc: McState, want: bool, net: NetState, failed: bool) -> HostingPhase {
        derive_phase(&PhaseInputs { stopping: false, mc_crashed_final: false, mc, want_network: want, net, net_failed: failed })
    }

    // ---- derive_phase ----

    #[test]
    fn phase_starting_until_minecraft_is_online() {
        assert_eq!(phase(McState::Offline, true, NetState::Off, false), HostingPhase::Starting);
        assert_eq!(phase(McState::Starting, true, NetState::Online, false), HostingPhase::Starting);
    }

    #[test]
    fn phase_online_friends_needs_both() {
        assert_eq!(phase(McState::Online, true, NetState::Online, false), HostingPhase::OnlineFriends);
    }

    #[test]
    fn phase_connecting_then_local_only_after_failure() {
        assert_eq!(phase(McState::Online, true, NetState::Connecting, false), HostingPhase::Connecting);
        assert_eq!(phase(McState::Online, true, NetState::Off, false), HostingPhase::Connecting);
        assert_eq!(phase(McState::Online, true, NetState::Off, true), HostingPhase::LocalOnly);
    }

    #[test]
    fn phase_local_only_by_choice_ignores_network() {
        assert_eq!(phase(McState::Online, false, NetState::Off, false), HostingPhase::LocalOnly);
    }

    #[test]
    fn phase_stopping_and_crashed_win() {
        let stopping = PhaseInputs { stopping: true, mc_crashed_final: true, mc: McState::Online, want_network: true, net: NetState::Online, net_failed: false };
        assert_eq!(derive_phase(&stopping), HostingPhase::Stopping);
        let crashed = PhaseInputs { stopping: false, mc_crashed_final: true, mc: McState::Online, want_network: true, net: NetState::Online, net_failed: false };
        assert_eq!(derive_phase(&crashed), HostingPhase::Crashed);
    }

    #[test]
    fn local_only_reason_distinguishes_choice_failure_and_drop() {
        assert_eq!(local_only_reason(false, false), "userChoice");
        assert_eq!(local_only_reason(true, false), "networkFailed");
        assert_eq!(local_only_reason(true, true), "networkDropped");
    }

    // ---- backoff ----

    #[test]
    fn backoff_grows_then_gives_up() {
        let secs: Vec<_> = (1..=5).map(|n| next_retry_delay(n).unwrap().as_secs()).collect();
        assert_eq!(secs, vec![10, 30, 60, 120, 300]);
        assert_eq!(next_retry_delay(6), None);
    }

    #[test]
    fn retry_gives_up_after_last_backoff_and_resets_manually() {
        let now = Instant::now();
        let mut r = NetRetry::default();
        for _ in 0..5 {
            r.record_failure(now);
            assert!(!r.gave_up);
            assert!(r.wait_until.is_some());
        }
        r.record_failure(now);
        assert!(r.gave_up);
        assert!(r.wait_until.is_none());
        r.reset();
        assert!(!r.has_failed());
    }

    // ---- NetTracker ----

    #[test]
    fn tracker_stable_online_clears_failures() {
        let t0 = Instant::now();
        let mut t = NetTracker::default();
        t.retry.record_failure(t0);
        t.observe(NetState::Online, t0);
        assert!(t.ever_online);
        assert!(t.retry.has_failed(), "ainda não está estável");
        t.observe(NetState::Online, t0 + NET_STABLE_AFTER);
        assert!(!t.retry.has_failed());
    }

    #[test]
    fn tracker_quick_drop_counts_as_failure_but_healthy_drop_does_not() {
        let t0 = Instant::now();
        let mut quick = NetTracker::default();
        quick.observe(NetState::Online, t0);
        quick.observe(NetState::Off, t0 + Duration::from_secs(5));
        assert_eq!(quick.retry.failures, 1, "queda rápida = falha (evita flapping)");
        assert!(quick.retry.wait_until.is_some());

        let mut healthy = NetTracker::default();
        healthy.observe(NetState::Online, t0);
        healthy.observe(NetState::Off, t0 + NET_STABLE_AFTER + Duration::from_secs(1));
        assert_eq!(healthy.retry.failures, 0);
        assert!(healthy.retry.wait_until.is_none(), "religa na hora");
    }

    #[test]
    fn tracker_records_connecting_since_and_clears_it() {
        let t0 = Instant::now();
        let mut t = NetTracker::default();
        t.observe(NetState::Connecting, t0);
        t.observe(NetState::Connecting, t0 + Duration::from_secs(30));
        assert_eq!(t.connecting_since, Some(t0), "não reinicia o relógio a cada tick");
        t.observe(NetState::Off, t0 + Duration::from_secs(31));
        assert_eq!(t.connecting_since, None);
    }

    // ---- decide ----

    #[test]
    fn decide_start_failure_wins_over_everything() {
        let mut i = inputs();
        i.mc_start_failed = true;
        assert_eq!(decide(&i), TickAction::McStartFailed);
    }

    #[test]
    fn decide_minecraft_ending_tears_down_but_only_after_launch() {
        let mut i = inputs();
        i.mc = McState::Offline;
        i.mc_launch_done = false;
        assert_ne!(decide(&i), TickAction::McEnded, "processo ainda não nasceu");
        i.mc_launch_done = true;
        assert_eq!(decide(&i), TickAction::McEnded);
        i.mc = McState::Crashed;
        assert_eq!(decide(&i), TickAction::McEnded);
    }

    #[test]
    fn decide_network_failure_never_ends_minecraft() {
        let mut i = inputs();
        i.net = NetState::Off;
        i.retry_gave_up = true;
        assert_eq!(decide(&i), TickAction::None);
    }

    #[test]
    fn decide_starts_network_first_time_and_respects_backoff() {
        let mut i = inputs();
        assert_eq!(decide(&i), TickAction::StartNetwork);
        i.retry_wait_until = Some(i.now + Duration::from_secs(10));
        assert_eq!(decide(&i), TickAction::None);
        i.retry_wait_until = Some(i.now - Duration::from_secs(1));
        assert_eq!(decide(&i), TickAction::StartNetwork);
    }

    #[test]
    fn decide_does_not_trample_a_network_attempt_in_flight() {
        let mut i = inputs();
        i.net_task_running = true;
        assert_eq!(decide(&i), TickAction::None);
    }

    #[test]
    fn decide_local_only_choice_never_starts_network() {
        let mut i = inputs();
        i.want_network = false;
        assert_eq!(decide(&i), TickAction::None);
    }

    #[test]
    fn decide_connect_timeout_only_when_stuck_without_ip() {
        let mut i = inputs();
        i.net = NetState::Connecting;
        i.connecting_for = Some(Duration::from_secs(10));
        assert_eq!(decide(&i), TickAction::None);
        i.connecting_for = Some(NET_CONNECT_TIMEOUT);
        assert_eq!(decide(&i), TickAction::NetConnectTimeout);
    }

    #[test]
    fn decide_online_network_is_left_alone() {
        let mut i = inputs();
        i.net = NetState::Online;
        assert_eq!(decide(&i), TickAction::None);
    }

    // ---- server.properties ----

    #[test]
    fn server_port_parsing_and_fallbacks() {
        assert_eq!(parse_server_port("motd=x\nserver-port=25570\n"), 25570);
        assert_eq!(parse_server_port("server-port = 30000"), 30000);
        assert_eq!(parse_server_port(""), 25565);
        assert_eq!(parse_server_port("server-port=abc"), 25565);
        assert_eq!(parse_server_port("server-port=0"), 25565);
        assert_eq!(parse_server_port("server-port=99999"), 25565);
        assert_eq!(parse_server_port("# server-port=1234"), 25565);
        assert_eq!(parse_server_port("query.port=1234\nserver-port=25566"), 25566);
    }
}

#[cfg(test)]
mod idle_tests {
    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(15 * 60);

    fn at(base: Instant, secs: u64) -> Instant {
        base + Duration::from_secs(secs)
    }

    #[test]
    fn idle_warns_one_minute_before_and_shuts_down_at_timeout() {
        let t0 = Instant::now();
        let mut t = IdleTracker::default();
        assert_eq!(t.observe(0, false, at(t0, 0), TIMEOUT), IdleAction::None);
        assert_eq!(t.observe(0, false, at(t0, 14 * 60 - 1), TIMEOUT), IdleAction::None);
        assert_eq!(t.observe(0, false, at(t0, 14 * 60), TIMEOUT), IdleAction::Warn);
        assert_eq!(t.observe(0, false, at(t0, 14 * 60 + 1), TIMEOUT), IdleAction::None, "avisa uma vez só");
        assert_eq!(t.observe(0, false, at(t0, 15 * 60), TIMEOUT), IdleAction::Shutdown);
    }

    #[test]
    fn a_player_joining_restarts_the_count_and_rearms_the_warning() {
        let t0 = Instant::now();
        let mut t = IdleTracker::default();
        t.observe(0, false, at(t0, 0), TIMEOUT);
        assert_eq!(t.observe(0, false, at(t0, 14 * 60), TIMEOUT), IdleAction::Warn);
        assert_eq!(t.observe(1, false, at(t0, 14 * 60 + 5), TIMEOUT), IdleAction::None);
        assert!(t.idle_since.is_none());
        // Sala esvazia de novo: nova contagem inteira, e o aviso volta a valer.
        assert_eq!(t.observe(0, false, at(t0, 20 * 60), TIMEOUT), IdleAction::None);
        assert_eq!(t.observe(0, false, at(t0, 20 * 60 + 14 * 60), TIMEOUT), IdleAction::Warn);
    }

    #[test]
    fn keep_running_restarts_from_now_instead_of_shutting_down() {
        let t0 = Instant::now();
        let mut t = IdleTracker::default();
        t.observe(0, false, at(t0, 0), TIMEOUT);
        assert_eq!(t.observe(0, true, at(t0, 14 * 60 + 30), TIMEOUT), IdleAction::None);
        // Pouco depois do reset NÃO pode avisar nem desligar.
        assert_eq!(t.observe(0, false, at(t0, 14 * 60 + 40), TIMEOUT), IdleAction::None);
        assert_eq!(t.observe(0, false, at(t0, 14 * 60 + 30 + 14 * 60), TIMEOUT), IdleAction::Warn);
    }

    #[test]
    fn short_timeouts_have_no_warning_but_still_shut_down() {
        let t0 = Instant::now();
        let short = Duration::from_secs(60);
        let mut t = IdleTracker::default();
        assert_eq!(t.observe(0, false, at(t0, 0), short), IdleAction::None);
        assert_eq!(t.observe(0, false, at(t0, 30), short), IdleAction::None);
        assert_eq!(t.observe(0, false, at(t0, 60), short), IdleAction::Shutdown);
    }
}

#[cfg(test)]
mod wake_rule_tests {
    use super::*;

    #[test]
    fn user_stop_pauses_standby_but_other_endings_resume_it() {
        assert_eq!(wake_after_stop(true, true), WakeAfterStop::PauseStandby);
        assert_eq!(wake_after_stop(true, false), WakeAfterStop::ResumeStandby);
    }

    #[test]
    fn without_wake_armed_nothing_happens() {
        assert_eq!(wake_after_stop(false, true), WakeAfterStop::Nothing);
        assert_eq!(wake_after_stop(false, false), WakeAfterStop::Nothing);
    }
}
