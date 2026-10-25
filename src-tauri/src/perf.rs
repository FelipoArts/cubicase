//! Desempenho do servidor (TPS e tempo por tick), lido do PRÓPRIO console do Minecraft.
//!
//! Não há RCON nem agente dentro do servidor: a cada ciclo (junto da amostragem de RAM/CPU) o app digita no
//! console o comando de TPS que aquela versão/loader entende e reconhece a resposta no mesmo fluxo de log
//! que já lê. Cada formato foi conferido em servidores reais (Paper, Vanilla e Forge 1.20.4):
//!
//! | fonte        | comando         | resposta (depois de tirar cores e o prefixo `[hora] [Thread/INFO]:`)           |
//! |--------------|-----------------|--------------------------------------------------------------------------------|
//! | `paper-tps`  | `tps`           | `TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0`                                  |
//! | `forge-tps`  | `forge tps`     | `Overall: Mean tick time: 17,271 ms. Mean TPS: 20,000` (+ uma linha por dimensão) |
//! | `tick-query` | `tick query`    | `Average time per tick: 8,6ms (Target: 50,0ms)` e `Percentiles: P50: 3,2ms P95: 15,0ms P99: 339,1ms` |
//!
//! Atenção: os números saem com **vírgula decimal** quando o Windows está em português (`8,6ms`), e a lista do
//! `tps` separa itens por `", "` — o parser entende os dois jeitos.
//!
//! Sem fonte (Vanilla/Fabric antes da 1.20.3) o painel simplesmente não mostra TPS; nada é digitado no console.
//! As linhas da resposta NÃO aparecem no console da interface enquanto o app está perguntando (senão o console
//! encheria de `TPS from last 1m…` a cada 15 s); se o host digitar `tps` ele mesmo, a resposta aparece normal.

use super::*;

use std::sync::OnceLock;

/// Quanto tempo depois de perguntar as linhas reconhecidas ainda são consideradas "resposta ao app".
const PENDING_WINDOW: Duration = Duration::from_secs(7);
/// Ciclos seguidos sem nenhuma resposta reconhecida até desistir de um conjunto de comandos.
const MISSES_BEFORE_NEXT_PLAN: u32 = 2;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerfState {
    /// Existe alguma fonte de TPS para este servidor (ainda tentando ou já funcionando).
    pub supported: bool,
    /// "paper-tps" | "forge-tps" | "tick-query" | "" (ainda descobrindo) | "none" (nada respondeu).
    pub source: String,
    pub tps: Option<f32>,
    pub mspt_avg: Option<f32>,
    pub mspt_p95: Option<f32>,
    pub mspt_p99: Option<f32>,
    pub updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
enum Piece {
    /// `tps` do Paper/Spigot: TPS dos últimos 1 min.
    PaperTps(f32),
    /// `forge tps`, linha "Overall".
    ForgeOverall { mspt: f32, tps: f32 },
    /// `forge tps`, uma linha de dimensão (só reconhecida para esconder).
    ForgeDimension,
    /// `tick query`: tempo médio por tick e o alvo (ms).
    TickAverage { mspt: f32, target_mspt: f32 },
    TickPercentiles { p95: f32, p99: f32 },
    /// Linhas de `tick query` sem número que importe ("The game runs normally", "Target tick rate…").
    TickInfo,
}

// ------------------------------------------------------------
// Análise das linhas (pura, testada)
// ------------------------------------------------------------

/// Lê um número no começo de `s`, aceitando ponto OU vírgula como separador decimal.
fn read_number(s: &str) -> Option<f32> {
    let s = s.trim_start();
    let b = s.as_bytes();
    let mut end = 0;
    while end < b.len() && b[end].is_ascii_digit() {
        end += 1;
    }
    if end == 0 {
        return None;
    }
    // "8,6ms" -> parte decimal; "20.0, 20.0" e "339,1ms, sample" -> a vírgula só vale se vier um dígito logo depois.
    if end + 1 < b.len() && (b[end] == b'.' || b[end] == b',') && b[end + 1].is_ascii_digit() {
        end += 1;
        while end < b.len() && b[end].is_ascii_digit() {
            end += 1;
        }
    }
    s[..end].replace(',', ".").parse().ok()
}

/// Número que vem logo depois de `label` em `s`.
fn number_after(s: &str, label: &str) -> Option<f32> {
    let i = s.find(label)?;
    read_number(&s[i + label.len()..])
}

fn payload_of(line: &str) -> &str {
    players::log_payload(line)
}

fn parse_line(line: &str) -> Option<Piece> {
    let p = payload_of(line);
    // Paper/Spigot: "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0" (um "*" na frente quando passa de 20)
    if let Some(rest) = p.strip_prefix("TPS from last 1m, 5m, 15m:") {
        let first = rest.trim().trim_start_matches('*');
        return read_number(first).map(Piece::PaperTps);
    }
    // Forge/NeoForge: "Overall: Mean tick time: 17,271 ms. Mean TPS: 20,000"
    if p.contains("Mean tick time:") && p.contains("Mean TPS:") {
        if p.starts_with("Overall:") {
            let mspt = number_after(p, "Mean tick time:")?;
            let tps = number_after(p, "Mean TPS:")?;
            return Some(Piece::ForgeOverall { mspt, tps });
        }
        return Some(Piece::ForgeDimension);
    }
    // tick query (1.20.3+)
    if let Some(rest) = p.strip_prefix("Average time per tick:") {
        let mspt = read_number(rest)?;
        let target = number_after(rest, "Target:").unwrap_or(50.0);
        return Some(Piece::TickAverage { mspt, target_mspt: target });
    }
    if p.starts_with("Percentiles:") {
        let p95 = number_after(p, "P95:")?;
        let p99 = number_after(p, "P99:")?;
        return Some(Piece::TickPercentiles { p95, p99 });
    }
    if p.starts_with("Target tick rate:") || p == "The game runs normally" || p.starts_with("The game is running") || p.starts_with("The game is frozen") || p.starts_with("The game is sprinting") {
        return Some(Piece::TickInfo);
    }
    None
}

/// Resposta de "comando desconhecido" (Paper/Spigot e vanilla) — escondida só durante a pergunta do app.
fn is_unknown_command_line(line: &str) -> bool {
    let p = payload_of(line);
    p.starts_with("Unknown command") || p.starts_with("Unknown or incomplete command") || p.ends_with("<--[HERE]")
}

fn apply(state: &mut PerfState, piece: &Piece, source: &str) {
    match piece {
        Piece::PaperTps(tps) => {
            state.tps = Some(*tps);
            state.source = source.to_string();
        }
        Piece::ForgeOverall { mspt, tps } => {
            state.tps = Some(*tps);
            state.mspt_avg = Some(*mspt);
            state.source = source.to_string();
        }
        Piece::TickAverage { mspt, target_mspt } => {
            state.mspt_avg = Some(*mspt);
            // O servidor dorme até completar o tempo do tick: abaixo do alvo, o TPS é o do alvo; acima, 1000/mspt.
            // Quem já tem TPS "de verdade" (Paper/Forge) não é sobrescrito.
            if state.source.is_empty() || state.source == "tick-query" {
                let target_tps = 1000.0 / target_mspt.max(1.0);
                state.tps = Some((1000.0 / mspt.max(0.001)).min(target_tps));
                state.source = "tick-query".to_string();
            }
        }
        Piece::TickPercentiles { p95, p99 } => {
            state.mspt_p95 = Some(*p95);
            state.mspt_p99 = Some(*p99);
        }
        Piece::ForgeDimension | Piece::TickInfo => {}
    }
}

// ------------------------------------------------------------
// Que comandos usar (por loader e versão)
// ------------------------------------------------------------

/// `1.20.3` ou mais novo (inclui a numeração nova, "26.1")? Versão ilegível: não.
pub fn has_tick_command(version: &str) -> bool {
    let parts: Vec<u32> = version.split('.').filter_map(|p| p.parse().ok()).collect();
    if parts.len() < 2 || parts.len() != version.split('.').count() {
        return false;
    }
    let (maj, min, patch) = (parts[0], parts[1], parts.get(2).copied().unwrap_or(0));
    maj > 1 || (maj == 1 && (min > 20 || (min == 20 && patch >= 3)))
}

/// Conjuntos de comandos a tentar, em ordem de preferência. Vazio = esta versão não tem como informar o TPS.
pub fn plan_for(server_type: &str, version: &str) -> Vec<Vec<&'static str>> {
    let tick = has_tick_command(version);
    match server_type {
        "paper" | "purpur" | "spigot" | "bukkit" | "folia" => {
            if tick { vec![vec!["tps", "tick query"], vec!["tps"], vec!["tick query"]] } else { vec![vec!["tps"]] }
        }
        "forge" => {
            if tick { vec![vec!["forge tps", "tick query"], vec!["tick query"]] } else { vec![vec!["forge tps"]] }
        }
        "neoforge" => {
            if tick { vec![vec!["neoforge tps", "tick query"], vec!["tick query"]] } else { vec![vec!["neoforge tps"]] }
        }
        _ => {
            if tick { vec![vec!["tick query"]] } else { vec![] }
        }
    }
}

// ------------------------------------------------------------
// Estado da sessão atual
// ------------------------------------------------------------

struct Inner {
    state: PerfState,
    plan: Vec<Vec<&'static str>>,
    idx: usize,
    misses: u32,
    pieces_since_probe: u32,
    pending_until: Option<Instant>,
    pending_cmds: Vec<String>,
}

fn inner() -> &'static Mutex<Inner> {
    static S: OnceLock<Mutex<Inner>> = OnceLock::new();
    S.get_or_init(|| {
        Mutex::new(Inner { state: PerfState::default(), plan: vec![], idx: 0, misses: 0, pieces_since_probe: 0, pending_until: None, pending_cmds: vec![] })
    })
}

fn lock() -> std::sync::MutexGuard<'static, Inner> {
    inner().lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Começo de uma execução do servidor: descobre o plano pelo cubicase-meta.json e zera o estado.
pub fn reset_for_start(server_dir: &str) {
    let meta: serde_json::Value = std::fs::read_to_string(std::path::Path::new(server_dir).join("cubicase-meta.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    let server_type = meta.get("serverType").and_then(|v| v.as_str()).unwrap_or("");
    let version = meta.get("version").and_then(|v| v.as_str()).unwrap_or("");
    let plan = plan_for(server_type, version);
    let mut g = lock();
    g.state = PerfState { supported: !plan.is_empty(), source: if plan.is_empty() { "none".into() } else { String::new() }, ..Default::default() };
    g.plan = plan;
    g.idx = 0;
    g.misses = 0;
    g.pieces_since_probe = 0;
    g.pending_until = None;
    g.pending_cmds.clear();
}

/// Linha do console. Devolve `true` se for a resposta a uma pergunta do app (não deve aparecer no console).
pub fn on_line(app: &tauri::AppHandle, line: &str) -> bool {
    let piece = parse_line(line);
    let mut changed: Option<PerfState> = None;
    let hide;
    {
        let mut g = lock();
        let pending = g.pending_until.map_or(false, |t| Instant::now() < t);
        if let Some(piece) = &piece {
            // Qual fonte gerou esta linha: pelo tipo da própria linha (vale também quando o host digita o comando).
            let src = match piece {
                Piece::PaperTps(_) => "paper-tps",
                Piece::ForgeOverall { .. } | Piece::ForgeDimension => "forge-tps",
                _ => "tick-query",
            };
            let before = g.state.clone();
            apply(&mut g.state, piece, src);
            g.state.updated_at_ms = Some(now_ms());
            g.pieces_since_probe += 1;
            if g.state != before {
                changed = Some(g.state.clone());
            }
        }
        let echo = pending && { let p = payload_of(line).to_lowercase(); g.pending_cmds.iter().any(|c| *c == p) };
        hide = pending && (piece.is_some() || echo || is_unknown_command_line(line));
    }
    if let Some(s) = changed {
        let _ = app.emit("mc-perf", s);
    }
    hide
}

/// Um ciclo de perguntas (chamado a cada amostragem de recursos, com o servidor já online).
pub fn probe(app: &tauri::AppHandle, state: &AppState) {
    let (cmds, announce) = {
        let mut g = lock();
        if g.plan.is_empty() || g.state.source == "none" {
            return;
        }
        // O ciclo anterior foi respondido?
        if g.pending_until.is_some() {
            if g.pieces_since_probe == 0 {
                g.misses += 1;
            } else {
                g.misses = 0;
            }
            if g.misses >= MISSES_BEFORE_NEXT_PLAN {
                g.idx += 1;
                g.misses = 0;
            }
        }
        if g.idx >= g.plan.len() {
            g.state.supported = false;
            g.state.source = "none".into();
            g.pending_until = None;
            g.pending_cmds.clear();
            (Vec::new(), Some(g.state.clone()))
        } else {
            let cmds: Vec<String> = g.plan[g.idx].iter().map(|s| s.to_string()).collect();
            g.pieces_since_probe = 0;
            g.pending_until = Some(Instant::now() + PENDING_WINDOW);
            g.pending_cmds = cmds.iter().map(|c| c.to_lowercase()).collect();
            (cmds, None)
        }
    };
    if let Some(s) = announce {
        let _ = app.emit("mc-perf", s);
        return;
    }
    for (i, cmd) in cmds.iter().enumerate() {
        if i > 0 {
            std::thread::sleep(Duration::from_millis(700));
        }
        let mut stdin = state.minecraft_stdin.lock().unwrap_or_else(|e| e.into_inner());
        match stdin.as_mut() {
            Some(w) => {
                if w.write_all(format!("{}\r\n", cmd).as_bytes()).and_then(|_| w.flush()).is_err() {
                    return;
                }
            }
            None => return,
        }
    }
}

#[tauri::command]
pub fn get_perf_state() -> PerfState {
    lock().state.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Linhas REAIS capturadas em servidores 1.20.4 (cores ANSI já removidas, como o app faz antes de analisar).
    const PAPER_TPS: &str = "[18:05:22 INFO]: TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0";
    const PAPER_TPS_STAR: &str = "[18:05:22 INFO]: TPS from last 1m, 5m, 15m: *20.0, 19.5, 18,2";
    const TICK_STATUS: &str = "[18:05:27 INFO]: The game runs normally";
    const TICK_AVG_LINE: &str = "Average time per tick: 8,6ms (Target: 50,0ms)";
    const TICK_PERC: &str = "[18:05:27 INFO]: Percentiles: P50: 3,2ms P95: 15,0ms P99: 339,1ms, sample: 100";
    const FORGE_OVERALL: &str = "[18:09:41] [Server thread/INFO] [minecraft/MinecraftServer]: Overall: Mean tick time: 17,271 ms. Mean TPS: 20,000";
    const FORGE_DIM: &str = "[18:09:41] [Server thread/INFO] [minecraft/MinecraftServer]: Dim minecraft:overworld (minecraft:overworld): Mean tick time: 17,138 ms. Mean TPS: 20,000";
    const VANILLA_TICK_AVG: &str = "[18:08:45] [Server thread/INFO]: Target tick rate: 20,0 per second.";

    #[test]
    fn numeros_com_virgula_ou_ponto_decimal() {
        assert_eq!(read_number("8,6ms"), Some(8.6));
        assert_eq!(read_number("20.0, 20.0"), Some(20.0));
        assert_eq!(read_number("339,1ms, sample: 100"), Some(339.1));
        assert_eq!(read_number("  17,271 ms."), Some(17.271));
        assert_eq!(read_number("50"), Some(50.0));
        assert_eq!(read_number("20, 19"), Some(20.0), "vírgula + espaço separa itens, não é decimal");
        assert_eq!(read_number("abc"), None);
    }

    #[test]
    fn paper_tps_pega_o_primeiro_numero_e_ignora_o_asterisco() {
        assert_eq!(parse_line(PAPER_TPS), Some(Piece::PaperTps(20.0)));
        assert_eq!(parse_line(PAPER_TPS_STAR), Some(Piece::PaperTps(20.0)));
        assert_eq!(parse_line("[1:2:3 INFO]: TPS from last 1m, 5m, 15m: 17,3, 18.0, 19.0"), Some(Piece::PaperTps(17.3)));
    }

    #[test]
    fn tick_query_em_varias_linhas() {
        assert_eq!(parse_line(TICK_STATUS), Some(Piece::TickInfo));
        assert_eq!(parse_line(VANILLA_TICK_AVG), Some(Piece::TickInfo));
        assert_eq!(parse_line(TICK_AVG_LINE), Some(Piece::TickAverage { mspt: 8.6, target_mspt: 50.0 }));
        assert_eq!(parse_line(TICK_PERC), Some(Piece::TickPercentiles { p95: 15.0, p99: 339.1 }));
    }

    #[test]
    fn forge_overall_e_dimensoes() {
        assert_eq!(parse_line(FORGE_OVERALL), Some(Piece::ForgeOverall { mspt: 17.271, tps: 20.0 }));
        assert_eq!(parse_line(FORGE_DIM), Some(Piece::ForgeDimension));
    }

    #[test]
    fn linhas_comuns_do_console_nao_sao_confundidas() {
        for l in [
            "[18:00:00] [Server thread/INFO]: <Steve> TPS from last 1m, 5m, 15m: 20.0",
            "[18:00:00] [Server thread/INFO]: Steve joined the game",
            "[18:00:00] [Server thread/INFO]: Done (3.2s)! For help, type \"help\"",
            "[18:00:00] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 2000ms or 40 ticks behind",
            "Average time per tick: sem numero",
            "",
        ] {
            assert_eq!(parse_line(l), None, "{l}");
        }
    }

    #[test]
    fn tick_query_deriva_tps_e_nao_sobrescreve_tps_de_verdade() {
        let mut s = PerfState::default();
        apply(&mut s, &Piece::TickAverage { mspt: 8.6, target_mspt: 50.0 }, "tick-query");
        assert_eq!(s.tps, Some(20.0), "abaixo do alvo: o servidor dorme, TPS = alvo");
        apply(&mut s, &Piece::TickAverage { mspt: 100.0, target_mspt: 50.0 }, "tick-query");
        assert_eq!(s.tps, Some(10.0), "acima do alvo: 1000/mspt");
        apply(&mut s, &Piece::TickPercentiles { p95: 60.0, p99: 120.0 }, "tick-query");
        assert_eq!((s.mspt_p95, s.mspt_p99), (Some(60.0), Some(120.0)));

        let mut paper = PerfState::default();
        apply(&mut paper, &Piece::PaperTps(19.2), "paper-tps");
        apply(&mut paper, &Piece::TickAverage { mspt: 8.0, target_mspt: 50.0 }, "tick-query");
        assert_eq!(paper.tps, Some(19.2), "o TPS do Paper (média de 1 min) vale mais que o derivado");
        assert_eq!(paper.source, "paper-tps");
        assert_eq!(paper.mspt_avg, Some(8.0), "mas o tempo por tick vem do tick query");
    }

    #[test]
    fn plano_de_comandos_por_loader_e_versao() {
        assert_eq!(plan_for("paper", "1.20.4")[0], vec!["tps", "tick query"]);
        assert_eq!(plan_for("paper", "1.19.4"), vec![vec!["tps"]]);
        assert_eq!(plan_for("forge", "1.20.1"), vec![vec!["forge tps"]]);
        assert_eq!(plan_for("forge", "1.20.4")[0], vec!["forge tps", "tick query"]);
        assert_eq!(plan_for("neoforge", "1.21.1")[0], vec!["neoforge tps", "tick query"]);
        assert_eq!(plan_for("fabric", "1.21"), vec![vec!["tick query"]]);
        assert_eq!(plan_for("vanilla", "26.1"), vec![vec!["tick query"]]);
        assert!(plan_for("vanilla", "1.20.2").is_empty(), "sem comando de TPS: nada é digitado");
        assert!(plan_for("fabric", "1.12.2").is_empty());
        assert!(plan_for("", "").is_empty());
        assert!(plan_for("fabric", "snapshot").is_empty());
    }

    #[test]
    fn versao_com_comando_tick() {
        for (v, ok) in [("1.20.3", true), ("1.20.4", true), ("1.21", true), ("1.21.11", true), ("26.3", true), ("1.20.2", false), ("1.20", false), ("1.8.9", false), ("", false), ("1.20.x", false), ("24w14a", false)] {
            assert_eq!(has_tick_command(v), ok, "{v}");
        }
    }

    #[test]
    fn comando_desconhecido_e_reconhecido() {
        assert!(is_unknown_command_line("[18:05:30 INFO]: Unknown command. Type \"/help\" for help."));
        assert!(is_unknown_command_line("[18:08:47] [Server thread/INFO]: Unknown or incomplete command, see below for error"));
        assert!(is_unknown_command_line("[18:08:47] [Server thread/INFO]: tps<--[HERE]"));
        assert!(!is_unknown_command_line("[18:08:47] [Server thread/INFO]: Steve joined the game"));
    }
}
