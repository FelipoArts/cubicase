// ============================================================
// Testes automatizados do backend
// ============================================================
// Cobre a lógica com mais risco de regressão silenciosa: gerenciamento de
// jogadores (whitelist/ops/banidos), backup/restauração de mundo, parsing de
// server.properties, detecção de erros conhecidos do Minecraft/sidecar, e o
// cálculo de UUID offline (que precisa bater exatamente com o algoritmo do
// próprio Minecraft, ou bans/whitelist por UUID silenciosamente não fazem
// efeito nenhum).
//
// Roda com `cargo test` (ou `npm run test:backend`, que já usa --quiet pra
// não poluir o console). Tudo aqui é local — sem rede, sem AppHandle, sem
// subir o app de verdade — só arquivos temporários descartados no final de
// cada teste.
// ============================================================

use super::*;
use std::fs;
use tempfile::TempDir;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

fn server_dir(tmp: &TempDir) -> String {
    tmp.path().to_string_lossy().to_string()
}

fn write_properties(tmp: &TempDir, content: &str) {
    fs::write(tmp.path().join("server.properties"), content).unwrap();
}

fn make_world(tmp: &TempDir, level_name: &str, suffix: &str) -> std::path::PathBuf {
    let dir = tmp.path().join(format!("{}{}", level_name, suffix));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Pasta de backups "externa" pros testes — só precisa ser DIFERENTE de
/// server_dir (que é `tmp.path()`) pra validar de verdade que backup_world/
/// restore_world_backup/delete_world_backup/list_world_backups usam o
/// parâmetro `backups_dir` recebido em vez de assumir `{server_dir}/backups`
/// (o comportamento antigo, antes de backups passarem a viver fora da pasta
/// do servidor — ver getBackupsDir no lado TS).
fn backups_dir_for(tmp: &TempDir) -> String {
    tmp.path().join("_external_backups").to_string_lossy().to_string()
}

/// Constrói um `tauri::State<AppState>` de teste SEM precisar de um app Tauri
/// de verdade (nem de `tauri::test::mock_app()`/feature "test", que nesta
/// máquina quebra o próprio binário de teste no link — STATUS_ENTRYPOINT_NOT_FOUND,
/// provavelmente puxando uma dependência de webview/runtime incompatível).
///
/// `tauri::State<'r, T>` é definido como uma tupla de um campo só (`&'r T`) —
/// mesmo layout de memória de uma referência comum — e não carrega nenhum
/// parâmetro de Runtime, então não há diferença nenhuma entre um State obtido
/// de um app de verdade e um construído assim; só o construtor público não
/// existe fora do crate `tauri` (o campo da tupla é privado). Usado só em
/// `#[cfg(test)]`. NÃO serve pra testar nada que dependa de AppHandle/janela
/// de verdade (outro problema, não resolvido por aqui — ver decisão da sessão
/// de 2026-09-28 sobre o harness de lifecycle do MC).
fn state_from(app_state: &AppState) -> tauri::State<'_, AppState> {
    unsafe { std::mem::transmute::<&AppState, tauri::State<'_, AppState>>(app_state) }
}

/// Spawna um processo curto e inofensivo (alguns segundos, sem tocar em
/// arquivo nenhum) só para simular "servidor Minecraft rodando" em
/// `state.minecraft_process` nos testes da trava `ensure_mc_server_stopped` —
/// não é um Java de verdade, só precisa estar vivo (`try_wait() == Ok(None)`)
/// no instante em que o teste checa a trava.
fn spawn_fake_running_process() -> Box<dyn portable_pty::Child + Send> {
    let pty_system = portable_pty::native_pty_system();
    let pty_pair = pty_system
        .openpty(portable_pty::PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .expect("falha ao alocar pty de teste");
    let mut cmd = if cfg!(windows) {
        let mut c = portable_pty::CommandBuilder::new("ping");
        c.args(["-n", "5", "127.0.0.1"]);
        c
    } else {
        let mut c = portable_pty::CommandBuilder::new("sleep");
        c.arg("5");
        c
    };
    cmd.cwd(std::env::temp_dir());
    pty_pair.slave.spawn_command(cmd).expect("falha ao spawnar processo de teste")
}

// ------------------------------------------------------------
// map_sidecar_error_code / detect_known_mc_error / truncate_chars / read_log_tail
// ------------------------------------------------------------

#[test]
fn sidecar_error_known_codes_have_friendly_messages() {
    for code in [
        "config_missing",
        "config_read_failed",
        "config_decode_failed",
        "mesh_auth_failed",
        "no_ip_assigned",
        "listen_mesh_failed",
    ] {
        let (title, message) = map_sidecar_error_code(code, "");
        assert!(!title.is_empty());
        assert!(!message.is_empty());
    }
}

#[test]
fn sidecar_error_listen_local_failed_includes_detail() {
    let (title, message) = map_sidecar_error_code("listen_local_failed", "port 25565 in use");
    assert_eq!(title, "Porta local já em uso");
    assert!(message.contains("port 25565 in use"));
}

#[test]
fn sidecar_error_unknown_code_falls_back_to_detail_or_code() {
    let (_, with_detail) = map_sidecar_error_code("something_new", "raw detail here");
    assert_eq!(with_detail, "raw detail here");

    let (_, without_detail) = map_sidecar_error_code("something_new", "");
    assert!(without_detail.contains("something_new"));
}

#[test]
fn detects_known_minecraft_errors() {
    let cases = [
        ("java.lang.OutOfMemoryError: Java heap space", "out_of_memory"),
        ("Could not reserve enough space for object heap", "out_of_memory"),
        ("UnsupportedClassVersionError: app has been compiled by a more recent version", "java_version_incompatible"),
        ("java.net.BindException: Address already in use", "port_in_use"),
        ("Exception: BindException at ...", "port_in_use"),
        ("You need to agree to the EULA in order to run the server", "eula_not_accepted"),
    ];
    for (line, expected_code) in cases {
        let result = detect_known_mc_error(line);
        assert!(result.is_some(), "esperava detectar erro na linha: {line}");
        assert_eq!(result.unwrap().0, expected_code);
    }
}

#[test]
fn detects_known_minecraft_errors_returns_none_for_unrelated_lines() {
    assert!(detect_known_mc_error("[Server thread/INFO]: Done (12.345s)! For help, type \"help\"").is_none());
    assert!(detect_known_mc_error("").is_none());
}

// ------------------------------------------------------------
// is_server_ready_line / decide_mc_shutdown_outcome
//
// Lógica de decisão do ciclo de vida do servidor MC, extraída de
// start_minecraft_server pra ser testável sem spawnar um processo de
// verdade nem depender de AppHandle/State (ver comentário na definição de
// decide_mc_shutdown_outcome em lib.rs).
// ------------------------------------------------------------

#[test]
fn is_server_ready_line_matches_vanilla_and_forge_done_lines() {
    assert!(is_server_ready_line("[12:00:00] [Server thread/INFO]: Done (5.432s)! For help, type \"help\""));
    assert!(is_server_ready_line("[main/INFO] [Server]: Done (32.1s)! For help, type \"help\" or \"?\""));
}

#[test]
fn is_server_ready_line_ignores_lines_without_done_or_without_info() {
    // "Done (" sem "INFO" (ex: alguma outra linha mencionando o texto solto)
    assert!(!is_server_ready_line("Done (isso não é log de verdade)"));
    // "INFO" sem o "Done (" que marca o boot completo
    assert!(!is_server_ready_line("[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.20.1"));
    assert!(!is_server_ready_line(""));
}

#[test]
fn shutdown_outcome_clean_stop_via_stdin_is_normal() {
    // Fluxo feliz: usuário mandou "stop", servidor salvou e saiu com código 0.
    assert_eq!(
        decide_mc_shutdown_outcome(Some(0), true, false),
        McShutdownOutcome::Normal
    );
}

#[test]
fn shutdown_outcome_forced_kill_after_stop_requested_is_still_normal() {
    // stop_minecraft_server_internal força kill se o processo não sair em 15s —
    // mesmo com exit code != 0/desconhecido, foi pedido pelo usuário, não é crash.
    assert_eq!(
        decide_mc_shutdown_outcome(None, true, false),
        McShutdownOutcome::Normal
    );
    assert_eq!(
        decide_mc_shutdown_outcome(Some(1), true, false),
        McShutdownOutcome::Normal
    );
}

#[test]
fn shutdown_outcome_unexpected_exit_without_stop_request_is_crash() {
    // Processo morreu sozinho (exit code != 0) sem ninguém ter pedido "stop".
    assert_eq!(
        decide_mc_shutdown_outcome(Some(1), false, false),
        McShutdownOutcome::Crashed
    );
    // Kill externo (ex: Gerenciador de Tarefas) também não tem exit code limpo.
    assert_eq!(
        decide_mc_shutdown_outcome(None, false, false),
        McShutdownOutcome::Crashed
    );
}

#[test]
fn shutdown_outcome_new_crash_report_always_wins_even_with_clean_exit() {
    // O caso sutil que motivou a estratégia dupla: a JVM as vezes escreve um
    // crash-report e ainda assim sai com código 0 / a parada foi "pedida"
    // (ex: watchdog do próprio Minecraft chamando stop após travar). Um
    // crash-report novo precisa vencer nesses casos, ou o usuário nunca fica
    // sabendo que algo deu errado.
    assert_eq!(
        decide_mc_shutdown_outcome(Some(0), false, true),
        McShutdownOutcome::Crashed
    );
    assert_eq!(
        decide_mc_shutdown_outcome(Some(0), true, true),
        McShutdownOutcome::Crashed
    );
}

#[test]
fn truncate_chars_keeps_short_strings_untouched() {
    assert_eq!(truncate_chars("curto", 100), "curto");
    assert_eq!(truncate_chars("exato", 5), "exato"); // no limite exato, não trunca
}

#[test]
fn truncate_chars_truncates_by_char_count_not_bytes() {
    // "áéíóú" tem 5 chars mas mais de 5 bytes em UTF-8 — truncar por byte quebraria no meio de um caractere.
    let s = "áéíóúçãõ";
    let truncated = truncate_chars(s, 3);
    assert_eq!(truncated, "áéí\n... (truncado)");
}

#[test]
fn read_log_tail_missing_file_returns_none() {
    let tmp = TempDir::new().unwrap();
    assert!(read_log_tail(&server_dir(&tmp), 10).is_none());
}

#[test]
fn read_log_tail_returns_only_last_n_lines() {
    let tmp = TempDir::new().unwrap();
    let logs_dir = tmp.path().join("logs");
    fs::create_dir_all(&logs_dir).unwrap();
    let lines: Vec<String> = (1..=20).map(|i| format!("linha {i}")).collect();
    fs::write(logs_dir.join("latest.log"), lines.join("\n")).unwrap();

    let tail = read_log_tail(&server_dir(&tmp), 3).unwrap();
    assert_eq!(tail, "linha 18\nlinha 19\nlinha 20");
}

#[test]
fn read_log_tail_returns_everything_if_fewer_lines_than_requested() {
    let tmp = TempDir::new().unwrap();
    let logs_dir = tmp.path().join("logs");
    fs::create_dir_all(&logs_dir).unwrap();
    fs::write(logs_dir.join("latest.log"), "a\nb").unwrap();

    let tail = read_log_tail(&server_dir(&tmp), 50).unwrap();
    assert_eq!(tail, "a\nb");
}

// ------------------------------------------------------------
// server.properties (read/write) + online-mode + level-name
// ------------------------------------------------------------

#[tokio::test]
async fn read_server_properties_parses_key_value_and_skips_comments() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "# comentário\n\nlevel-name=meu-mundo\nmax-players=10\n");

    let result = read_server_properties(server_dir(&tmp)).await.unwrap();
    assert_eq!(result["level-name"], "meu-mundo");
    assert_eq!(result["max-players"], "10");
}

#[tokio::test]
async fn read_server_properties_missing_file_is_error() {
    let tmp = TempDir::new().unwrap();
    assert!(read_server_properties(server_dir(&tmp)).await.is_err());
}

#[tokio::test]
async fn write_server_properties_updates_existing_key_in_place() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "level-name=world\nmax-players=10\n");
    let app_state = AppState::default();

    let mut props = HashMap::new();
    props.insert("max-players".to_string(), "20".to_string());
    write_server_properties(state_from(&app_state), server_dir(&tmp), props).await.unwrap();

    let content = fs::read_to_string(tmp.path().join("server.properties")).unwrap();
    assert!(content.contains("max-players=20"));
    assert!(content.contains("level-name=world"));
    assert!(!content.contains("max-players=10"));
}

#[tokio::test]
async fn write_server_properties_appends_new_key_and_creates_file_if_missing() {
    let tmp = TempDir::new().unwrap();
    let app_state = AppState::default();
    let mut props = HashMap::new();
    props.insert("online-mode".to_string(), "false".to_string());
    write_server_properties(state_from(&app_state), server_dir(&tmp), props).await.unwrap();

    let content = fs::read_to_string(tmp.path().join("server.properties")).unwrap();
    assert!(content.contains("online-mode=false"));
}

#[test]
fn read_online_mode_defaults_to_true_when_missing() {
    let tmp = TempDir::new().unwrap();
    assert!(read_online_mode(&server_dir(&tmp)));
}

#[test]
fn read_online_mode_respects_explicit_false() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "online-mode=false\n");
    assert!(!read_online_mode(&server_dir(&tmp)));
}

#[test]
fn read_online_mode_respects_explicit_true() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "online-mode=true\n");
    assert!(read_online_mode(&server_dir(&tmp)));
}

#[test]
fn read_level_name_defaults_to_world() {
    let tmp = TempDir::new().unwrap();
    assert_eq!(read_level_name(&server_dir(&tmp)), "world");
}

#[test]
fn read_level_name_reads_custom_value() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "level-name=meu-mundo\n");
    assert_eq!(read_level_name(&server_dir(&tmp)), "meu-mundo");
}

#[test]
fn read_level_name_falls_back_when_value_is_empty() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "level-name=\n");
    assert_eq!(read_level_name(&server_dir(&tmp)), "world");
}

#[test]
fn world_folder_paths_only_returns_existing_dirs() {
    let tmp = TempDir::new().unwrap();
    make_world(&tmp, "world", "");
    make_world(&tmp, "world", "_nether");
    // world_the_end não existe

    let paths = world_folder_paths(&server_dir(&tmp), "world");
    assert_eq!(paths.len(), 2);
}

#[test]
fn world_folder_paths_empty_when_nothing_exists() {
    let tmp = TempDir::new().unwrap();
    assert!(world_folder_paths(&server_dir(&tmp), "world").is_empty());
}

// ------------------------------------------------------------
// world_last_modified
// ------------------------------------------------------------

#[test]
fn world_last_modified_none_when_world_never_existed() {
    let tmp = TempDir::new().unwrap();
    assert_eq!(world_last_modified(server_dir(&tmp)).unwrap(), None);
}

#[test]
fn world_last_modified_some_when_world_has_files() {
    let tmp = TempDir::new().unwrap();
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"fake nbt data").unwrap();

    let result = world_last_modified(server_dir(&tmp)).unwrap();
    assert!(result.is_some());
    // precisa ser um RFC3339 válido, já que autoBackup.ts compara essas strings como opacas.
    assert!(chrono::DateTime::parse_from_rfc3339(&result.unwrap()).is_ok());
}

// ------------------------------------------------------------
// offline_player_uuid / format_uuid_with_dashes
// ------------------------------------------------------------

#[test]
fn offline_player_uuid_matches_minecraft_algorithm() {
    // Valores de referência calculados independentemente (MD5 de
    // "OfflinePlayer:<nome>" com os bits de versão/variante ajustados para
    // UUID v3), não copiados da implementação em Rust.
    assert_eq!(
        offline_player_uuid("TestPlayer123").to_string(),
        "d80b74d8-555e-3ea2-8280-a62da27307e1"
    );
    assert_eq!(
        offline_player_uuid("").to_string(),
        "fc5bc365-aedf-30a8-8b89-04e462e29bde"
    );
}

#[test]
fn offline_player_uuid_is_deterministic_and_unique_per_name() {
    assert_eq!(offline_player_uuid("Steve"), offline_player_uuid("Steve"));
    assert_ne!(offline_player_uuid("Steve"), offline_player_uuid("Alex"));
}

#[test]
fn offline_player_uuid_has_correct_version_and_variant_bits() {
    let uuid = offline_player_uuid("QualquerNome");
    let bytes = uuid.as_bytes();
    assert_eq!(bytes[6] & 0xf0, 0x30, "deveria ser UUID versão 3");
    assert_eq!(bytes[8] & 0xc0, 0x80, "variante deveria ser RFC 4122");
}

#[test]
fn format_uuid_with_dashes_inserts_dashes_correctly() {
    assert_eq!(
        format_uuid_with_dashes("d80b74d8555e3ea28280a62da27307e1"),
        "d80b74d8-555e-3ea2-8280-a62da27307e1"
    );
}

#[test]
fn format_uuid_with_dashes_leaves_wrong_length_untouched() {
    assert_eq!(format_uuid_with_dashes("nao-tem-32-chars"), "nao-tem-32-chars");
    assert_eq!(format_uuid_with_dashes(""), "");
}

#[test]
fn current_ban_timestamp_matches_expected_format() {
    // Formato "YYYY-MM-DD HH:MM:SS +ZZZZ" (o mesmo que banned-players.json do
    // Minecraft usa) — não dá pra comparar o valor exato (depende do agora),
    // então valida a estrutura.
    let ts = current_ban_timestamp();
    let parts: Vec<&str> = ts.split(' ').collect();
    assert_eq!(parts.len(), 3, "esperava 3 partes separadas por espaço: {ts}");
    assert_eq!(parts[0].len(), 10); // YYYY-MM-DD
    assert_eq!(parts[1].len(), 8); // HH:MM:SS
    assert!(parts[2].starts_with('+') || parts[2].starts_with('-'));
}

// ------------------------------------------------------------
// Whitelist / Operadores / Banidos (offline-mode, sem rede)
// ------------------------------------------------------------

fn offline_server(tmp: &TempDir) -> String {
    write_properties(tmp, "online-mode=false\n");
    server_dir(tmp)
}

#[tokio::test]
async fn whitelist_add_list_remove_round_trip() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);
    let app_state = AppState::default();

    assert!(list_whitelist(dir.clone()).await.unwrap().is_empty());

    let added = add_whitelist_player(state_from(&app_state), dir.clone(), "Steve".to_string()).await.unwrap();
    assert_eq!(added.name, "Steve");
    assert_eq!(added.uuid, offline_player_uuid("Steve").to_string());

    let listed = list_whitelist(dir.clone()).await.unwrap();
    assert_eq!(listed.len(), 1);

    remove_whitelist_player(state_from(&app_state), dir.clone(), added.uuid).await.unwrap();
    assert!(list_whitelist(dir.clone()).await.unwrap().is_empty());
}

#[tokio::test]
async fn whitelist_rejects_duplicate_name_case_insensitive() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);
    let app_state = AppState::default();

    add_whitelist_player(state_from(&app_state), dir.clone(), "Steve".to_string()).await.unwrap();
    let err = add_whitelist_player(state_from(&app_state), dir.clone(), "STEVE".to_string()).await;
    assert!(err.is_err());
}

#[tokio::test]
async fn whitelist_remove_nonexistent_is_error() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);
    let app_state = AppState::default();
    let err = remove_whitelist_player(state_from(&app_state), dir, "uuid-que-nao-existe".to_string()).await;
    assert!(err.is_err());
}

#[tokio::test]
async fn ops_add_grants_level_four_by_default() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);
    let app_state = AppState::default();

    let op = add_op(state_from(&app_state), dir.clone(), "Alex".to_string()).await.unwrap();
    assert_eq!(op.level, 4);
    assert!(!op.bypasses_player_limit);

    remove_op(state_from(&app_state), dir.clone(), op.uuid).await.unwrap();
    assert!(list_ops(dir).await.unwrap().is_empty());
}

#[tokio::test]
async fn ban_player_uses_default_reason_when_none_given() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);
    let app_state = AppState::default();

    let banned = ban_player(state_from(&app_state), dir.clone(), "Grief3r".to_string(), None).await.unwrap();
    assert_eq!(banned.reason, "Banido por um operador.");
    assert_eq!(banned.expires, "forever");

    let err = ban_player(state_from(&app_state), dir.clone(), "Grief3r".to_string(), None).await;
    assert!(err.is_err(), "não deveria permitir banir o mesmo jogador duas vezes");

    pardon_player(state_from(&app_state), dir.clone(), banned.uuid).await.unwrap();
    assert!(list_banned_players(dir).await.unwrap().is_empty());
}

#[tokio::test]
async fn ban_player_keeps_custom_reason() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);
    let app_state = AppState::default();

    let banned = ban_player(state_from(&app_state), dir, "Grief3r".to_string(), Some("Xingou no chat".to_string())).await.unwrap();
    assert_eq!(banned.reason, "Xingou no chat");
}

#[tokio::test]
async fn ban_ip_round_trip_and_duplicate_rejection() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);
    let app_state = AppState::default();

    ban_ip(state_from(&app_state), dir.clone(), "203.0.113.9".to_string(), None).await.unwrap();
    let err = ban_ip(state_from(&app_state), dir.clone(), "203.0.113.9".to_string(), None).await;
    assert!(err.is_err());

    pardon_ip(state_from(&app_state), dir.clone(), "203.0.113.9".to_string()).await.unwrap();
    assert!(list_banned_ips(dir).await.unwrap().is_empty());
}

#[tokio::test]
async fn pardon_ip_nonexistent_is_error() {
    let tmp = TempDir::new().unwrap();
    let dir = offline_server(&tmp);
    let app_state = AppState::default();
    assert!(pardon_ip(state_from(&app_state), dir, "203.0.113.9".to_string()).await.is_err());
}

// ------------------------------------------------------------
// read_json_list / write_json_list (usados por whitelist/ops/bans)
// ------------------------------------------------------------

#[test]
fn read_json_list_missing_file_returns_empty() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("nao-existe.json");
    let result: Vec<WhitelistEntry> = read_json_list(&path).unwrap();
    assert!(result.is_empty());
}

#[test]
fn read_json_list_empty_file_returns_empty() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("vazio.json");
    fs::write(&path, "").unwrap();
    let result: Vec<WhitelistEntry> = read_json_list(&path).unwrap();
    assert!(result.is_empty());
}

#[test]
fn read_json_list_malformed_json_is_error() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("corrompido.json");
    fs::write(&path, "{ isso nao eh um array valido").unwrap();
    let result: Result<Vec<WhitelistEntry>, String> = read_json_list(&path);
    assert!(result.is_err());
}

// ------------------------------------------------------------
// Backup / restauração / reset de mundo
// ------------------------------------------------------------

#[tokio::test]
async fn backup_world_fails_when_no_world_exists() {
    let tmp = TempDir::new().unwrap();
    let err = backup_world(server_dir(&tmp), backups_dir_for(&tmp)).await;
    assert!(err.is_err());
}

#[tokio::test]
async fn backup_world_creates_zip_with_world_contents() {
    let tmp = TempDir::new().unwrap();
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"conteudo de teste").unwrap();
    let backups_dir = backups_dir_for(&tmp);

    let info = backup_world(server_dir(&tmp), backups_dir.clone()).await.unwrap();
    assert!(info.file_name.starts_with("world_"));
    assert!(info.file_name.ends_with(".zip"));
    assert!(info.size_bytes > 0);

    let backups = list_world_backups(server_dir(&tmp), backups_dir).await.unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0].file_name, info.file_name);
}

#[tokio::test]
async fn list_world_backups_empty_when_no_backups_dir() {
    let tmp = TempDir::new().unwrap();
    assert!(list_world_backups(server_dir(&tmp), backups_dir_for(&tmp)).await.unwrap().is_empty());
}

#[tokio::test]
async fn restore_world_backup_round_trip_replaces_world_contents() {
    let tmp = TempDir::new().unwrap();
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"versao original").unwrap();
    let app_state = AppState::default();
    let backups_dir = backups_dir_for(&tmp);

    let info = backup_world(server_dir(&tmp), backups_dir.clone()).await.unwrap();

    // Simula progresso do jogo depois do backup.
    fs::write(world.join("level.dat"), b"versao mais nova, sera perdida").unwrap();
    fs::write(world.join("novo-arquivo.txt"), b"nao existia no backup").unwrap();

    restore_world_backup(state_from(&app_state), server_dir(&tmp), backups_dir, info.file_name).await.unwrap();

    let restored = fs::read(world.join("level.dat")).unwrap();
    assert_eq!(restored, b"versao original");
}

#[tokio::test]
async fn restore_world_backup_missing_file_is_error() {
    let tmp = TempDir::new().unwrap();
    make_world(&tmp, "world", "");
    let app_state = AppState::default();
    let err = restore_world_backup(state_from(&app_state), server_dir(&tmp), backups_dir_for(&tmp), "nao-existe.zip".to_string()).await;
    assert!(err.is_err());
}

#[tokio::test]
async fn restore_world_backup_rejects_corrupted_zip_and_preserves_world() {
    let tmp = TempDir::new().unwrap();
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"mundo original intacto").unwrap();
    let app_state = AppState::default();

    let backups_dir = backups_dir_for(&tmp);
    fs::create_dir_all(&backups_dir).unwrap();
    fs::write(std::path::Path::new(&backups_dir).join("corrompido.zip"), b"isso nao eh um zip de verdade").unwrap();

    let err = restore_world_backup(state_from(&app_state), server_dir(&tmp), backups_dir, "corrompido.zip".to_string()).await;
    assert!(err.is_err());

    // O mundo original não pode ter sido tocado por um backup corrompido.
    let content = fs::read(world.join("level.dat")).unwrap();
    assert_eq!(content, b"mundo original intacto");
}

#[tokio::test]
async fn delete_world_backup_missing_is_error_existing_is_removed() {
    let tmp = TempDir::new().unwrap();
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"x").unwrap();
    let backups_dir = backups_dir_for(&tmp);
    let info = backup_world(server_dir(&tmp), backups_dir.clone()).await.unwrap();

    assert!(delete_world_backup(backups_dir.clone(), "nao-existe.zip".to_string()).await.is_err());

    delete_world_backup(backups_dir.clone(), info.file_name).await.unwrap();
    assert!(list_world_backups(server_dir(&tmp), backups_dir).await.unwrap().is_empty());
}

#[tokio::test]
async fn list_world_backups_migrates_legacy_backups_from_server_dir() {
    // Regressão: quem já tinha backups em `{server_dir}/backups` (localização
    // antiga, antes de backups passarem a viver fora da pasta do servidor)
    // não pode perder acesso a eles — devem aparecer migrados pra
    // `backups_dir` na primeira listagem.
    let tmp = TempDir::new().unwrap();
    let legacy_dir = tmp.path().join("backups");
    fs::create_dir_all(&legacy_dir).unwrap();
    fs::write(legacy_dir.join("world_legado.zip"), b"conteudo antigo").unwrap();

    let backups_dir = backups_dir_for(&tmp);
    let backups = list_world_backups(server_dir(&tmp), backups_dir.clone()).await.unwrap();

    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0].file_name, "world_legado.zip");
    assert!(std::path::Path::new(&backups_dir).join("world_legado.zip").is_file());
    // A pasta antiga não deve mais ter o arquivo (foi movido, não copiado).
    assert!(!legacy_dir.join("world_legado.zip").exists());
}

#[tokio::test]
async fn list_world_backups_migration_never_overwrites_existing_file_in_new_location() {
    let tmp = TempDir::new().unwrap();
    let legacy_dir = tmp.path().join("backups");
    fs::create_dir_all(&legacy_dir).unwrap();
    fs::write(legacy_dir.join("world_x.zip"), b"versao antiga (legado)").unwrap();

    let backups_dir = backups_dir_for(&tmp);
    fs::create_dir_all(&backups_dir).unwrap();
    fs::write(std::path::Path::new(&backups_dir).join("world_x.zip"), b"versao nova (ja migrada)").unwrap();

    list_world_backups(server_dir(&tmp), backups_dir.clone()).await.unwrap();

    let content = fs::read(std::path::Path::new(&backups_dir).join("world_x.zip")).unwrap();
    assert_eq!(content, b"versao nova (ja migrada)");
}

#[tokio::test]
async fn reset_world_removes_folders_and_errors_when_nothing_to_reset() {
    let tmp = TempDir::new().unwrap();
    let app_state = AppState::default();
    assert!(reset_world(state_from(&app_state), server_dir(&tmp)).await.is_err());

    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"x").unwrap();
    reset_world(state_from(&app_state), server_dir(&tmp)).await.unwrap();
    assert!(!world.exists());
}

// ------------------------------------------------------------
// ensure_mc_server_stopped
//
// Regressão do achado de pré-lançamento: nada no backend impedia
// reset_world/restore_world_backup/whitelist-ops-bans/mods de rodar com o
// processo Java ainda vivo (só a UI evitava isso, e só em alguns painéis —
// o de Jogadores checava apenas `serverStatus === "online"`, deixando os
// estados "starting"/"stopping" passarem direto pra edição de arquivo).
// ------------------------------------------------------------

#[test]
fn ensure_mc_server_stopped_allows_when_no_process_is_set() {
    let app_state = AppState::default();
    assert!(ensure_mc_server_stopped(&app_state).is_ok());
}

#[test]
fn ensure_mc_server_stopped_rejects_when_process_is_alive() {
    let app_state = AppState::default();
    *app_state.minecraft_process.lock().unwrap() = Some(spawn_fake_running_process());

    assert!(ensure_mc_server_stopped(&app_state).is_err());

    // Limpa o processo de teste antes de sair — não deixa órfão rodando.
    let taken = app_state.minecraft_process.lock().unwrap().take();
    if let Some(mut child) = taken {
        let _ = child.kill();
    }
}

#[tokio::test]
async fn reset_world_rejects_and_leaves_world_untouched_while_process_alive() {
    let tmp = TempDir::new().unwrap();
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("level.dat"), b"nao pode sumir").unwrap();

    let app_state = AppState::default();
    *app_state.minecraft_process.lock().unwrap() = Some(spawn_fake_running_process());

    let result = reset_world(state_from(&app_state), server_dir(&tmp)).await;
    assert!(result.is_err(), "reset_world não deveria rodar com o processo vivo");
    assert!(world.join("level.dat").exists(), "mundo não pode ter sido tocado");

    let taken = app_state.minecraft_process.lock().unwrap().take();
    if let Some(mut child) = taken {
        let _ = child.kill();
    }
}

// ------------------------------------------------------------
// Mods (listar / habilitar-desabilitar / apagar)
// ------------------------------------------------------------

#[tokio::test]
async fn list_mods_filters_and_sorts_correctly() {
    let tmp = TempDir::new().unwrap();
    let mods_dir = tmp.path().join("mods");
    fs::create_dir_all(&mods_dir).unwrap();
    fs::write(mods_dir.join("Zebra.jar"), b"x").unwrap();
    fs::write(mods_dir.join("apple.jar.disabled"), b"x").unwrap();
    fs::write(mods_dir.join("nota-mod.txt"), b"x").unwrap(); // deve ser ignorado

    let mods = list_mods(server_dir(&tmp), None).await.unwrap();
    assert_eq!(mods.len(), 2);
    // ordenação case-insensitive: "apple" antes de "Zebra"
    assert_eq!(mods[0].display_name, "apple.jar");
    assert!(!mods[0].enabled);
    assert_eq!(mods[1].display_name, "Zebra.jar");
    assert!(mods[1].enabled);
}

#[tokio::test]
async fn list_mods_empty_when_folder_missing() {
    let tmp = TempDir::new().unwrap();
    assert!(list_mods(server_dir(&tmp), None).await.unwrap().is_empty());
}

#[tokio::test]
async fn toggle_mod_disables_and_reenables() {
    let tmp = TempDir::new().unwrap();
    let mods_dir = tmp.path().join("mods");
    fs::create_dir_all(&mods_dir).unwrap();
    fs::write(mods_dir.join("Test.jar"), b"x").unwrap();
    let app_state = AppState::default();

    toggle_mod(state_from(&app_state), server_dir(&tmp), "Test.jar".to_string(), None).await.unwrap();
    assert!(mods_dir.join("Test.jar.disabled").exists());
    assert!(!mods_dir.join("Test.jar").exists());

    toggle_mod(state_from(&app_state), server_dir(&tmp), "Test.jar.disabled".to_string(), None).await.unwrap();
    assert!(mods_dir.join("Test.jar").exists());
}

#[tokio::test]
async fn toggle_mod_missing_file_is_error() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir_all(tmp.path().join("mods")).unwrap();
    let app_state = AppState::default();
    assert!(toggle_mod(state_from(&app_state), server_dir(&tmp), "fantasma.jar".to_string(), None).await.is_err());
}

#[tokio::test]
async fn delete_mod_removes_file_missing_is_error() {
    let tmp = TempDir::new().unwrap();
    let mods_dir = tmp.path().join("mods");
    fs::create_dir_all(&mods_dir).unwrap();
    fs::write(mods_dir.join("Test.jar"), b"x").unwrap();
    let app_state = AppState::default();

    assert!(delete_mod(state_from(&app_state), server_dir(&tmp), "fantasma.jar".to_string(), None).await.is_err());

    delete_mod(state_from(&app_state), server_dir(&tmp), "Test.jar".to_string(), None).await.unwrap();
    assert!(!mods_dir.join("Test.jar").exists());
}

// ------------------------------------------------------------
// Recorte/redimensionamento de ícone
// ------------------------------------------------------------

#[test]
fn crop_and_resize_icon_always_outputs_64x64_square() {
    // Imagem larga (100x50) — deve recortar o excesso e não distorcer.
    let wide = image::DynamicImage::ImageRgba8(image::RgbaImage::new(100, 50));
    let result = crop_and_resize_icon(wide);
    assert_eq!((result.width(), result.height()), (64, 64));

    // Imagem alta (50x100).
    let tall = image::DynamicImage::ImageRgba8(image::RgbaImage::new(50, 100));
    let result = crop_and_resize_icon(tall);
    assert_eq!((result.width(), result.height()), (64, 64));

    // Já quadrada, mas em tamanho diferente de 64.
    let square = image::DynamicImage::ImageRgba8(image::RgbaImage::new(200, 200));
    let result = crop_and_resize_icon(square);
    assert_eq!((result.width(), result.height()), (64, 64));
}

// ------------------------------------------------------------
// ConnectionSessionResponse — desserialização da resposta da API Central
// ------------------------------------------------------------
// A API (api/src/index.ts, handleCreateConnectionSession) devolve o payload
// em camelCase. Já aconteceu do struct ficar sem `rename_all` e todo
// `start_network_node` falhar com "missing field `session_id`" — trava a
// UI logo depois de "Autenticando sessão de rede". Este teste existe pra
// pegar essa regressão no `cargo test` em vez de só na hora de testar a UI.

#[test]
fn connection_session_response_parses_camel_case_payload() {
    let payload = serde_json::json!({
        "sessionId": "sess_abc123",
        "launcher": "tsnet-v1",
        "launcherVersion": 1,
        "protocolVersion": 1,
        "credentials": { "authKey": "tskey-auth-xxx", "hostname": "cf-host-e4595926" },
        "leaseDurationMs": 60000,
        "expiresAt": "2026-09-09T00:00:00Z",
    });

    let parsed: crate::api_client::ConnectionSessionResponse =
        serde_json::from_value(payload).expect("deve desserializar o payload camelCase da API");

    assert_eq!(parsed.session_id, "sess_abc123");
    assert_eq!(parsed.launcher_version, 1);
    assert_eq!(parsed.protocol_version, 1);
    assert_eq!(parsed.lease_duration_ms, 60000);
    assert_eq!(parsed.expires_at, "2026-09-09T00:00:00Z");
}

// ------------------------------------------------------------
// is_safe_relative_component / read_level_name
//
// Regressão do achado de pré-lançamento: um `level-name` malicioso ou mal
// editado em server.properties (valor absoluto ou com "..") não pode
// escapar do diretório do servidor ao ser usado por
// reset_world/backup_world/restore_world_backup — sem essa validação, um
// clique em "Resetar Mundo" podia apagar recursivamente qualquer pasta da
// máquina do usuário.
// ------------------------------------------------------------

#[test]
fn is_safe_relative_component_accepts_normal_single_component_names() {
    assert!(is_safe_relative_component("world"));
    assert!(is_safe_relative_component("my_world-2"));
    assert!(is_safe_relative_component("MUNDO_ACENTUADO_é"));
}

#[test]
fn is_safe_relative_component_rejects_traversal_and_absolute_paths() {
    assert!(!is_safe_relative_component(""));
    assert!(!is_safe_relative_component("."));
    assert!(!is_safe_relative_component(".."));
    assert!(!is_safe_relative_component("../../../Users/Someone/Desktop"));
    assert!(!is_safe_relative_component("C:\\Users\\Someone\\Documents"));
    assert!(!is_safe_relative_component("/etc/passwd"));
    assert!(!is_safe_relative_component("world/../../escape"));
    // Mais de um componente (mesmo sem ".."): também rejeitado, world_folder_paths
    // só espera um nome de pasta simples, não um caminho com subpastas.
    assert!(!is_safe_relative_component("sub/world"));
}

#[test]
fn read_level_name_falls_back_to_world_on_absolute_or_traversal_value() {
    let tmp = TempDir::new().unwrap();
    write_properties(&tmp, "level-name=C:\\Users\\Someone\\Documents\n");
    assert_eq!(read_level_name(&server_dir(&tmp)), "world");

    let tmp2 = TempDir::new().unwrap();
    write_properties(&tmp2, "level-name=../../../Desktop\n");
    assert_eq!(read_level_name(&server_dir(&tmp2)), "world");
}

// ------------------------------------------------------------
// atomic_write
//
// Regressão do achado de pré-lançamento: write_server_properties/
// write_json_list (whitelist/ops/bans) usavam std::fs::write direto, que
// TRUNCA o arquivo antes de escrever — um crash/disco cheio no meio podia
// zerar a whitelist inteira. atomic_write escreve num arquivo temporário e
// só troca por rename, que é atômico no mesmo diretório.
// ------------------------------------------------------------

#[test]
fn atomic_write_creates_file_with_expected_content_and_no_leftover_tmp() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("whitelist.json");
    atomic_write(&path, b"[]").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "[]");

    let entries: Vec<_> = fs::read_dir(tmp.path()).unwrap().filter_map(|e| e.ok()).collect();
    assert_eq!(entries.len(), 1, "esperava só o arquivo final, sem .tmp-* sobrando");
}

#[test]
fn atomic_write_fully_replaces_previous_content() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("server.properties");
    fs::write(&path, "level-name=world\nmax-players=20\n").unwrap();
    atomic_write(&path, b"level-name=world\nmax-players=5\n").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "level-name=world\nmax-players=5\n");
}

// ------------------------------------------------------------
// restore_world_backup
//
// Regressão do achado de pré-lançamento: o rollback ao falhar a extração
// ignorava erros (`let _ =`) e apagava a pasta de staging incondicionalmente
// — podendo perder o backup que falhou E o mundo original numa única
// operação. Os testes abaixo cobrem os dois caminhos que NÃO mudaram de
// comportamento (sucesso normal e zip corrompido detectado antes de tocar
// no mundo) — o caminho de falha-no-meio-do-rollback em si depende de um
// erro de I/O real (arquivo travado) e não é reproduzido de forma
// determinística aqui; ver scripts/mc-lifecycle-checklist.md.
// ------------------------------------------------------------

#[tokio::test]
async fn restore_world_backup_roundtrip_restores_original_content() {
    let tmp = TempDir::new().unwrap();
    let dir = server_dir(&tmp);
    write_properties(&tmp, "level-name=world\n");
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("marker.txt"), "original").unwrap();
    let app_state = AppState::default();
    let backups_dir = backups_dir_for(&tmp);

    let backup = backup_world(dir.clone(), backups_dir.clone()).await.expect("backup deve funcionar");

    // Simula o mundo "avançando" depois do backup.
    fs::write(world.join("marker.txt"), "changed after backup").unwrap();

    restore_world_backup(state_from(&app_state), dir.clone(), backups_dir, backup.file_name)
        .await
        .expect("restore deve funcionar");

    assert_eq!(fs::read_to_string(world.join("marker.txt")).unwrap(), "original");

    let leftover_staging = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| e.file_name().to_string_lossy().starts_with(".restore_staging_"));
    assert!(!leftover_staging, "staging_dir deveria ter sido limpo após sucesso");
}

#[tokio::test]
async fn restore_world_backup_corrupted_zip_leaves_original_world_untouched() {
    let tmp = TempDir::new().unwrap();
    let dir = server_dir(&tmp);
    write_properties(&tmp, "level-name=world\n");
    let world = make_world(&tmp, "world", "");
    fs::write(world.join("marker.txt"), "original").unwrap();

    let backups_dir = backups_dir_for(&tmp);
    fs::create_dir_all(&backups_dir).unwrap();
    fs::write(std::path::Path::new(&backups_dir).join("bad.zip"), b"not a real zip file").unwrap();
    let app_state = AppState::default();

    let result = restore_world_backup(state_from(&app_state), dir.clone(), backups_dir, "bad.zip".to_string()).await;
    assert!(result.is_err());
    assert_eq!(fs::read_to_string(world.join("marker.txt")).unwrap(), "original");
}

// ------------------------------------------------------------
// Conflito de papel da rede (host × guest)
// ------------------------------------------------------------

#[test]
fn role_conflict_only_when_active_role_differs() {
    assert!(!network_role_conflict(None, "host"));
    assert!(!network_role_conflict(None, "guest"));
    assert!(!network_role_conflict(Some("host"), "host"));
    assert!(!network_role_conflict(Some("guest"), "guest"));
    assert!(network_role_conflict(Some("host"), "guest"));
    assert!(network_role_conflict(Some("guest"), "host"));
}

// ------------------------------------------------------------
// Painel remoto: não reenviar o que não mudou
// ------------------------------------------------------------

#[test]
fn panel_agent_ignora_apenas_o_carimbo_ts_ao_comparar_mensagens() {
    use crate::panel_agent::same_ignoring_ts;
    let a = r#"{"type":"status","serverRunning":false,"playerCount":0,"ts":"2026-01-01T00:00:00Z"}"#;
    let b = r#"{"type":"status","serverRunning":false,"playerCount":0,"ts":"2026-01-01T00:00:05Z"}"#;
    assert!(same_ignoring_ts(a, b));

    let mudou = r#"{"type":"status","serverRunning":true,"playerCount":0,"ts":"2026-01-01T00:00:05Z"}"#;
    assert!(!same_ignoring_ts(a, mudou));

    // Sem JSON válido nunca é "igual": na dúvida, envia.
    assert!(!same_ignoring_ts("lixo", "lixo"));
}
