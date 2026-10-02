// ============================================================
// Painel Web Remoto (Cubicase Plus) — Fase 0 + Fase 1 + Fase 2 + Fase 3 (métricas)
// ============================================================
// Ver plans/remote-web-panel-plan.md para o desenho completo. Este módulo é
// o lado "agent" do protocolo: conecta (sempre de dentro pra fora, contorna
// CGNAT/firewall igual ao tsnet) no Durable Object HostChannel do Worker
// (api/src/durable-objects/host-channel.ts), envia status/console/lista de
// servidores locais/métricas de CPU-RAM em tempo real, e agora também
// executa comandos vindos do painel (Fase 2 — ver handle_incoming_message):
//   - "command"      -> stdin do processo Minecraft já em execução
//   - "stop_server"  -> para o processo em execução (mesma rotina do botão
//                       "Parar" local)
//   - "start_server" -> NÃO reimplementa em Rust a checagem/instalação de
//                       JRE e resolução de porta/RAM (isso é orquestrado em
//                       TypeScript, src/lib/server.ts:startServerOrchestrated,
//                       reaproveitando o mesmo código do botão "Iniciar
//                       Servidor"). Em vez disso, emite o evento Tauri
//                       "panel-start-server-request" pro frontend — que
//                       continua rodando mesmo com a janela minimizada pro
//                       tray, contanto que o Cubicase esteja aberto (mesma
//                       premissa do recurso desde o início).
//
// Métricas (Fase 3): não existe uma segunda coleta de CPU/RAM só para o
// painel — build_metrics_message só lê `state.minecraft_last_resource_sample`,
// a mesma amostra que a thread de monitoramento em lib.rs já mantém a cada
// 15s enquanto o servidor está rodando (usada também para diagnóstico de
// crash). Enviada junto do poll de status (ver STATUS_POLL_SECS).
//
// Autenticação: usa um `device_token` (não é sessão de usuário) persistido
// em `panel_device.json` na pasta de dados do app — o mesmo arquivo é
// escrito pelo frontend (src/lib/panelDevice.ts) depois de registrar o
// dispositivo no Supabase com a sessão do usuário logado. Mesmo padrão já
// usado pelo `network_session.json` (ver CLAUDE.md): arquivo local lido
// pelo backend, sem o Rust precisar falar com o Supabase diretamente.
//
// Conecta sempre que houver um dispositivo pareado, independente de já
// estar hospedando ou não — o próprio objetivo do painel é ligar um
// servidor que está PARADO (ver plans/remote-web-panel-plan.md, Fase 2:
// start_server), então a conexão não pode depender da rede mesh já estar
// ativa, senão nunca haveria como receber esse comando em primeiro lugar.
// Não tenta adivinhar se a assinatura Plus está ativa — isso é
// responsabilidade do Durable Object (ver verifyDeviceToken em
// host-channel.ts), que fecha a conexão se a assinatura tiver expirado
// mesmo com o device_token válido.
// ============================================================

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::UnboundedSender;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::{log_to_file, players, send_minecraft_command, stop_minecraft_server_internal, AppState};

const PANEL_RELAY_WS_BASE: &str = "wss://cubeforge-api.cubeforge.workers.dev/panel/ws";

/// Endpoint do relay. Em build de DESENVOLVIMENTO, a variável de ambiente
/// `CUBICASE_PANEL_RELAY_WS` (ex: ws://localhost:8787/panel/ws) aponta o agent
/// para um `wrangler dev` local — para testar o painel sem publicar o Worker.
/// Em release (`tauri build`) a variável é ignorada: não há como redirecionar o
/// agent (e o device_token que ele envia) para outro servidor.
fn relay_ws_base() -> String {
    #[cfg(debug_assertions)]
    {
        if let Ok(v) = std::env::var("CUBICASE_PANEL_RELAY_WS") {
            let v = v.trim().trim_end_matches('/').to_string();
            if v.starts_with("ws://localhost") || v.starts_with("ws://127.0.0.1") {
                return v;
            }
        }
    }
    PANEL_RELAY_WS_BASE.to_string()
}
// 2s, 5s, 10s, 30s (máx) — mesma progressão descrita no plano, em vez de
// backoff exponencial puro (que demoraria demais pra tentar de novo em
// quedas curtas de rede, comuns num link doméstico).
const BACKOFF_STEPS_SECS: [u64; 4] = [2, 5, 10, 30];
const NO_DEVICE_RETRY_SECS: u64 = 5;
// Poll, não evento: ver comentário grande em cima de LOG_SINK sobre por que
// nada aqui usa AppHandle::listen. 5s (não 2s) de propósito, como margem
// extra depois de mover scan_local_servers (I/O de disco síncrono) pra
// spawn_blocking — ver build_server_list_message_async.
const STATUS_POLL_SECS: u64 = 5;

// ============================================================
// Por que log_line NÃO usa AppHandle::listen("minecraft-log", ...)
// ============================================================
// Uma versão anterior deste módulo registrava um listener Rust (`app.listen`)
// pros eventos "minecraft-log"/"minecraft-status-changed". Isso quebrou o
// console do Minecraft por completo (local E no painel, mesmo sem o painel
// estar em uso) — a suspeita forte é que listeners Rust do Tauri rodam
// SÍNCRONOS, dentro da própria chamada de `emit()`, e "minecraft-log" é
// emitido de dentro da thread nativa (`std::thread::spawn`, não uma task
// async) que lê a stdout do processo Java linha a linha em lib.rs. Qualquer
// travamento ali — mesmo um lock brevemente contestado — atrasa ou empaca
// essa thread crítica, e como ela nunca solta a leitura em caso de pane
// silenciosa, o console para de vez.
//
// Em vez de escutar o evento, o próprio ponto de emissão em lib.rs chama
// `push_minecraft_log_line` diretamente (uma linha adicionada logo depois do
// `emit` existente) — um sender trocado aqui, protegido por um Mutex normal
// (contenção mínima, nunca segurado durante I/O). Isso nunca participa do
// barramento de eventos do Tauri, então não tem como interferir com a
// entrega do evento pro frontend (que continua existindo, intocada).
//
// Por simetria e pelo mesmo motivo, status também deixou de depender do
// evento "minecraft-status-changed" — em vez de um listener, o loop principal
// já fazia polling a cada 20s (heartbeat) e agora faz a cada 2s, sempre
// lendo o estado atual direto do AppState. Mais simples, sem listener
// nenhum, e responsivo o bastante pro painel.
static LOG_SINK: OnceLock<Mutex<Option<UnboundedSender<String>>>> = OnceLock::new();

fn log_sink() -> &'static Mutex<Option<UnboundedSender<String>>> {
    LOG_SINK.get_or_init(|| Mutex::new(None))
}

/// Chamado por lib.rs logo depois de `app.emit("minecraft-log", &l)`, na
/// mesma thread nativa que lê a stdout do Java. Precisa ser barato e nunca
/// bloquear — só compara um Option e manda por um canal não-bloqueante.
pub(crate) fn push_minecraft_log_line(line: &str) {
    let guard = log_sink().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = guard.as_ref() {
        let msg = serde_json::json!({ "type": "log_line", "line": line, "ts": now_iso() }).to_string();
        let _ = tx.send(msg);
    }
}

#[derive(Deserialize, Clone)]
struct PanelDeviceFile {
    id: String,
    device_token: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalServerSummary {
    id: String,
    name: String,
    version: String,
    server_type: String,
    description: String,
    status: String, // "running" | "stopped"
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn load_panel_device(app: &AppHandle) -> Option<PanelDeviceFile> {
    let data_dir = app.path().app_local_data_dir().ok()?;
    let content = std::fs::read_to_string(data_dir.join("panel_device.json")).ok()?;
    serde_json::from_str(&content).ok()
}

#[derive(Deserialize, Default)]
struct ImportedServersMirror {
    #[serde(default)]
    paths: Vec<String>,
}

/// Lê o mesmo caminho onde src/lib/panelServers.ts espelha
/// `importedServerPaths` (store do Zustand, persistido só no localStorage da
/// webview — sem isso o Rust não tem como saber quais são).
fn load_imported_server_paths(app: &AppHandle) -> Vec<String> {
    let Ok(data_dir) = app.path().app_local_data_dir() else {
        return Vec::new();
    };
    let Ok(content) = std::fs::read_to_string(data_dir.join("imported_servers.json")) else {
        return Vec::new();
    };
    serde_json::from_str::<ImportedServersMirror>(&content)
        .map(|m| m.paths)
        .unwrap_or_default()
}

fn summarize_server_dir(path: &std::path::Path, active_dir: Option<&str>, has_running_process: bool) -> LocalServerSummary {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    let mut version = "desconhecida".to_string();
    let mut server_type = "vanilla".to_string();
    let mut description = String::new();
    let mut id = name.clone();

    if let Ok(content) = std::fs::read_to_string(path.join("cubicase-meta.json")) {
        if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(v) = meta.get("version").and_then(|v| v.as_str()) {
                version = v.to_string();
            }
            if let Some(v) = meta.get("serverType").and_then(|v| v.as_str()) {
                server_type = v.to_string();
            }
            if let Some(v) = meta.get("description").and_then(|v| v.as_str()) {
                description = v.to_string();
            }
            if let Some(v) = meta.get("uuid").and_then(|v| v.as_str()) {
                id = v.to_string();
            }
        }
    }

    let path_str = path.to_string_lossy().to_string();
    let is_running = has_running_process && active_dir == Some(path_str.as_str());

    LocalServerSummary {
        id,
        name,
        version,
        server_type,
        description,
        status: if is_running { "running".into() } else { "stopped".into() },
    }
}

/// Réplica em Rust de listLocalServers (src/lib/server.ts) — o agent roda no
/// backend e não pode depender da webview estar carregada para saber quais
/// servidores existem localmente. Cobre as duas fontes que o frontend
/// combina: a pasta padrão (Documents/CubicaseServers) e os servidores
/// importados de um caminho arbitrário (ver load_imported_server_paths).
fn scan_local_servers(app: &AppHandle) -> Vec<LocalServerSummary> {
    let mut servers = Vec::new();

    let state = app.state::<AppState>();
    let active_dir = state
        .active_server_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let has_running_process = state
        .minecraft_process
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();

    match app.path().document_dir() {
        Ok(docs_dir) => {
            let servers_root = docs_dir.join("CubicaseServers");
            match std::fs::read_dir(&servers_root) {
                Ok(entries) => {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() {
                            servers.push(summarize_server_dir(&path, active_dir.as_deref(), has_running_process));
                        }
                    }
                }
                Err(e) => log_to_file(
                    app,
                    &format!("[PANEL] Não consegui ler {}: {}", servers_root.display(), e),
                ),
            }
        }
        Err(e) => log_to_file(app, &format!("[PANEL] document_dir() falhou: {}", e)),
    }

    for imported in load_imported_server_paths(app) {
        let path = std::path::Path::new(&imported);
        if path.is_dir() {
            servers.push(summarize_server_dir(path, active_dir.as_deref(), has_running_process));
        }
    }

    log_to_file(
        app,
        &format!("[PANEL] server_list: {} servidor(es) encontrado(s).", servers.len()),
    );
    servers
}

fn build_status_message(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    let running = state
        .minecraft_process
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    let player_count = state
        .minecraft_online_players
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .len() as u32;
    let server_name = state
        .active_server_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .as_deref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .map(|n| n.to_string_lossy().to_string());

    serde_json::json!({
        "type": "status",
        "serverRunning": running,
        "serverName": server_name,
        "playerCount": player_count,
        // Fixo por enquanto — igual à mesma simplificação já adotada em
        // plans/network-server-separation-plan.md (não há RCON/consulta de
        // estado disponível para ler o valor real do server.properties aqui).
        "maxPlayers": 20,
        "ts": now_iso(),
    })
    .to_string()
}

/// CPU/RAM da máquina host (e do processo Java) para o painel — reaproveita a
/// mesma amostra que a thread de monitoramento em lib.rs já calcula a cada 15s
/// enquanto o servidor está rodando (ver ResourceSample/minecraft_last_resource_sample),
/// em vez de abrir uma segunda fonte de coleta. `None` antes do primeiro
/// servidor ser iniciado nesta sessão do app — o painel trata isso mostrando
/// "—" (ver stat-resources em docs/painel/index.html).
fn build_metrics_message(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let sample = state
        .minecraft_last_resource_sample
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()?;
    let mut value = serde_json::to_value(&sample).ok()?;
    let map = value.as_object_mut()?;
    map.insert("type".to_string(), serde_json::Value::String("metrics".to_string()));
    map.insert("ts".to_string(), serde_json::Value::String(now_iso()));
    Some(value.to_string())
}

// ============================================================
// Jogadores online (Modo "Espectador Web")
// ============================================================
// A lista vem de `minecraft_online_players` (alimentada pelo log, ver
// players.rs). Duas defesas contra ela ficar errada:
//   1. Sem processo rodando, a lista enviada é sempre vazia — mesmo que o set
//      tenha sobrado de uma queda sem "left the game" no log.
//   2. Reconciliação com o comando `list` (pedido ao conectar e pelo botão
//      "Atualizar" do painel), com intervalo mínimo pra não encher o console.

/// Intervalo mínimo entre dois `list` automáticos (reconexões do agent em rede
/// instável não podem virar spam no console) e entre dois pedidos manuais.
const LIST_REFRESH_AUTO_MIN_MS: i64 = 30_000;
const LIST_REFRESH_MANUAL_MIN_MS: i64 = 8_000;
/// Mesmo kick/ban/pardon no mesmo jogador dentro dessa janela é tratado como
/// duplo-clique (ou reenvio do painel) e não é executado de novo.
const ACTION_DEDUP_WINDOW: Duration = Duration::from_secs(3);

static LAST_LIST_REQUEST_MS: AtomicI64 = AtomicI64::new(0);
static LAST_PLAYER_ACTION: OnceLock<Mutex<Option<(String, Instant)>>> = OnceLock::new();

fn last_player_action() -> &'static Mutex<Option<(String, Instant)>> {
    LAST_PLAYER_ACTION.get_or_init(|| Mutex::new(None))
}

/// true se `key` repete a ação anterior dentro de ACTION_DEDUP_WINDOW; senão registra e devolve false.
fn is_duplicate_action(key: &str) -> bool {
    let mut guard = last_player_action().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((prev, at)) = guard.as_ref() {
        if prev == key && at.elapsed() < ACTION_DEDUP_WINDOW {
            return true;
        }
    }
    *guard = Some((key.to_string(), Instant::now()));
    false
}

fn current_player_names(app: &AppHandle) -> Vec<String> {
    let state = app.state::<AppState>();
    let running = state
        .minecraft_process
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    if !running {
        return Vec::new();
    }
    let names: Vec<String> = state
        .minecraft_online_players
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .cloned()
        .collect();
    players::sorted_capped(names)
}

fn build_players_message(names: &[String]) -> String {
    serde_json::json!({ "type": "players", "players": names, "ts": now_iso() }).to_string()
}

/// Pede um `list` ao servidor (a resposta chega pelo log e reconcilia o set —
/// ver lib.rs). Respeita o intervalo mínimo; sem servidor rodando, não faz nada.
async fn request_player_list_refresh(app: &AppHandle, min_interval_ms: i64) {
    let now = chrono::Utc::now().timestamp_millis();
    let last = LAST_LIST_REQUEST_MS.load(Ordering::Relaxed);
    if now - last < min_interval_ms {
        return;
    }
    LAST_LIST_REQUEST_MS.store(now, Ordering::Relaxed);
    let state = app.state::<AppState>();
    // Erro aqui (servidor parado, stdin indisponível) não importa: a lista
    // continua sendo a derivada do log, e sem processo ela sai vazia.
    let _ = send_minecraft_command(state, "list".to_string()).await;
}

fn build_server_list_message(app: &AppHandle) -> String {
    serde_json::json!({ "type": "server_list", "servers": scan_local_servers(app) }).to_string()
}

/// `scan_local_servers` faz I/O de disco síncrono (read_dir + ler
/// cubicase-meta.json de cada pasta) — rodar isso direto dentro de uma task
/// async, chamado a cada 2s pelo poll de status, prende a worker thread do
/// Tokio que a runtime também usa pra entregar eventos (emit) pro frontend.
/// Foi exatamente isso que fez o console "travar" de novo depois do poll
/// passar de 20s pra 2s: não é mais raro o bastante pra passar despercebido.
/// `spawn_blocking` roda no pool de threads dedicado a isso, sem competir
/// pela runtime assíncrona.
async fn build_server_list_message_async(app: &AppHandle) -> String {
    let app = app.clone();
    tokio::task::spawn_blocking(move || build_server_list_message(&app))
        .await
        .unwrap_or_else(|_| serde_json::json!({ "type": "server_list", "servers": [] }).to_string())
}

fn by_suffix(by: &Option<String>) -> String {
    by.as_deref().map(|n| format!(" (por {})", n)).unwrap_or_default()
}

/// Deixa registrado no console (do app e do painel) quem ligou/desligou pelo
/// painel — só quando há um nome (acesso compartilhado); o dono usando o
/// próprio painel já sabe o que fez.
fn announce_panel_action(app: &AppHandle, tx: &UnboundedSender<String>, by: &Option<String>, what: &str) {
    let Some(name) = by else { return; };
    let line = format!("[Painel] {} {}.", name, what);
    let _ = app.emit("minecraft-log", &line);
    let _ = tx.send(serde_json::json!({ "type": "log_line", "line": line, "ts": now_iso() }).to_string());
}

/// Interpreta uma mensagem vinda do painel (via relay).
///
/// `tx` é o mesmo canal que `run_agent_connection` usa pra escrever no
/// WebSocket — depois de agir (parar/comando), manda um `status`/`server_list`
/// **fresco, lido direto do estado atual do Rust** na hora, sem esperar o
/// próximo tick do poll (ver STATUS_POLL_SECS) — o painel vê o resultado
/// imediatamente em vez de até 2s depois.
async fn handle_incoming_message(app: &AppHandle, raw: &str, tx: &tokio::sync::mpsc::UnboundedSender<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return;
    };
    let Some(msg_type) = value.get("type").and_then(|v| v.as_str()) else {
        return;
    };

    // Nome de quem pediu — preenchido pelo relay (Durable Object), nunca pelo
    // painel (ver host-channel.ts); presente quando há acesso compartilhado.
    let by = value.get("by").and_then(|v| v.as_str()).map(|s| s.to_string());

    match msg_type {
        "command" => {
            let Some(command) = value.get("command").and_then(|v| v.as_str()) else { return; };
            // Comando local ecoa "> comando" na tela na hora (é a própria UI do
            // app fazendo isso, ver console do HostView) — um comando vindo do
            // painel pula direto pro Rust sem passar pelo frontend, então esse
            // eco nunca acontecia em lugar nenhum (nem no app, nem no painel),
            // mesmo o comando executando de verdade. Reproduz o mesmo eco nos
            // dois lugares aqui.
            let echo = match &by {
                Some(name) => format!("> {} (via painel web — {})", command, name),
                None => format!("> {} (via painel web)", command),
            };
            let _ = app.emit("minecraft-log", &echo);
            let _ = tx.send(serde_json::json!({ "type": "log_line", "line": echo, "ts": now_iso() }).to_string());

            let state = app.state::<AppState>();
            if let Err(e) = send_minecraft_command(state, command.to_string()).await {
                log_to_file(app, &format!("[PANEL] Comando remoto \"{}\" falhou: {}", command, e));
                let _ = tx.send(serde_json::json!({ "type": "error", "message": format!("Comando \"{}\" falhou: {}", command, e) }).to_string());
            }
        }
        "stop_server" => {
            log_to_file(app, &format!("[PANEL] Parada remota solicitada pelo painel{}.", by_suffix(&by)));
            announce_panel_action(app, tx, &by, "desligou o servidor");
            let state = app.state::<AppState>();
            stop_minecraft_server_internal(app, &state).await;
            let _ = tx.send(build_status_message(app));
            let _ = tx.send(build_server_list_message_async(app).await);
        }
        "start_server" => {
            let Some(server_id) = value.get("serverId").and_then(|v| v.as_str()) else { return; };
            log_to_file(app, &format!("[PANEL] Início remoto solicitado pelo painel para \"{}\"{}.", server_id, by_suffix(&by)));
            announce_panel_action(app, tx, &by, "ligou o servidor");
            // A checagem/instalação de JRE e a resolução de porta/RAM vivem em
            // TypeScript (src/lib/server.ts:startServerOrchestrated) — mesma
            // rotina do botão "Iniciar Servidor" local — em vez de duplicadas
            // aqui. O listener no frontend (page.tsx) também aplica a regra de
            // "recusar se outro servidor já estiver rodando".
            let _ = app.emit("panel-start-server-request", server_id);
        }
        "players_refresh" => {
            request_player_list_refresh(app, LIST_REFRESH_MANUAL_MIN_MS).await;
            // A resposta do `list` chega pelo log; dá um instante pra ela ser
            // processada e manda o retrato novo sem esperar o próximo poll.
            tokio::time::sleep(Duration::from_millis(1200)).await;
            let _ = tx.send(build_players_message(&current_player_names(app)));
        }
        "player_action" => {
            let request_id = value
                .get("requestId")
                .and_then(|v| v.as_str())
                .and_then(players::sanitize_request_id);
            let action = value.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let player = value.get("player").and_then(|v| v.as_str()).unwrap_or("");
            let reason = value.get("reason").and_then(|v| v.as_str());

            // Só ecoa de volta o que é válido — o painel renderiza como texto,
            // mas não há motivo pra devolver lixo arbitrário.
            let echo_player = if players::is_valid_player_name(player) { player } else { "" };
            let reply = |ok: bool, message: String| {
                let _ = tx.send(
                    serde_json::json!({
                        "type": "player_action_result",
                        "requestId": request_id,
                        "ok": ok,
                        "action": action,
                        "player": echo_player,
                        "message": message,
                        "ts": now_iso(),
                    })
                    .to_string(),
                );
            };

            // Monta o comando só a partir de campos validados: nome estrito,
            // motivo sem caracteres de controle. O relay já autorizou conforme
            // as permissões, mas o agent não confia nisso pra montar stdin.
            let command = match players::build_player_command(action, player, reason) {
                Ok(c) => c,
                Err(msg) => {
                    log_to_file(app, &format!("[PANEL] player_action recusada ({}): action={:?} player={:?}", msg, action, player));
                    reply(false, msg.to_string());
                    return;
                }
            };

            if is_duplicate_action(&format!("{}:{}", action, player)) {
                reply(true, "Ação já enviada há instantes.".to_string());
                return;
            }

            log_to_file(app, &format!("[PANEL] Ação de moderação \"{}\"{}.", command, by_suffix(&by)));
            let echo = match &by {
                Some(name) => format!("> {} (via painel web — {})", command, name),
                None => format!("> {} (via painel web)", command),
            };
            let _ = app.emit("minecraft-log", &echo);
            let _ = tx.send(serde_json::json!({ "type": "log_line", "line": echo, "ts": now_iso() }).to_string());

            let state = app.state::<AppState>();
            match send_minecraft_command(state, command.clone()).await {
                Ok(()) => {
                    reply(true, "Comando enviado ao servidor.".to_string());
                    // O "left the game"/"lost connection" chega pelo log logo
                    // depois — manda a lista atualizada sem esperar o poll.
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    let _ = tx.send(build_players_message(&current_player_names(app)));
                }
                Err(e) => {
                    log_to_file(app, &format!("[PANEL] Ação \"{}\" falhou: {}", command, e));
                    reply(false, e);
                }
            }
        }
        _ => {}
    }
}

async fn run_agent_connection(app: &AppHandle, device: &PanelDeviceFile) -> Result<(), String> {
    let url = format!("{}/{}?role=agent", relay_ws_base(), device.id);
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    let auth_value = HeaderValue::from_str(&format!("Bearer {}", device.device_token))
        .map_err(|e| e.to_string())?;
    request.headers_mut().insert("Authorization", auth_value);

    let (ws_stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| e.to_string())?;
    log_to_file(app, "[PANEL] Conectado ao painel web remoto.");
    let (mut write, mut read) = ws_stream.split();

    // Canal interno: tanto o sink de log (ver push_minecraft_log_line) quanto
    // as respostas de handle_incoming_message só empilham a mensagem aqui;
    // quem realmente escreve no WebSocket é o loop principal abaixo, que
    // também lê mensagens recebidas — evita ter duas tasks concorrentes
    // escrevendo no mesmo sink do WebSocket.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Troca o sink de log para esta conexão (substitui o de uma conexão
    // anterior, se houver) — ver comentário grande acima de LOG_SINK sobre
    // por que isso não é um AppHandle::listen.
    *log_sink().lock().unwrap_or_else(|e| e.into_inner()) = Some(tx.clone());

    // Snapshot inicial assim que conecta, sem esperar o primeiro poll.
    let _ = tx.send(build_status_message(app));
    let _ = tx.send(build_server_list_message_async(app).await);
    if let Some(metrics) = build_metrics_message(app) {
        let _ = tx.send(metrics);
    }
    // Lista de jogadores: retrato imediato (do log) + pedido de `list` pra
    // corrigir o que o log não viu (app aberto com o servidor já rodando).
    let mut last_players = current_player_names(app);
    let _ = tx.send(build_players_message(&last_players));
    {
        let app_for_list = app.clone();
        tauri::async_runtime::spawn(async move {
            request_player_list_refresh(&app_for_list, LIST_REFRESH_AUTO_MIN_MS).await;
        });
    }

    let mut status_poll = tokio::time::interval(Duration::from_secs(STATUS_POLL_SECS));
    status_poll.tick().await; // o primeiro tick é imediato; o snapshot acima já cobriu isso

    let result = loop {
        tokio::select! {
            outgoing = rx.recv() => {
                match outgoing {
                    Some(msg) => {
                        if let Err(e) = write.send(Message::Text(msg.into())).await {
                            break Err(e.to_string());
                        }
                    }
                    None => break Ok(()), // nunca deveria acontecer (tx segue vivo no escopo desta função)
                }
            }
            _ = status_poll.tick() => {
                let _ = tx.send(build_status_message(app));
                let _ = tx.send(build_server_list_message_async(app).await);
                if let Some(metrics) = build_metrics_message(app) {
                    let _ = tx.send(metrics);
                }
                // Só reenvia a lista quando mudou — o relay grava cada mensagem
                // em storage, e a lista quase nunca muda entre dois polls.
                let names = current_player_names(app);
                if names != last_players {
                    let _ = tx.send(build_players_message(&names));
                    last_players = names;
                }
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break Ok(()),
                    Some(Ok(Message::Text(txt))) => {
                        // Roda em background em vez de dar await aqui dentro:
                        // "stop_server" pode levar até 15s (stop_minecraft_server_internal
                        // espera o processo encerrar sozinho antes de forçar). Se
                        // ficássemos parados aqui, este loop pararia de responder
                        // a Ping do relay durante esse tempo — Cloudflare pode
                        // considerar a conexão morta e fechar, derrubando o
                        // agent bem na hora em que o painel mais precisa ver o
                        // resultado do comando.
                        let app_for_msg = app.clone();
                        let raw_ref: &str = txt.as_ref();
                        let raw = raw_ref.to_string();
                        let tx_for_msg = tx.clone();
                        tauri::async_runtime::spawn(async move {
                            handle_incoming_message(&app_for_msg, &raw, &tx_for_msg).await;
                        });
                    }
                    Some(Ok(_)) => {} // Binary/Ping/Pong — nada esperado do relay além de texto
                    Some(Err(e)) => break Err(e.to_string()),
                }
            }
        }
    };

    // Só limpa o sink se ainda for o nosso — outra conexão pode já ter
    // assumido (ex: reconexão rápida) entre este loop terminar e aqui.
    {
        let mut guard = log_sink().lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().is_some_and(|s| s.same_channel(&tx)) {
            *guard = None;
        }
    }
    result
}

/// Chamado uma vez em `run()` — mantém uma tentativa de conexão viva em
/// segundo plano pela vida inteira do processo, sem bloquear o startup do
/// app (não há nada pra esperar aqui: sem dispositivo pareado, o loop só
/// fica de prontidão verificando de novo a cada alguns segundos).
pub fn spawn_panel_agent(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut backoff_index = 0usize;
        loop {
            let device = load_panel_device(&app);

            let Some(device) = device else {
                tokio::time::sleep(Duration::from_secs(NO_DEVICE_RETRY_SECS)).await;
                continue;
            };

            match run_agent_connection(&app, &device).await {
                Ok(()) => {
                    backoff_index = 0;
                }
                Err(e) => {
                    let wait = BACKOFF_STEPS_SECS[backoff_index.min(BACKOFF_STEPS_SECS.len() - 1)];
                    log_to_file(
                        &app,
                        &format!(
                            "[PANEL] Conexão com o painel web caiu ({}). Tentando de novo em {}s.",
                            e, wait
                        ),
                    );
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    backoff_index = (backoff_index + 1).min(BACKOFF_STEPS_SECS.len() - 1);
                    continue;
                }
            }

            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}
