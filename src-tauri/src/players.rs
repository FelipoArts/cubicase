// ============================================================
// Jogadores online — parsing do log e ações de moderação do painel web
// ============================================================
// Lógica pura (sem AppState/Tauri) para que dê pra testar cada cenário de
// falha isoladamente. Usada por lib.rs (alimenta `minecraft_online_players`
// a partir do stdout do servidor) e por panel_agent.rs (lista de jogadores e
// ações kick/ban/pardon vindas do painel remoto).
//
// Por que o parsing é ESTRITO: o log mistura mensagens do servidor com chat de
// jogadores. Um jogador digitando "Fulano joined the game" no chat gera a
// linha "<Eve> Fulano joined the game" — o parser antigo (último token antes
// do sufixo) registrava "Fulano" como online. Agora a mensagem inteira, depois
// do prefixo de log, precisa ser exatamente "<nome> joined|left the game".
// Qualquer coisa fora do formato é ignorada — e a lista é reconciliada com o
// comando `list` (ver parse_list_response) pra corrigir o que o log não pegou.
// ============================================================

/// Máximo de nomes enviados ao painel — o servidor tem 20 slots por padrão,
/// mas um server.properties com max-players alto não deve gerar mensagens enormes.
pub const MAX_PLAYERS_LISTED: usize = 200;
pub const MAX_REASON_CHARS: usize = 100;

/// Remove sequências de escape ANSI (CSI): o servidor roda dentro de um
/// pseudo-terminal, então o stdout pode trazer cores/cursor misturados ao texto.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                // Parâmetros/intermediários até o byte final (0x40..=0x7E).
                for n in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&n) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Mensagem do servidor sem o prefixo de log ("[12:00:00] [Server thread/INFO]: ").
/// Corta no PRIMEIRO "]: " depois de um "/INFO" (ou nível parecido) — o que vem
/// depois, inclusive chat de jogador, nunca influencia onde o prefixo termina.
/// Sem prefixo reconhecível (launcher que o remove), usa a linha toda.
fn log_payload(clean: &str) -> &str {
    let trimmed = clean.trim();
    if trimmed.starts_with('[') {
        if let Some(pos) = trimmed.find("]: ") {
            return trimmed[pos + 3..].trim();
        }
    }
    trimmed
}

/// Servidores recentes (1.19+) registram mensagens de SISTEMA — entrada/saída de
/// jogador e a resposta de comandos como `list` — com o prefixo "System chat: ";
/// versões mais antigas e Paper registram sem ele. Aceita os dois. É seguro:
/// chat de jogador sempre chega como "<Nome> texto", então um jogador não
/// consegue produzir uma linha que COMECE com "System chat: ".
fn system_message(payload: &str) -> &str {
    payload.strip_prefix("System chat: ").unwrap_or(payload).trim()
}

/// Nome válido de jogador (Java: 1–16 de [A-Za-z0-9_]). Aceita um "." inicial
/// (jogadores Bedrock via Floodgate). É também o que impede injeção de comando:
/// nada fora disso (espaço, seletor "@a", quebra de linha) chega ao stdin.
pub fn is_valid_player_name(name: &str) -> bool {
    let body = name.strip_prefix('.').unwrap_or(name);
    !body.is_empty()
        && body.chars().count() <= 16
        && body.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// "X joined the game" / "X left the game" -> (nome, entrou?). None se a linha
/// não for exatamente isso (chat, outras mensagens, nome inválido).
pub fn parse_player_event(line: &str) -> Option<(String, bool)> {
    let clean = strip_ansi(line);
    let payload = system_message(log_payload(&clean));
    for (suffix, joined) in [(" joined the game", true), (" left the game", false)] {
        if let Some(name) = payload.strip_suffix(suffix) {
            // Chat chega como "<Nome> texto" e o modo de chat assinado do 1.19+
            // como "[Not Secure] <Nome> texto": sempre contém espaço/símbolos,
            // então não passa na validação de nome único.
            if is_valid_player_name(name) {
                return Some((name.to_string(), joined));
            }
            return None;
        }
    }
    None
}

/// Resposta do comando `list`: "There are N of a max of M players online: a, b".
/// Devolve os nomes (vazio se N=0). None quando o formato não bate com o
/// esperado (servidor modificado/outro idioma) ou quando a contagem não casa
/// com os nomes — nesse caso quem chamou mantém a lista que já tem, em vez de
/// "corrigir" com algo duvidoso.
pub fn parse_list_response(line: &str) -> Option<Vec<String>> {
    let clean = strip_ansi(line);
    let payload = system_message(log_payload(&clean));
    let rest = payload.strip_prefix("There are ")?;
    let (head, names_part) = rest.split_once("players online")?;
    let names_part = names_part.strip_prefix(':').unwrap_or(names_part).trim();

    // "N of a max of M" (Java moderno) ou "N/M" (versões antigas).
    let count: usize = head
        .trim()
        .split(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())?
        .parse()
        .ok()?;

    let names: Vec<String> = names_part
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    if names.iter().any(|n| !is_valid_player_name(n)) {
        return None;
    }
    if names.len() != count {
        return None;
    }
    Some(names)
}

/// Ordenação estável e limite de tamanho da lista enviada ao painel.
pub fn sorted_capped(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut v: Vec<String> = names.into_iter().collect();
    v.sort_by_key(|n| n.to_lowercase());
    v.truncate(MAX_PLAYERS_LISTED);
    v
}

/// Motivo opcional de kick/ban. Rejeita (em vez de "limpar") caracteres de
/// controle — uma quebra de linha viraria um segundo comando no stdin.
pub fn sanitize_reason(raw: &str) -> Result<Option<String>, &'static str> {
    if raw.chars().any(|c| c.is_control()) {
        return Err("Motivo inválido.");
    }
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return Ok(None);
    }
    if collapsed.chars().count() > MAX_REASON_CHARS {
        return Err("Motivo muito longo (máximo 100 caracteres).");
    }
    Ok(Some(collapsed))
}

/// Monta o comando de console de uma ação de moderação. Única porta de
/// entrada: o painel nunca manda texto livre para essas ações.
pub fn build_player_command(action: &str, player: &str, reason: Option<&str>) -> Result<String, &'static str> {
    if !is_valid_player_name(player) {
        return Err("Nome de jogador inválido.");
    }
    let verb = match action {
        "kick" | "ban" | "pardon" => action,
        _ => return Err("Ação não suportada."),
    };
    if verb == "pardon" {
        return Ok(format!("pardon {}", player));
    }
    match sanitize_reason(reason.unwrap_or(""))? {
        Some(r) => Ok(format!("{} {} {}", verb, player, r)),
        None => Ok(format!("{} {}", verb, player)),
    }
}

/// `requestId` vem do painel e só é ecoado de volta — restringe ao que é seguro
/// (e curto) em vez de repassar qualquer string.
pub fn sanitize_request_id(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > 100 {
        return None;
    }
    if raw.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_') {
        Some(raw.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_leave_vanilla_e_paper() {
        assert_eq!(
            parse_player_event("[12:00:01] [Server thread/INFO]: Steve joined the game"),
            Some(("Steve".into(), true))
        );
        assert_eq!(
            parse_player_event("[12:05:00] [Server thread/INFO]: Steve left the game"),
            Some(("Steve".into(), false))
        );
        // Sem prefixo (launcher que remove).
        assert_eq!(parse_player_event("Alex_99 joined the game"), Some(("Alex_99".into(), true)));
        // Prefixo com CR no fim e cores ANSI do pseudo-terminal.
        assert_eq!(
            parse_player_event("\u{1b}[33m[12:00:01] [Server thread/INFO]: Steve joined the game\u{1b}[0m\r"),
            Some(("Steve".into(), true))
        );
        // Floodgate (Bedrock).
        assert_eq!(parse_player_event("[x] [Server thread/INFO]: .Bedrock joined the game"), Some((".Bedrock".into(), true)));
    }

    #[test]
    fn prefixo_system_chat_de_servidores_recentes() {
        // Linhas reais do log de um servidor vanilla recente.
        assert_eq!(
            parse_player_event("[22:07:22] [Server thread/INFO]: System chat: oCodigo joined the game"),
            Some(("oCodigo".into(), true))
        );
        assert_eq!(
            parse_player_event("[22:25:08] [Server thread/INFO]: System chat: oCodigo left the game"),
            Some(("oCodigo".into(), false))
        );
        assert_eq!(
            parse_list_response("[22:07:43] [Server thread/INFO]: System chat: There are 1 of a max of 20 players online: oCodigo"),
            Some(vec!["oCodigo".to_string()])
        );
        assert_eq!(
            parse_list_response("[22:02:34] [Server thread/INFO]: System chat: There are 0 of a max of 20 players online: "),
            Some(vec![])
        );
    }

    #[test]
    fn prefixo_system_chat_nao_abre_brecha_para_chat_forjado() {
        // Chat de jogador continua com "<Nome>" na frente, mesmo imitando o prefixo.
        assert_eq!(parse_player_event("[x] [Server thread/INFO]: <Eve> System chat: Fulano joined the game"), None);
        assert_eq!(parse_player_event("[x] [Server thread/INFO]: [Not Secure] <Eve> System chat: Fulano joined the game"), None);
        assert_eq!(
            parse_list_response("[x] [Server thread/INFO]: <Eve> System chat: There are 1 of a max of 20 players online: Fake"),
            None
        );
        // O prefixo sozinho não basta: o resto ainda precisa ser exatamente o evento.
        assert_eq!(parse_player_event("[x] [Server thread/INFO]: System chat: <Eve> Fulano joined the game"), None);
    }

    #[test]
    fn chat_forjado_nao_vira_jogador_online() {
        // Antes: o último token antes do sufixo ("Fulano") era registrado.
        assert_eq!(parse_player_event("[12:00:01] [Server thread/INFO]: <Eve> Fulano joined the game"), None);
        assert_eq!(parse_player_event("[12:00:01] [Server thread/INFO]: [Not Secure] <Eve> Fulano left the game"), None);
        // Chat que imita o próprio prefixo de log.
        assert_eq!(parse_player_event("[12:00:01] [Server thread/INFO]: <Eve> ]: Fulano joined the game"), None);
    }

    #[test]
    fn eventos_invalidos_sao_ignorados() {
        assert_eq!(parse_player_event(""), None);
        assert_eq!(parse_player_event("[x] [Server thread/INFO]:  joined the game"), None);
        assert_eq!(parse_player_event("[x] [Server thread/INFO]: Steve lost connection: Disconnected"), None);
        assert_eq!(parse_player_event("[x] [Server thread/INFO]: nome com espaco joined the game"), None);
        assert_eq!(parse_player_event("[x] [Server thread/INFO]: ABCDEFGHIJKLMNOPQ joined the game"), None); // 17 chars
    }

    #[test]
    fn nome_valido() {
        assert!(is_valid_player_name("Steve"));
        assert!(is_valid_player_name("a"));
        assert!(is_valid_player_name("_x_"));
        assert!(is_valid_player_name(".Bedrock"));
        assert!(!is_valid_player_name(""));
        assert!(!is_valid_player_name("."));
        assert!(!is_valid_player_name("@a"));
        assert!(!is_valid_player_name("a b"));
        assert!(!is_valid_player_name("x\nstop"));
        assert!(!is_valid_player_name("x\r"));
        assert!(!is_valid_player_name("ção"));
        assert!(!is_valid_player_name("ABCDEFGHIJKLMNOPQ"));
    }

    #[test]
    fn list_resposta_normal() {
        assert_eq!(
            parse_list_response("[12:00:00] [Server thread/INFO]: There are 2 of a max of 20 players online: Steve, Alex"),
            Some(vec!["Steve".to_string(), "Alex".to_string()])
        );
        assert_eq!(
            parse_list_response("[12:00:00] [Server thread/INFO]: There are 0 of a max of 20 players online: "),
            Some(vec![])
        );
        assert_eq!(
            parse_list_response("[12:00:00] [Server thread/INFO]: There are 0 of a max of 20 players online:"),
            Some(vec![])
        );
        // Formato antigo.
        assert_eq!(
            parse_list_response("[12:00:00] [Server thread/INFO]: There are 1/20 players online: Steve"),
            Some(vec!["Steve".to_string()])
        );
    }

    #[test]
    fn list_resposta_duvidosa_e_ignorada() {
        // Contagem não bate com os nomes (linha quebrada/cortada).
        assert_eq!(parse_list_response("[x] [Server thread/INFO]: There are 3 of a max of 20 players online: Steve, Alex"), None);
        // Nome inválido (servidor com grupos/cores de plugin).
        assert_eq!(parse_list_response("[x] [Server thread/INFO]: There are 1 of a max of 20 players online: [Admin] Steve"), None);
        // Outro idioma / formato desconhecido.
        assert_eq!(parse_list_response("[x] [Server thread/INFO]: Há 1 de 20 jogadores online: Steve"), None);
        assert_eq!(parse_list_response("[x] [Server thread/INFO]: There are many players online: Steve"), None);
    }

    #[test]
    fn list_forjada_por_chat_e_ignorada() {
        assert_eq!(
            parse_list_response("[x] [Server thread/INFO]: <Eve> There are 1 of a max of 20 players online: Fake"),
            None
        );
        assert_eq!(
            parse_list_response("[x] [Server thread/INFO]: [Server] There are 1 of a max of 20 players online: Fake"),
            None
        );
    }

    #[test]
    fn sorted_capped_ordena_e_limita() {
        let v = sorted_capped(vec!["bob".to_string(), "Alice".to_string(), "carl".to_string()]);
        assert_eq!(v, vec!["Alice", "bob", "carl"]);
        let many: Vec<String> = (0..500).map(|i| format!("p{}", i)).collect();
        assert_eq!(sorted_capped(many).len(), MAX_PLAYERS_LISTED);
    }

    #[test]
    fn comando_de_moderacao() {
        assert_eq!(build_player_command("kick", "Steve", None).unwrap(), "kick Steve");
        assert_eq!(build_player_command("kick", "Steve", Some("   ")).unwrap(), "kick Steve");
        assert_eq!(build_player_command("ban", "Steve", Some("fazendo  grief")).unwrap(), "ban Steve fazendo grief");
        assert_eq!(build_player_command("pardon", "Steve", Some("ignorado")).unwrap(), "pardon Steve");
    }

    #[test]
    fn comando_de_moderacao_barra_injecao() {
        assert!(build_player_command("kick", "Steve\nstop", None).is_err());
        assert!(build_player_command("kick", "@a", None).is_err());
        assert!(build_player_command("kick", "Steve extra", None).is_err());
        assert!(build_player_command("kick", "", None).is_err());
        assert!(build_player_command("ban", "Steve", Some("motivo\nstop")).is_err());
        assert!(build_player_command("ban", "Steve", Some("motivo\r\nop Eve")).is_err());
        assert!(build_player_command("ban", "Steve", Some("a\u{7}b")).is_err());
        assert!(build_player_command("ban", "Steve", Some(&"x".repeat(MAX_REASON_CHARS + 1))).is_err());
        assert!(build_player_command("ban", "Steve", Some(&"x".repeat(MAX_REASON_CHARS))).is_ok());
        assert!(build_player_command("op", "Steve", None).is_err());
        assert!(build_player_command("stop", "Steve", None).is_err());
    }

    #[test]
    fn request_id() {
        assert_eq!(sanitize_request_id("u1.abc-123_x"), Some("u1.abc-123_x".into()));
        assert_eq!(sanitize_request_id(""), None);
        assert_eq!(sanitize_request_id("a b"), None);
        assert_eq!(sanitize_request_id("a\nb"), None);
        assert_eq!(sanitize_request_id(&"a".repeat(101)), None);
    }
}
