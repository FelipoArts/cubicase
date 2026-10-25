//! Quando vale a pena reportar o status do Minecraft à API Central.
//!
//! O status (ligado, jogadores, porta, IP do Radmin) vai para a central a cada mudança e, sem mudança nenhuma, só como
//! sinal de vida de tempos em tempos. Antes ia a cada ~45 s, mudando ou não: ~80 gravações por hora por servidor ligado,
//! no armazenamento (KV) da central, que tem cota de escrita curta. A central considera o status velho depois de
//! `MC_STALE_MS` (ver o Worker), então o sinal de vida precisa chegar bem antes disso.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Sinal de vida quando nada mudou. O Worker só considera o status velho depois de 5 min: sobra mais de uma tentativa.
pub const KEEPALIVE: Duration = Duration::from_secs(120);
/// Teto de nomes enviados por retrato (servidores grandes não precisam de lista completa no Discord).
pub const MAX_NAMES: usize = 50;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reported {
    pub status: String,
    pub players: u32,
    /// Nomes de quem está online (ordenados, no máximo `MAX_NAMES`): a central só os guarda se o servidor estiver ligado a um Discord.
    pub names: Vec<String>,
    pub port: u16,
    pub radmin_ip: Option<String>,
}

struct Sent {
    what: Reported,
    at: Instant,
}

/// Devolve true se este retrato deve ir para a central: nunca enviado, algo mudou, ou já passou o sinal de vida.
pub fn is_due(previous: Option<(&Reported, Instant)>, now_state: &Reported, now: Instant) -> bool {
    match previous {
        None => true,
        Some((prev, at)) => prev != now_state || now.saturating_duration_since(at) >= KEEPALIVE,
    }
}

fn sent_map() -> &'static Mutex<HashMap<String, Sent>> {
    static MAP: OnceLock<Mutex<HashMap<String, Sent>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Confere (e registra) se o retrato do servidor `short_code` deve ser enviado agora.
pub fn should_send(short_code: &str, now_state: Reported) -> bool {
    let now = Instant::now();
    let mut map = sent_map().lock().unwrap_or_else(|e| e.into_inner());
    let due = is_due(map.get(short_code).map(|s| (&s.what, s.at)), &now_state, now);
    if due {
        map.insert(short_code.to_string(), Sent { what: now_state, at: now });
    }
    due
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(status: &str, players: u32) -> Reported {
        Reported { status: status.into(), players, names: Vec::new(), port: 25565, radmin_ip: None }
    }

    #[test]
    fn primeiro_retrato_sempre_vai() {
        assert!(is_due(None, &r("online", 0), Instant::now()));
    }

    #[test]
    fn sem_mudanca_e_antes_do_sinal_de_vida_nao_vai() {
        let t0 = Instant::now();
        let prev = r("online", 2);
        assert!(!is_due(Some((&prev, t0)), &r("online", 2), t0 + Duration::from_secs(15)));
        assert!(!is_due(Some((&prev, t0)), &r("online", 2), t0 + KEEPALIVE - Duration::from_secs(1)));
    }

    #[test]
    fn sinal_de_vida_vai_quando_o_prazo_chega() {
        let t0 = Instant::now();
        let prev = r("online", 2);
        assert!(is_due(Some((&prev, t0)), &r("online", 2), t0 + KEEPALIVE));
    }

    #[test]
    fn qualquer_mudanca_vai_na_hora() {
        let t0 = Instant::now();
        let prev = r("online", 2);
        let soon = t0 + Duration::from_secs(1);
        assert!(is_due(Some((&prev, t0)), &r("online", 3), soon)); // jogador entrou
        assert!(is_due(Some((&prev, t0)), &r("stopping", 2), soon)); // mudança de estado
        assert!(is_due(Some((&prev, t0)), &Reported { port: 25570, ..r("online", 2) }, soon));
        // um entrou e outro saiu: a contagem é a mesma, mas os nomes mudaram
        assert!(is_due(Some((&prev, t0)), &Reported { names: vec!["Ana".into()], ..r("online", 2) }, soon));
        assert!(is_due(Some((&prev, t0)), &Reported { radmin_ip: Some("26.1.2.3".into()), ..r("online", 2) }, soon));
    }

    #[test]
    fn registro_por_servidor_e_independente() {
        assert!(should_send("TESTE_A", r("online", 1)));
        assert!(!should_send("TESTE_A", r("online", 1)));
        assert!(should_send("TESTE_B", r("online", 1))); // outro servidor, primeira vez
        assert!(should_send("TESTE_A", r("online", 2))); // mudou
    }
}
