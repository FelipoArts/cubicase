//! Atualização de versão de um servidor (Minecraft ou loader), com segurança.
//!
//! O frontend (src/lib/serverUpgrade.ts) escolhe a versão, confere os mods e BAIXA tudo o que é novo para uma
//! pasta de preparo (`<servidor>/.cubicase-upgrade/`) — nada do servidor é tocado nessa fase. Este módulo cuida
//! do que precisa ser confiável:
//!
//! - **trava**: enquanto a atualização roda, o servidor não pode ser iniciado (e ela só começa com ele parado);
//! - **backup completo opcional** do servidor (mundo, mods, configurações) antes de qualquer mudança;
//! - **commit com desfazer automático**: a troca de arquivos é uma sequência de *renomeações* registradas num
//!   diário; se qualquer passo falha, o diário é desfeito de trás para frente e o servidor volta exatamente
//!   como estava. O `cubicase-meta.json` (que diz qual versão/jar o servidor usa) é o ÚLTIMO passo.

use super::*;

use std::collections::HashMap;
use std::sync::OnceLock;

/// Pasta de preparo dentro do servidor (apagada ao terminar, com sucesso ou não).
pub const STAGING_DIR: &str = ".cubicase-upgrade";
const TRASH_SUBDIR: &str = "trash";
/// Começo da mensagem de erro quando o desfazer automático NÃO conseguiu voltar tudo (ver apply_commit).
pub const ROLLBACK_FAILED_MARK: &str = "[ROLLBACK_FAILED] ";

/// Uma atualização esquecida (app fechado no meio, tela recarregada) não pode travar o servidor para sempre.
const LOCK_TTL: Duration = Duration::from_secs(30 * 60);

fn locks() -> &'static Mutex<HashMap<String, Instant>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_key(server_dir: &str) -> String {
    server_dir.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// `true` enquanto uma atualização desta pasta está em andamento — consultado por `start_minecraft_server`.
pub fn upgrade_in_progress_for(server_dir: &str) -> bool {
    let key = lock_key(server_dir);
    locks()
        .lock()
        .map(|g| g.get(&key).map_or(false, |since| since.elapsed() < LOCK_TTL))
        .unwrap_or(false)
}

/// Pasta de servidor aceita pelos comandos deste módulo: absoluta, sem "..", existente.
fn checked_server_dir(server_dir: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(server_dir);
    if !is_plain_absolute_path(&p) || !p.is_dir() {
        return Err(tr!("upgrade.err.invalidDir"));
    }
    Ok(p)
}

/// Começa uma atualização: só com o servidor parado, sem exportação em andamento e sem outra atualização.
#[tauri::command]
pub async fn begin_server_upgrade(state: tauri::State<'_, AppState>, server_dir: String) -> Result<(), String> {
    let dir = checked_server_dir(&server_dir)?;
    ensure_mc_server_stopped(&state)?;
    if pack::export_in_progress_for(&server_dir) {
        return Err(tr!("upgrade.err.busy"));
    }
    let key = lock_key(&server_dir);
    let mut guard = locks().lock().map_err(|_| tr!("upgrade.err.busy"))?;
    if guard.get(&key).map_or(false, |since| since.elapsed() < LOCK_TTL) {
        return Err(tr!("upgrade.err.busy"));
    }
    guard.insert(key, Instant::now());
    drop(guard);
    // Restos de uma tentativa anterior que morreu no meio.
    let _ = std::fs::remove_dir_all(dir.join(STAGING_DIR));
    Ok(())
}

/// Termina a atualização (sucesso ou falha): solta a trava e apaga a pasta de preparo e a lixeira.
#[tauri::command]
pub async fn end_server_upgrade(server_dir: String) -> Result<(), String> {
    let dir = checked_server_dir(&server_dir)?;
    let _ = std::fs::remove_dir_all(dir.join(STAGING_DIR));
    locks().lock().map_err(|_| "lock".to_string())?.remove(&lock_key(&server_dir));
    Ok(())
}

// ------------------------------------------------------------
// Backup completo do servidor
// ------------------------------------------------------------

/// Fica de fora do backup completo: o que o servidor/instalador recria sozinho ou só ocupa espaço (logs,
/// bibliotecas do Forge, jars extraídos, caches) e as pastas temporárias do próprio Cubicase.
fn full_backup_skips(rel: &str) -> bool {
    let top = rel.split('/').next().unwrap_or("");
    const SKIP_TOP: &[&str] = &["logs", "crash-reports", "cache", "libraries", "versions", ".fabric", ".fabric-installer", ".git", STAGING_DIR];
    SKIP_TOP.iter().any(|d| top.eq_ignore_ascii_case(d)) || top.starts_with(".restore_staging_") || is_backup_excluded_file(rel)
}

/// Itens do backup completo: (caminho relativo com "/", é pasta, tamanho).
fn full_backup_entries(server_dir: &std::path::Path) -> Vec<(String, bool, u64)> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(server_dir).into_iter().filter_map(|e| e.ok()) {
        let Ok(rel) = entry.path().strip_prefix(server_dir) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if rel.is_empty() || full_backup_skips(&rel) {
            continue;
        }
        let is_dir = entry.file_type().is_dir();
        let size = if is_dir { 0 } else { entry.metadata().map(|m| m.len()).unwrap_or(0) };
        out.push((rel, is_dir, size));
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEstimate {
    /// Tamanho (sem compressão) do que entraria no backup completo.
    pub bytes: u64,
    /// Espaço livre no disco onde os backups ficam, se deu para descobrir.
    pub free_bytes: Option<u64>,
}

/// Espaço livre do disco que contém `path` (o ponto de montagem mais específico).
fn free_space_for(path: &std::path::Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let target = path.to_string_lossy().replace('/', "\\").to_lowercase();
    disks
        .iter()
        .filter(|d| {
            let mp = d.mount_point().to_string_lossy().replace('/', "\\").to_lowercase();
            target.starts_with(&mp)
        })
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

#[tauri::command]
pub async fn estimate_server_backup(server_dir: String, backups_dir: String) -> Result<BackupEstimate, String> {
    let dir = checked_server_dir(&server_dir)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = full_backup_entries(&dir).iter().map(|(_, _, s)| *s).sum();
        // O destino pode ainda não existir: sobe até uma pasta existente para achar o disco.
        let mut probe = PathBuf::from(&backups_dir);
        while !probe.exists() && probe.pop() {}
        Ok(BackupEstimate { bytes, free_bytes: free_space_for(&probe) })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Backup COMPLETO do servidor (mundo, mods/plugins, configurações, listas de jogadores, jars na raiz) num zip
/// em `backups_dir` com o nome começando por ANTES-DE-ATUALIZAR_ (BEFORE-UPGRADE_ em inglês).
#[tauri::command]
pub async fn backup_server_full(server_dir: String, backups_dir: String) -> Result<BackupInfo, String> {
    let dir = checked_server_dir(&server_dir)?;
    if !is_plain_absolute_path(std::path::Path::new(&backups_dir)) {
        return Err(tr!("upgrade.err.backupFailed", error = "backups_dir"));
    }
    let prefix = tr!("backup.preUpgradePrefix");
    tauri::async_runtime::spawn_blocking(move || create_full_backup(&dir, std::path::Path::new(&backups_dir), &prefix))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| tr!("upgrade.err.backupFailed", error = e))
}

pub(crate) fn create_full_backup(server_dir: &std::path::Path, backups_dir: &std::path::Path, prefix: &str) -> Result<BackupInfo, String> {
    std::fs::create_dir_all(backups_dir).map_err(|e| e.to_string())?;
    let name = server_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "servidor".into());
    let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let file_name = format!("{}{}_{}.zip", prefix, name, timestamp);
    let zip_path = backups_dir.join(&file_name);
    let tmp_path = backups_dir.join(format!("{}.tmp", file_name));
    // Restos de uma tentativa interrompida.
    if let Ok(entries) = std::fs::read_dir(backups_dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(".zip.tmp") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    let build = || -> Result<(), String> {
        let file = File::create(&tmp_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
        for (rel, is_dir, _) in full_backup_entries(server_dir) {
            if is_dir {
                zip.add_directory(rel, options).map_err(|e| e.to_string())?;
            } else {
                zip.start_file(rel.clone(), options).map_err(|e| e.to_string())?;
                let mut f = File::open(server_dir.join(&rel)).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
            }
        }
        zip.finish().map_err(|e| e.to_string())?;
        // Releitura: o diretório central precisa abrir e cada entrada ter cabeçalho válido.
        let check = File::open(&tmp_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(check).map_err(|e| e.to_string())?;
        for i in 0..archive.len() {
            archive.by_index(i).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp_path, &zip_path).map_err(|e| e.to_string())
    };
    if let Err(e) = build() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    let size_bytes = std::fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    let kind = backup_kind(&file_name).to_string();
    Ok(BackupInfo { file_name, size_bytes, created_at: chrono::Utc::now().to_rfc3339(), kind })
}

// ------------------------------------------------------------
// Commit (troca de arquivos com desfazer automático)
// ------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoaderSwap {
    /// Nome do jar já baixado em `.cubicase-upgrade/loader/`.
    pub staged_name: String,
    /// Nome que ele terá na raiz do servidor (um jar antigo com esse nome é aposentado).
    pub final_name: String,
    /// Outros jars antigos da raiz a aposentar (ex.: o `paper-1.20.1-196.jar` anterior, de nome diferente).
    #[serde(default)]
    pub retire: Vec<String>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeCommit {
    pub server_dir: String,
    /// Vanilla/Paper/Fabric: o jar novo. Forge/NeoForge: `None` (o instalador já escreveu em `libraries/`).
    pub loader: Option<LoaderSwap>,
    /// "mods" ou "plugins", quando há mexida em mods.
    pub items_folder: Option<String>,
    /// Arquivos baixados em `.cubicase-upgrade/<items_folder>/` que passam a valer.
    #[serde(default)]
    pub mod_installs: Vec<String>,
    /// Arquivos antigos de `<items_folder>/` substituídos por versões novas (vão para a lixeira).
    #[serde(default)]
    pub mod_removals: Vec<String>,
    /// Arquivos de `<items_folder>/` a desativar (viram `.disabled`, dá para reativar).
    #[serde(default)]
    pub mod_disables: Vec<String>,
    /// Campos do `cubicase-meta.json` a atualizar (só os permitidos).
    #[serde(default)]
    pub meta_patch: serde_json::Map<String, serde_json::Value>,
}

const ALLOWED_META_KEYS: &[&str] = &["version", "forgeVersion", "modLoaderVersion", "serverJar", "launchArgsDir"];

fn safe_name(n: &str) -> bool {
    is_safe_relative_component(n) && !n.starts_with('.')
}

fn validate_commit(c: &UpgradeCommit) -> Result<(), String> {
    let bad = || tr!("upgrade.err.invalidPlan");
    if let Some(l) = &c.loader {
        if !safe_name(&l.staged_name) || !safe_name(&l.final_name) || !l.final_name.to_lowercase().ends_with(".jar") {
            return Err(bad());
        }
        if l.retire.iter().any(|n| !safe_name(n) || !n.to_lowercase().ends_with(".jar")) {
            return Err(bad());
        }
    }
    let has_items = !c.mod_installs.is_empty() || !c.mod_removals.is_empty() || !c.mod_disables.is_empty();
    match c.items_folder.as_deref() {
        Some("mods") | Some("plugins") => {}
        None if !has_items => {}
        _ => return Err(bad()),
    }
    if c.mod_installs.iter().chain(&c.mod_removals).chain(&c.mod_disables).any(|n| !safe_name(n)) {
        return Err(bad());
    }
    // Sem nomes repetidos numa mesma lista, e um arquivo a desativar não pode também ser instalado/removido.
    let unique = |v: &Vec<String>| {
        let mut seen = std::collections::HashSet::new();
        v.iter().all(|n| seen.insert(n.to_lowercase()))
    };
    if !unique(&c.mod_installs) || !unique(&c.mod_removals) || !unique(&c.mod_disables) {
        return Err(bad());
    }
    if c.mod_disables.iter().any(|d| c.mod_installs.iter().chain(&c.mod_removals).any(|n| n.eq_ignore_ascii_case(d))) {
        return Err(bad());
    }
    if c.meta_patch.keys().any(|k| !ALLOWED_META_KEYS.contains(&k.as_str())) {
        return Err(bad());
    }
    if c.meta_patch.values().any(|v| !(v.is_string() || v.is_null())) {
        return Err(bad());
    }
    // serverJar/launchArgsDir entram na linha de comando do Java: mesma regra de start_minecraft_server.
    if let Some(serde_json::Value::String(j)) = c.meta_patch.get("serverJar") {
        if !is_safe_relative_component(j) || j.starts_with('-') || j.starts_with('@') {
            return Err(bad());
        }
    }
    if let Some(serde_json::Value::String(d)) = c.meta_patch.get("launchArgsDir") {
        let p = std::path::Path::new(d);
        if d.is_empty() || d.starts_with('-') || d.starts_with('@') || p.is_absolute() || p.components().any(|x| !matches!(x, std::path::Component::Normal(_))) {
            return Err(bad());
        }
    }
    Ok(())
}

/// Diário de renomeações já feitas, para desfazer de trás para frente.
struct Journal {
    done: Vec<(PathBuf, PathBuf)>,
}

impl Journal {
    fn rename(&mut self, from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(from, to).map_err(|e| format!("{} -> {}: {}", from.display(), to.display(), e))?;
        self.done.push((from.to_path_buf(), to.to_path_buf()));
        Ok(())
    }

    /// Desfaz tudo. Devolve os passos que NÃO foi possível desfazer.
    fn rollback(&mut self) -> Vec<String> {
        let mut failed = Vec::new();
        while let Some((from, to)) = self.done.pop() {
            if let Err(e) = std::fs::rename(&to, &from) {
                failed.push(format!("{}: {}", to.display(), e));
            }
        }
        failed
    }
}

/// Aplica a atualização. Tudo ou nada: se algo falhar, o servidor volta ao estado de antes.
#[tauri::command]
pub async fn commit_server_upgrade(state: tauri::State<'_, AppState>, commit: UpgradeCommit) -> Result<(), String> {
    let dir = checked_server_dir(&commit.server_dir)?;
    ensure_mc_server_stopped(&state)?;
    if !upgrade_in_progress_for(&commit.server_dir) {
        return Err(tr!("upgrade.err.notStarted"));
    }
    validate_commit(&commit)?;
    tauri::async_runtime::spawn_blocking(move || apply_commit(&dir, &commit))
        .await
        .map_err(|e| e.to_string())?
}

fn apply_commit(dir: &std::path::Path, c: &UpgradeCommit) -> Result<(), String> {
    let staging = dir.join(STAGING_DIR);
    let trash = staging.join(TRASH_SUBDIR);
    let meta_path = dir.join("cubicase-meta.json");
    let old_meta = std::fs::read(&meta_path).ok();
    let mut journal = Journal { done: Vec::new() };
    let mut meta_written = false;

    let mut run = || -> Result<(), String> {
        // 0. Tudo o que vai entrar precisa estar preparado ANTES de mexer em qualquer coisa.
        if let Some(l) = &c.loader {
            if !staging.join("loader").join(&l.staged_name).is_file() {
                return Err(tr!("upgrade.err.missingStaged", file = l.staged_name));
            }
        }
        let folder = c.items_folder.clone().unwrap_or_default();
        for n in &c.mod_installs {
            if !staging.join(&folder).join(n).is_file() {
                return Err(tr!("upgrade.err.missingStaged", file = n));
            }
        }

        // 1. Loader: o jar antigo de mesmo nome vai para a lixeira, o novo ocupa o lugar.
        if let Some(l) = &c.loader {
            let target = dir.join(&l.final_name);
            if target.exists() {
                journal.rename(&target, &trash.join("loader").join(&l.final_name))?;
            }
            journal.rename(&staging.join("loader").join(&l.staged_name), &target)?;
            for old in &l.retire {
                let src = dir.join(old);
                if !old.eq_ignore_ascii_case(&l.final_name) && src.is_file() {
                    journal.rename(&src, &trash.join("loader").join(old))?;
                }
            }
        }

        // 2. Mods/plugins: substituídos vão para a lixeira, novos entram, incompatíveis são desativados.
        if !folder.is_empty() {
            let items = dir.join(&folder);
            for n in &c.mod_removals {
                let src = items.join(n);
                if src.is_file() {
                    journal.rename(&src, &trash.join(&folder).join(n))?;
                }
            }
            for n in &c.mod_installs {
                let dst = items.join(n);
                if dst.exists() {
                    journal.rename(&dst, &trash.join(&folder).join(format!("{}.replaced", n)))?;
                }
                journal.rename(&staging.join(&folder).join(n), &dst)?;
            }
            for n in &c.mod_disables {
                let src = items.join(n);
                let dst = items.join(format!("{}.disabled", n));
                if src.is_file() && !dst.exists() {
                    journal.rename(&src, &dst)?;
                }
            }
        }

        // 3. Metadados (o que diz qual versão o servidor usa): o ÚLTIMO passo. Escrita atômica.
        if !c.meta_patch.is_empty() {
            let mut meta: serde_json::Value = match &old_meta {
                Some(b) => serde_json::from_slice(b).map_err(|e| tr!("upgrade.err.metaUnreadable", error = e))?,
                // Sem metadados não há como saber/registrar a versão: não cria um arquivo novo pela metade.
                None => return Err(tr!("upgrade.err.metaUnreadable", error = "arquivo ausente")),
            };
            let obj = meta.as_object_mut().ok_or_else(|| tr!("upgrade.err.metaUnreadable", error = "objeto"))?;
            for (k, v) in &c.meta_patch {
                obj.insert(k.clone(), v.clone());
            }
            let out = serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?;
            atomic_write(&meta_path, &out)?;
            meta_written = true;
        }
        Ok(())
    };

    match run() {
        Ok(()) => Ok(()),
        Err(e) => {
            if meta_written {
                match &old_meta {
                    Some(b) => {
                        let _ = atomic_write(&meta_path, b);
                    }
                    None => {
                        let _ = std::fs::remove_file(&meta_path);
                    }
                }
            }
            let stuck = journal.rollback();
            if stuck.is_empty() {
                Err(tr!("upgrade.err.rolledBack", error = e))
            } else {
                // O prefixo deixa a interface distinguir "tudo desfeito" de "desfazer incompleto" sem ler o texto traduzido.
                Err(format!("{}{}", ROLLBACK_FAILED_MARK, tr!("upgrade.err.rollbackFailed", error = e, files = stuck.join("; "))))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(p: &std::path::Path, body: &str) {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, body).unwrap();
    }

    fn read(p: &std::path::Path) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    /// Servidor Fabric de mentira, já com a pasta de preparo cheia do que uma atualização baixaria.
    fn fixture() -> (TempDir, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("srv");
        write(&dir.join("fabric-server-launch.jar"), "launcher-1.20.1");
        write(&dir.join("cubicase-meta.json"), r#"{"version":"1.20.1","serverType":"fabric","modLoaderVersion":"0.15.0","serverJar":"fabric-server-launch.jar","uuid":"u1"}"#);
        write(&dir.join("mods/a-1.20.1.jar"), "a-old");
        write(&dir.join("mods/b-1.20.1.jar"), "b-old");
        write(&dir.join("mods/c-1.20.1.jar"), "c-old");
        write(&dir.join("world/level.dat"), "mundo");
        let st = dir.join(STAGING_DIR);
        write(&st.join("loader/fabric-server-launch.jar"), "launcher-1.20.4");
        write(&st.join("mods/a-1.20.4.jar"), "a-new");
        (tmp, dir)
    }

    fn commit_for(dir: &std::path::Path) -> UpgradeCommit {
        let mut patch = serde_json::Map::new();
        patch.insert("version".into(), "1.20.4".into());
        patch.insert("modLoaderVersion".into(), "0.15.3".into());
        UpgradeCommit {
            server_dir: dir.to_string_lossy().to_string(),
            loader: Some(LoaderSwap { staged_name: "fabric-server-launch.jar".into(), final_name: "fabric-server-launch.jar".into(), retire: vec![] }),
            items_folder: Some("mods".into()),
            mod_installs: vec!["a-1.20.4.jar".into()],
            mod_removals: vec!["a-1.20.1.jar".into()],
            mod_disables: vec!["b-1.20.1.jar".into()],
            meta_patch: patch,
        }
    }

    #[test]
    fn commit_troca_loader_mods_e_metadados() {
        let (_t, dir) = fixture();
        let c = commit_for(&dir);
        validate_commit(&c).unwrap();
        apply_commit(&dir, &c).unwrap();

        assert_eq!(read(&dir.join("fabric-server-launch.jar")), "launcher-1.20.4");
        assert_eq!(read(&dir.join("mods/a-1.20.4.jar")), "a-new");
        assert!(!dir.join("mods/a-1.20.1.jar").exists(), "o antigo saiu");
        assert!(!dir.join("mods/b-1.20.1.jar").exists() && dir.join("mods/b-1.20.1.jar.disabled").is_file(), "incompatível ficou desativado");
        assert_eq!(read(&dir.join("mods/c-1.20.1.jar")), "c-old", "o que não está no plano não é tocado");
        assert_eq!(read(&dir.join("world/level.dat")), "mundo");
        let meta: serde_json::Value = serde_json::from_str(&read(&dir.join("cubicase-meta.json"))).unwrap();
        assert_eq!(meta["version"], "1.20.4");
        assert_eq!(meta["modLoaderVersion"], "0.15.3");
        assert_eq!(meta["uuid"], "u1", "campos fora do patch continuam");
    }

    #[test]
    fn falha_no_meio_desfaz_tudo_e_o_servidor_fica_como_estava() {
        let (_t, dir) = fixture();
        // O arquivo preparado do 2º mod não existe: a checagem inicial já barra, antes de mexer em qualquer coisa.
        let mut c = commit_for(&dir);
        c.mod_installs.push("sumiu-1.20.4.jar".into());
        let err = apply_commit(&dir, &c).unwrap_err();
        assert!(!err.is_empty());
        assert_eq!(read(&dir.join("fabric-server-launch.jar")), "launcher-1.20.1");
        assert_eq!(read(&dir.join("mods/a-1.20.1.jar")), "a-old");
        assert!(dir.join("mods/b-1.20.1.jar").is_file());
        assert!(read(&dir.join("cubicase-meta.json")).contains("1.20.1"));
    }

    #[test]
    fn falha_depois_de_ja_ter_trocado_arquivos_desfaz_o_que_foi_feito() {
        let (_t, dir) = fixture();
        // Um pedaço do plano falha DEPOIS de o loader e os mods terem sido trocados: o metadado vira diretório
        // (não dá para ler como JSON), o que derruba o último passo.
        std::fs::remove_file(dir.join("cubicase-meta.json")).unwrap();
        write(&dir.join("cubicase-meta.json"), "isto não é json");
        let c = commit_for(&dir);
        let err = apply_commit(&dir, &c).unwrap_err();
        assert!(!err.is_empty());
        // tudo voltou
        assert_eq!(read(&dir.join("fabric-server-launch.jar")), "launcher-1.20.1");
        assert_eq!(read(&dir.join("mods/a-1.20.1.jar")), "a-old");
        assert_eq!(read(&dir.join("mods/b-1.20.1.jar")), "b-old");
        assert!(!dir.join("mods/a-1.20.4.jar").exists());
        assert!(!dir.join("mods/b-1.20.1.jar.disabled").exists());
        // e o que foi baixado continua preparado (a limpeza é de end_server_upgrade)
        assert!(dir.join(STAGING_DIR).join("mods/a-1.20.4.jar").is_file());
        assert!(dir.join(STAGING_DIR).join("loader/fabric-server-launch.jar").is_file());
        assert_eq!(read(&dir.join("cubicase-meta.json")), "isto não é json", "metadado intacto");
    }

    #[test]
    fn plano_invalido_e_recusado() {
        let (_t, dir) = fixture();
        let ok = commit_for(&dir);
        assert!(validate_commit(&ok).is_ok());

        let mut c = ok.clone();
        c.mod_installs = vec!["..\\x.jar".into()];
        assert!(validate_commit(&c).is_err());
        let mut c = ok.clone();
        c.items_folder = Some("config".into());
        assert!(validate_commit(&c).is_err(), "só mods/plugins");
        let mut c = ok.clone();
        c.meta_patch.insert("uuid".into(), "outro".into());
        assert!(validate_commit(&c).is_err(), "não deixa trocar o uuid");
        let mut c = ok.clone();
        c.meta_patch.insert("serverJar".into(), "-jar".into());
        assert!(validate_commit(&c).is_err(), "jar não pode parecer opção");
        let mut c = ok.clone();
        c.meta_patch.insert("launchArgsDir".into(), "C:\\x".into());
        assert!(validate_commit(&c).is_err());
        let mut c = ok.clone();
        c.loader = Some(LoaderSwap { staged_name: "a.jar".into(), final_name: "run.bat".into(), retire: vec![] });
        assert!(validate_commit(&c).is_err(), "o loader final é sempre .jar");
        let mut c = ok;
        c.mod_installs = vec![".hidden.jar".into()];
        assert!(validate_commit(&c).is_err());
    }

    #[test]
    fn paper_aposenta_o_jar_antigo_de_outro_nome() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("paper");
        write(&dir.join("paper-1.20.1-196.jar"), "paper antigo");
        write(&dir.join("cubicase-meta.json"), r#"{"version":"1.20.1","serverJar":"paper-1.20.1-196.jar"}"#);
        write(&dir.join(STAGING_DIR).join("loader/paper-1.20.4-499.jar"), "paper novo");
        let mut patch = serde_json::Map::new();
        patch.insert("version".into(), "1.20.4".into());
        patch.insert("serverJar".into(), "paper-1.20.4-499.jar".into());
        let c = UpgradeCommit {
            server_dir: dir.to_string_lossy().to_string(),
            loader: Some(LoaderSwap { staged_name: "paper-1.20.4-499.jar".into(), final_name: "paper-1.20.4-499.jar".into(), retire: vec!["paper-1.20.1-196.jar".into(), "paper-1.20.4-499.jar".into()] }),
            meta_patch: patch,
            ..Default::default()
        };
        validate_commit(&c).unwrap();
        apply_commit(&dir, &c).unwrap();
        assert_eq!(read(&dir.join("paper-1.20.4-499.jar")), "paper novo", "retire não pode levar o jar novo junto");
        assert!(!dir.join("paper-1.20.1-196.jar").exists());
        let mut bad = c.clone();
        bad.loader.as_mut().unwrap().retire = vec!["../x.jar".into(), "..\\x.jar".into()];
        assert!(validate_commit(&bad).is_err());
    }

    #[test]
    fn forge_sem_jar_so_atualiza_o_metadado() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("forge");
        write(&dir.join("cubicase-meta.json"), r#"{"version":"1.20.1","forgeVersion":"47.1.0","launchArgsDir":"libraries/net/minecraftforge/forge/1.20.1-47.1.0"}"#);
        let mut patch = serde_json::Map::new();
        patch.insert("version".into(), "1.20.4".into());
        patch.insert("forgeVersion".into(), "49.0.3".into());
        patch.insert("launchArgsDir".into(), "libraries/net/minecraftforge/forge/1.20.4-49.0.3".into());
        let c = UpgradeCommit { server_dir: dir.to_string_lossy().to_string(), meta_patch: patch, ..Default::default() };
        validate_commit(&c).unwrap();
        apply_commit(&dir, &c).unwrap();
        let meta: serde_json::Value = serde_json::from_str(&read(&dir.join("cubicase-meta.json"))).unwrap();
        assert_eq!(meta["forgeVersion"], "49.0.3");
        assert_eq!(meta["launchArgsDir"], "libraries/net/minecraftforge/forge/1.20.4-49.0.3");
    }

    #[test]
    fn backup_completo_leva_o_essencial_e_deixa_de_fora_o_que_se_recria() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("meu servidor");
        write(&dir.join("world/level.dat"), "mundo");
        write(&dir.join("world/session.lock"), "trava");
        write(&dir.join("mods/a.jar"), "mod");
        write(&dir.join("config/x.toml"), "cfg");
        write(&dir.join("server.properties"), "motd=oi");
        write(&dir.join("whitelist.json"), "[]");
        write(&dir.join("cubicase-meta.json"), "{}");
        write(&dir.join("server.jar"), "jar");
        write(&dir.join("logs/latest.log"), "log");
        write(&dir.join("crash-reports/c.txt"), "crash");
        write(&dir.join("libraries/net/x/y.jar"), "lib");
        write(&dir.join(".cubicase-upgrade/mods/novo.jar"), "novo");
        let backups = tmp.path().join("backups");

        let info = create_full_backup(&dir, &backups, "ANTES-DE-ATUALIZAR_").unwrap();
        assert_eq!(info.kind, "pre_upgrade");
        assert!(info.file_name.starts_with("ANTES-DE-ATUALIZAR_meu servidor_"), "{}", info.file_name);

        let zip = zip::ZipArchive::new(File::open(backups.join(&info.file_name)).unwrap()).unwrap();
        let names: Vec<String> = zip.file_names().filter_map(|n| n.ok()).map(|n| n.to_string()).collect();
        for want in ["world/level.dat", "mods/a.jar", "config/x.toml", "server.properties", "whitelist.json", "cubicase-meta.json", "server.jar"] {
            assert!(names.iter().any(|n| n == want), "faltou {want}: {names:?}");
        }
        for never in ["world/session.lock", "logs/latest.log", "crash-reports/c.txt", "libraries/net/x/y.jar", ".cubicase-upgrade/mods/novo.jar"] {
            assert!(!names.iter().any(|n| n == never), "não deveria ter {never}: {names:?}");
        }
    }

    #[test]
    fn trava_impede_segunda_atualizacao_e_solta_ao_terminar() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("lock-test").to_string_lossy().to_string();
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!upgrade_in_progress_for(&dir));
        locks().lock().unwrap().insert(lock_key(&dir), Instant::now());
        assert!(upgrade_in_progress_for(&dir));
        assert!(upgrade_in_progress_for(&dir.replace('\\', "/").to_uppercase()), "chave não depende de barra nem de maiúsculas");
        let expired = Instant::now().checked_sub(LOCK_TTL + Duration::from_secs(1)).unwrap();
        locks().lock().unwrap().insert(lock_key(&dir), expired);
        assert!(!upgrade_in_progress_for(&dir), "trava esquecida expira");
        locks().lock().unwrap().remove(&lock_key(&dir));
    }
}
