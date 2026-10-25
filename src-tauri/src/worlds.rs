//! Mundos do servidor: listar, trocar o mundo ativo e importar um mundo de um `.zip`.
//!
//! O mundo ativo de um servidor é só o `level-name` do `server.properties`. Trocar de mundo, portanto, nunca
//! apaga nada: as pastas dos outros mundos continuam onde estão e podem ser reativadas. Importar um mundo
//! extrai o zip para uma pasta NOVA (nunca por cima de um mundo existente), com as mesmas defesas da
//! importação de pacotes: caminhos "enclosed" (zip-slip), links simbólicos ignorados, limites de tamanho e
//! de quantidade de arquivos, e extração numa pasta temporária que só vira o mundo no fim.

use super::*;

use std::io::Read;

/// Limites de uma importação (um mundo grande de servidor passa de 5 GB; o teto protege de zip bomb).
const MAX_WORLD_ENTRIES: usize = 2_000_000;
const MAX_WORLD_UNPACKED_BYTES: u64 = 40 * 1024 * 1024 * 1024;
/// Quão fundo (em pastas) o level.dat pode estar dentro do zip (ex.: `saves/Meu Mundo/level.dat`).
const MAX_LEVEL_DAT_DEPTH: usize = 4;
const MAX_WORLD_NAME_LEN: usize = 64;

/// Nomes que NÃO podem ser nome de mundo: são pastas do próprio servidor.
const RESERVED_WORLD_NAMES: &[&str] = &[
    "mods", "plugins", "config", "logs", "libraries", "versions", "cache", "crash-reports", "defaultconfigs", "kubejs",
    "resourcepacks", "datapacks", "world_backups", "backups", "bluemap", "dynmap", "serverconfig", "scripts", "global_packs",
];

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorldInfo {
    /// Nome da pasta (o que vai no `level-name`).
    pub folder: String,
    /// Nome interno guardado no level.dat (pode diferir do da pasta).
    pub level_name: Option<String>,
    /// Versão do Minecraft em que o mundo foi salvo pela última vez ("1.20.4"), se o level.dat diz.
    pub mc_version: Option<String>,
    pub last_played_ms: Option<i64>,
    pub is_active: bool,
}

#[derive(Default, Debug, PartialEq)]
struct LevelDat {
    level_name: Option<String>,
    mc_version: Option<String>,
    last_played_ms: Option<i64>,
}

/// Lê o essencial de um `level.dat` (NBT comprimido com gzip). `None` se não for um level.dat legível.
fn parse_level_dat<R: Read>(mut reader: R) -> Option<LevelDat> {
    let blob = nbt::Blob::from_gzip_reader(&mut reader).ok()?;
    let nbt::Value::Compound(data) = blob.get("Data")? else { return None };
    let text = |v: Option<&nbt::Value>| match v {
        Some(nbt::Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    };
    let mc_version = match data.get("Version") {
        Some(nbt::Value::Compound(v)) => text(v.get("Name")),
        _ => None,
    };
    let last_played_ms = match data.get("LastPlayed") {
        Some(nbt::Value::Long(l)) => Some(*l),
        _ => None,
    };
    Some(LevelDat { level_name: text(data.get("LevelName")), mc_version, last_played_ms })
}

fn read_level_dat_file(path: &std::path::Path) -> Option<LevelDat> {
    parse_level_dat(File::open(path).ok()?)
}

fn checked_server_dir(server_dir: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(server_dir);
    if !is_plain_absolute_path(&p) || !p.is_dir() {
        return Err(tr!("upgrade.err.invalidDir"));
    }
    Ok(p)
}

/// Nome de pasta aceito para um mundo (e para o `level-name`).
pub fn is_valid_world_name(name: &str) -> bool {
    if !is_safe_relative_component(name) || name.len() > MAX_WORLD_NAME_LEN || name.starts_with('.') {
        return false;
    }
    if name.ends_with(' ') || name.ends_with('.') || name.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\')) {
        return false;
    }
    let lower = name.to_lowercase();
    let stem = lower.split('.').next().unwrap_or("");
    let windows_reserved = matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && stem.as_bytes()[3].is_ascii_digit());
    !windows_reserved && !RESERVED_WORLD_NAMES.contains(&lower.as_str())
}

/// Mundos da pasta do servidor (pastas com `level.dat`), o ativo primeiro e depois os mais jogados.
#[tauri::command]
pub async fn list_worlds(server_dir: String) -> Result<Vec<WorldInfo>, String> {
    let dir = checked_server_dir(&server_dir)?;
    tauri::async_runtime::spawn_blocking(move || {
        let active = read_level_name(&server_dir);
        let mut worlds = Vec::new();
        let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(worlds) };
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if !path.is_dir() || name.starts_with('.') {
                continue;
            }
            let level = path.join("level.dat");
            if !level.is_file() {
                continue;
            }
            let info = read_level_dat_file(&level).unwrap_or_default();
            worlds.push(WorldInfo {
                is_active: name.eq_ignore_ascii_case(&active),
                folder: name,
                level_name: info.level_name,
                mc_version: info.mc_version,
                last_played_ms: info.last_played_ms,
            });
        }
        worlds.sort_by(|a, b| {
            b.is_active.cmp(&a.is_active).then(b.last_played_ms.cmp(&a.last_played_ms)).then(a.folder.to_lowercase().cmp(&b.folder.to_lowercase()))
        });
        Ok(worlds)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Passa a usar `folder` como mundo do servidor (muda só o `level-name`; nada é apagado). Servidor parado.
#[tauri::command]
pub async fn set_active_world(state: tauri::State<'_, AppState>, server_dir: String, folder: String) -> Result<(), String> {
    ensure_mc_server_stopped(&state)?;
    set_level_name(&state, &server_dir, &folder, true).await
}

/// Prepara um mundo NOVO: o Minecraft o cria (com a `seed` dada, ou aleatória se vazia) na próxima vez que o
/// servidor iniciar. O mundo anterior continua na pasta. Servidor parado.
#[tauri::command]
pub async fn create_new_world(state: tauri::State<'_, AppState>, server_dir: String, name: String, seed: Option<String>) -> Result<(), String> {
    ensure_mc_server_stopped(&state)?;
    let dir = checked_server_dir(&server_dir)?;
    if !is_valid_world_name(&name) {
        return Err(tr!("world.err.invalidName"));
    }
    if ["", "_nether", "_the_end"].iter().any(|s| dir.join(format!("{}{}", name, s)).exists()) {
        return Err(tr!("world.err.nameExists", name = name));
    }
    let seed = seed.unwrap_or_default().trim().to_string();
    if seed.chars().count() > 64 || seed.chars().any(|c| c.is_control()) {
        return Err(tr!("world.err.invalidSeed"));
    }
    // A seed vai antes: se o level-name falhar depois, o mundo atual continua com a seed que já tinha de qualquer jeito
    // (a seed só vale para um mundo ainda inexistente).
    write_properties_in(&state, &server_dir, "level-seed", &seed)?;
    write_properties_in(&state, &server_dir, "level-name", &name)
}

/// Aponta o `level-name` para `folder`. Com `must_exist`, só aceita uma pasta que já seja um mundo.
pub(crate) async fn set_level_name(state: &AppState, server_dir: &str, folder: &str, must_exist: bool) -> Result<(), String> {
    let dir = checked_server_dir(server_dir)?;
    if !is_valid_world_name(folder) {
        return Err(tr!("world.err.invalidName"));
    }
    if must_exist && !dir.join(folder).join("level.dat").is_file() {
        return Err(tr!("world.err.notAWorld", name = folder));
    }
    write_properties_in(state, server_dir, "level-name", folder)
}

/// Grava uma propriedade no server.properties (mesmo formato/atomicidade de `write_server_properties`).
fn write_properties_in(state: &AppState, server_dir: &str, key: &str, value: &str) -> Result<(), String> {
    ensure_mc_server_stopped(state)?;
    if !is_valid_property_key(key) || value.chars().any(|c| c == '\n' || c == '\r' || c == '\0') {
        return Err(tr!("props.invalidEntry", key = key));
    }
    let path = format!("{}/server.properties", server_dir);
    let mut lines: Vec<String> = std::fs::read_to_string(&path).map(|c| c.lines().map(|s| s.to_string()).collect()).unwrap_or_default();
    let prefix = format!("{}=", key);
    match lines.iter_mut().find(|l| l.starts_with(&prefix)) {
        Some(line) => *line = format!("{}={}", key, value),
        None => lines.push(format!("{}={}", key, value)),
    }
    atomic_write(std::path::Path::new(&path), lines.join("\n").as_bytes())
}

// ------------------------------------------------------------
// Datapacks do mundo ativo
// ------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DatapackInfo {
    pub file_name: String,
    pub display_name: String,
    pub size_bytes: u64,
    pub enabled: bool,
    /// Datapack já extraído numa pasta (não dá para desativar renomeando: o Minecraft carrega a pasta de qualquer jeito).
    pub is_dir: bool,
}

/// `<servidor>/<level-name>/datapacks`
fn datapacks_dir(server_dir: &str) -> PathBuf {
    PathBuf::from(server_dir).join(read_level_name(server_dir)).join("datapacks")
}

#[tauri::command]
pub async fn list_datapacks(server_dir: String) -> Result<Vec<DatapackInfo>, String> {
    checked_server_dir(&server_dir)?;
    let dir = datapacks_dir(&server_dir);
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(out) };
    for entry in rd.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }
        let lower = file_name.to_lowercase();
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map_or(false, |m| m.is_dir());
        let (enabled, display) = if is_dir {
            (true, file_name.clone())
        } else if lower.ends_with(".zip") {
            (true, file_name[..file_name.len() - 4].to_string())
        } else if lower.ends_with(".zip.disabled") {
            (false, file_name[..file_name.len() - 13].to_string())
        } else {
            continue;
        };
        out.push(DatapackInfo { file_name, display_name: display, size_bytes: if is_dir { 0 } else { meta.map_or(0, |m| m.len()) }, enabled, is_dir });
    }
    out.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(out)
}

fn datapack_path(server_dir: &str, file_name: &str) -> Result<PathBuf, String> {
    if !is_safe_relative_component(file_name) {
        return Err(tr!("err.modNotFound", file = file_name));
    }
    let p = datapacks_dir(server_dir).join(file_name);
    if !p.exists() {
        return Err(tr!("err.modNotFound", file = file_name));
    }
    Ok(p)
}

/// Liga/desliga um datapack `.zip` (renomeia entre `.zip` e `.zip.disabled`). Servidor parado.
#[tauri::command]
pub async fn toggle_datapack(state: tauri::State<'_, AppState>, server_dir: String, file_name: String) -> Result<(), String> {
    ensure_mc_server_stopped(&state)?;
    checked_server_dir(&server_dir)?;
    let from = datapack_path(&server_dir, &file_name)?;
    if from.is_dir() {
        return Err(tr!("world.err.datapackDir"));
    }
    let lower = file_name.to_lowercase();
    let to_name = if lower.ends_with(".zip.disabled") {
        file_name[..file_name.len() - 9].to_string()
    } else if lower.ends_with(".zip") {
        format!("{}.disabled", file_name)
    } else {
        return Err(tr!("err.modNotFound", file = file_name));
    };
    let to = from.with_file_name(to_name);
    if to.exists() {
        return Err(tr!("world.err.datapackExists"));
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_datapack(state: tauri::State<'_, AppState>, server_dir: String, file_name: String) -> Result<(), String> {
    ensure_mc_server_stopped(&state)?;
    checked_server_dir(&server_dir)?;
    let p = datapack_path(&server_dir, &file_name)?;
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&p).map_err(|e| e.to_string())
    }
}

// ------------------------------------------------------------
// Importar um mundo de um .zip
// ------------------------------------------------------------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorldZipInfo {
    /// Nome sugerido para a pasta (a do mundo dentro do zip, ou o nome do arquivo).
    pub suggested_name: String,
    pub level_name: Option<String>,
    pub mc_version: Option<String>,
    /// Pastas das outras dimensões (`<mundo>_nether`, `<mundo>_the_end`) que acompanham o mundo.
    pub has_nether_folder: bool,
    pub has_end_folder: bool,
    pub file_count: u64,
    pub unpacked_bytes: u64,
}

/// Onde está o mundo dentro do zip.
#[derive(Debug, Clone, PartialEq)]
struct ZipWorldLayout {
    /// Pastas até a do mundo (vazio = o level.dat está na raiz do zip).
    root: Vec<String>,
    /// Índice do level.dat no zip (ler por índice: zips feitos no Windows trazem "\\" nos nomes e `by_name` não os acha).
    level_index: usize,
    /// Há `<mundo>_nether` / `<mundo>_the_end` ao lado do mundo (Paper/Spigot).
    nether: bool,
    end: bool,
}

fn zip_entry_parts(entry_path: &std::path::Path) -> Option<Vec<String>> {
    let mut parts = Vec::new();
    for c in entry_path.components() {
        match c {
            std::path::Component::Normal(n) => parts.push(n.to_string_lossy().to_string()),
            _ => return None,
        }
    }
    // Lixo que sistemas operacionais acrescentam ao compactar.
    if parts.iter().any(|p| p == "__MACOSX" || p.starts_with("._") || p == ".DS_Store" || p.eq_ignore_ascii_case("thumbs.db")) {
        return None;
    }
    Some(parts)
}

/// Acha o level.dat mais raso do zip. Erros: "NO_LEVEL_DAT", "MULTIPLE_WORLDS".
fn find_world_layout<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>) -> Result<ZipWorldLayout, String> {
    let mut candidates: Vec<(Vec<String>, usize)> = Vec::new();
    let mut all: Vec<Vec<String>> = Vec::new();
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index_raw(i) else { continue };
        let Some(path) = entry.enclosed_name() else { continue };
        let Some(parts) = zip_entry_parts(&path) else { continue };
        if !entry.is_dir() && parts.last().map_or(false, |n| n == "level.dat") && parts.len() <= MAX_LEVEL_DAT_DEPTH {
            candidates.push((parts[..parts.len() - 1].to_vec(), i));
        }
        all.push(parts);
    }
    let Some(shallowest) = candidates.iter().map(|c| c.0.len()).min() else { return Err("NO_LEVEL_DAT".into()) };
    let best: Vec<&(Vec<String>, usize)> = candidates.iter().filter(|c| c.0.len() == shallowest).collect();
    if best.len() > 1 {
        return Err("MULTIPLE_WORLDS".into());
    }
    let (root, level_index) = (best[0].0.clone(), best[0].1);
    let (mut nether, mut end) = (false, false);
    if let Some((base, parent)) = root.split_last().map(|(b, p)| (b.clone(), p.to_vec())) {
        let has_dir = |suffix: &str| {
            all.iter().any(|p| p.len() > parent.len() && p[..parent.len()] == parent[..] && p[parent.len()] == format!("{}{}", base, suffix))
        };
        nether = has_dir("_nether");
        end = has_dir("_the_end");
    }
    Ok(ZipWorldLayout { root, level_index, nether, end })
}

fn checked_zip_path(zip_path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(zip_path);
    let is_zip = p.extension().map_or(false, |e| e.eq_ignore_ascii_case("zip"));
    if !is_zip || !is_plain_absolute_path(&p) || !p.is_file() {
        return Err(tr!("world.err.badZip"));
    }
    Ok(p)
}

fn zip_error(code: &str) -> String {
    match code {
        "NO_LEVEL_DAT" => tr!("world.err.noLevelDat"),
        "MULTIPLE_WORLDS" => tr!("world.err.multipleWorlds"),
        _ => tr!("world.err.badZip"),
    }
}

/// Examina o zip SEM extrair: onde está o mundo, nome, versão, tamanho.
#[tauri::command]
pub async fn inspect_world_zip(zip_path: String) -> Result<WorldZipInfo, String> {
    let path = checked_zip_path(&zip_path)?;
    tauri::async_runtime::spawn_blocking(move || inspect_zip(&path)).await.map_err(|e| e.to_string())?
}

fn inspect_zip(path: &std::path::Path) -> Result<WorldZipInfo, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| tr!("world.err.badZip"))?;
    if archive.len() > MAX_WORLD_ENTRIES {
        return Err(tr!("world.err.tooBig"));
    }
    let layout = find_world_layout(&mut archive).map_err(|c| zip_error(&c))?;

    let level = match archive.by_index(layout.level_index) {
        Ok(e) if e.size() <= 64 * 1024 * 1024 => parse_level_dat(e),
        _ => None,
    }
    .unwrap_or_default();

    let (mut files, mut bytes) = (0u64, 0u64);
    for i in 0..archive.len() {
        let Ok(e) = archive.by_index_raw(i) else { continue };
        if e.is_dir() {
            continue;
        }
        let Some(parts) = e.enclosed_name().and_then(|p| zip_entry_parts(&p)) else { continue };
        if mapped_target(&parts, &layout, "x").is_some() {
            files += 1;
            bytes = bytes.saturating_add(e.size());
        }
    }
    if bytes > MAX_WORLD_UNPACKED_BYTES {
        return Err(tr!("world.err.tooBig"));
    }
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    Ok(WorldZipInfo {
        suggested_name: suggest_name(layout.root.last().map(|s| s.as_str()).unwrap_or(&stem), &level.level_name),
        level_name: level.level_name,
        mc_version: level.mc_version,
        has_nether_folder: layout.nether,
        has_end_folder: layout.end,
        file_count: files,
        unpacked_bytes: bytes,
    })
}

/// Um nome de pasta válido a partir do que o zip traz.
fn suggest_name(raw: &str, level_name: &Option<String>) -> String {
    let source = if is_valid_world_name(raw) { raw.to_string() } else { level_name.clone().unwrap_or_else(|| raw.to_string()) };
    let cleaned: String = source
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\') { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim_end_matches(['.', ' ']).chars().take(MAX_WORLD_NAME_LEN).collect::<String>();
    if is_valid_world_name(&cleaned) { cleaned } else { "mundo-importado".to_string() }
}

/// Para onde vai uma entrada do zip dentro da pasta temporária (`None` = não faz parte do mundo).
/// `name` é o nome final do mundo; as pastas de dimensão viram `<name>_nether` / `<name>_the_end`.
fn mapped_target(parts: &[String], layout: &ZipWorldLayout, name: &str) -> Option<PathBuf> {
    let last = parts.last()?;
    if last == "session.lock" || last.to_lowercase().ends_with(".tmp") {
        return None;
    }
    let r = &layout.root;
    if parts.len() > r.len() && parts[..r.len()] == r[..] {
        let mut out = PathBuf::from(name);
        out.extend(&parts[r.len()..]);
        return Some(out);
    }
    if let Some((base, parent)) = r.split_last() {
        if parts.len() > parent.len() && parts[..parent.len()] == parent[..] {
            let top = &parts[parent.len()];
            for (flag, suffix) in [(layout.nether, "_nether"), (layout.end, "_the_end")] {
                if flag && *top == format!("{}{}", base, suffix) && parts.len() > parent.len() + 1 {
                    let mut out = PathBuf::from(format!("{}{}", name, suffix));
                    out.extend(&parts[parent.len() + 1..]);
                    return Some(out);
                }
            }
        }
    }
    None
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorldImportResult {
    pub folder: String,
    pub mc_version: Option<String>,
}

/// Extrai o mundo do zip para uma pasta nova `name` dentro do servidor. Nunca sobrescreve nada existente.
#[tauri::command]
pub async fn import_world_zip(server_dir: String, zip_path: String, name: String) -> Result<WorldImportResult, String> {
    let dir = checked_server_dir(&server_dir)?;
    let zip = checked_zip_path(&zip_path)?;
    if !is_valid_world_name(&name) {
        return Err(tr!("world.err.invalidName"));
    }
    tauri::async_runtime::spawn_blocking(move || extract_world(&dir, &zip, &name)).await.map_err(|e| e.to_string())?
}

fn extract_world(server_dir: &std::path::Path, zip_path: &std::path::Path, name: &str) -> Result<WorldImportResult, String> {
    let final_dirs = |suffix: &str| server_dir.join(format!("{}{}", name, suffix));
    for suffix in ["", "_nether", "_the_end"] {
        if final_dirs(suffix).exists() {
            return Err(tr!("world.err.nameExists", name = name));
        }
    }
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| tr!("world.err.badZip"))?;
    if archive.len() > MAX_WORLD_ENTRIES {
        return Err(tr!("world.err.tooBig"));
    }
    let layout = find_world_layout(&mut archive).map_err(|c| zip_error(&c))?;

    let temp = server_dir.join(format!(".cubicase-world-import-{}", chrono::Utc::now().timestamp_millis()));
    std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    let cleanup = |temp: &std::path::Path| {
        let _ = std::fs::remove_dir_all(temp);
    };

    let mut run = || -> Result<(), String> {
        let mut total: u64 = 0;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let Some(parts) = entry.enclosed_name().and_then(|p| zip_entry_parts(&p)) else { continue };
            let Some(target) = mapped_target(&parts, &layout, name) else { continue };
            let out = temp.join(&target);
            if entry.is_dir() {
                std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                continue;
            }
            // Link simbólico dentro do zip: ignorado (poderia apontar para fora da pasta).
            if entry.unix_mode().map_or(false, |m| m & 0o170000 == 0o120000) {
                continue;
            }
            total = total.saturating_add(entry.size());
            if total > MAX_WORLD_UNPACKED_BYTES {
                return Err(tr!("world.err.tooBig"));
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut f = File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
        // O mundo extraído precisa ter o level.dat.
        if !temp.join(name).join("level.dat").is_file() {
            return Err(tr!("world.err.noLevelDat"));
        }
        // Só agora as pastas ganham o nome final (rename dentro do mesmo disco: instantâneo).
        let mut moved: Vec<PathBuf> = Vec::new();
        for suffix in ["", "_nether", "_the_end"] {
            let from = temp.join(format!("{}{}", name, suffix));
            if from.is_dir() {
                if let Err(e) = std::fs::rename(&from, final_dirs(suffix)) {
                    for m in &moved {
                        let _ = std::fs::remove_dir_all(m);
                    }
                    return Err(e.to_string());
                }
                moved.push(final_dirs(suffix));
            }
        }
        Ok(())
    };
    let result = run();
    cleanup(&temp);
    result?;
    let info = read_level_dat_file(&server_dir.join(name).join("level.dat")).unwrap_or_default();
    Ok(WorldImportResult { folder: name.to_string(), mc_version: info.mc_version })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    const LEVEL_1_20_4: &[u8] = include_bytes!("test_fixtures/level_1_20_4.dat");
    const LEVEL_FORGE: &[u8] = include_bytes!("test_fixtures/level_forge_1_20_4.dat");

    fn make_zip(path: &std::path::Path, entries: &[(&str, &[u8])]) {
        let mut z = zip::ZipWriter::new(File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            if name.ends_with('/') {
                z.add_directory(*name, opts).unwrap();
            } else {
                z.start_file(*name, opts).unwrap();
                z.write_all(body).unwrap();
            }
        }
        z.finish().unwrap();
    }

    #[test]
    fn le_level_dat_real_do_vanilla_e_de_forge() {
        let v = parse_level_dat(LEVEL_1_20_4).expect("level.dat do vanilla/fabric");
        assert_eq!(v.mc_version.as_deref(), Some("1.20.4"));
        assert!(v.level_name.is_some() && v.last_played_ms.is_some(), "{v:?}");
        let f = parse_level_dat(LEVEL_FORGE).expect("level.dat de um mundo Forge (NBT grande, com registros do FML)");
        assert_eq!(f.mc_version.as_deref(), Some("1.20.4"));
        assert!(parse_level_dat(&b"isto nao e nbt"[..]).is_none());
        assert!(parse_level_dat(&[][..]).is_none());
    }

    #[test]
    fn nomes_de_mundo_validos_e_invalidos() {
        for ok in ["world", "Meu Mundo", "mundo-2", "Survival_1.20", "Água"] {
            assert!(is_valid_world_name(ok), "{ok}");
        }
        for bad in ["", ".", "..", ".oculto", "a/b", "a\\b", "C:", "CON", "nul.txt", "COM1", "lpt9", "mods", "Plugins", "logs", "fim.", "fim ", "a?b", &"x".repeat(65)] {
            assert!(!is_valid_world_name(bad), "{bad}");
        }
    }

    #[test]
    fn zip_com_a_pasta_do_mundo_na_raiz() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("Aventura.zip");
        make_zip(&z, &[("Aventura/level.dat", LEVEL_1_20_4), ("Aventura/region/r.0.0.mca", b"x"), ("Aventura/session.lock", b"x")]);
        let info = inspect_zip(&z).unwrap();
        assert_eq!(info.suggested_name, "Aventura");
        assert_eq!(info.mc_version.as_deref(), Some("1.20.4"));
        assert_eq!(info.file_count, 2, "session.lock não conta");
    }

    #[test]
    fn zip_feito_no_windows_com_barra_invertida_nos_nomes_tambem_e_lido() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("win.zip");
        make_zip(&z, &[("world\\level.dat", LEVEL_1_20_4), ("world\\region\\r.0.0.mca", b"x")]);
        let info = inspect_zip(&z).unwrap();
        assert_eq!(info.mc_version.as_deref(), Some("1.20.4"), "a versão precisa aparecer para o aviso de mundo mais novo");
        assert_eq!(info.suggested_name, "world");
        let server = t.path().join("srv");
        std::fs::create_dir_all(&server).unwrap();
        assert!(extract_world(&server, &z, "W").is_ok());
        assert!(server.join("W/region/r.0.0.mca").is_file());
    }

    #[test]
    fn zip_com_level_dat_na_raiz_usa_o_nome_do_arquivo() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("mapa-do-amigo.zip");
        make_zip(&z, &[("level.dat", LEVEL_1_20_4), ("region/r.0.0.mca", b"x")]);
        assert_eq!(inspect_zip(&z).unwrap().suggested_name, "mapa-do-amigo");
    }

    #[test]
    fn zip_de_saves_do_cliente_e_lixo_do_macos() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[
            ("__MACOSX/saves/Meu Mundo/._level.dat", b"lixo"),
            ("saves/Meu Mundo/level.dat", LEVEL_1_20_4),
            ("saves/Meu Mundo/region/r.0.0.mca", b"x"),
            ("leia-me.txt", b"x"),
        ]);
        let info = inspect_zip(&z).unwrap();
        assert_eq!(info.suggested_name, "Meu Mundo");
        assert_eq!(info.file_count, 2, "só o que está dentro do mundo");
    }

    #[test]
    fn zip_sem_level_dat_e_zip_com_dois_mundos_sao_recusados() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[("a/region/r.0.0.mca", b"x"), ("leia-me.txt", b"x")]);
        assert!(inspect_zip(&z).is_err());
        let z2 = t.path().join("b.zip");
        make_zip(&z2, &[("a/level.dat", LEVEL_1_20_4), ("b/level.dat", LEVEL_1_20_4)]);
        assert!(inspect_zip(&z2).is_err());
        let z3 = t.path().join("c.zip");
        std::fs::write(&z3, b"nao e zip").unwrap();
        assert!(inspect_zip(&z3).is_err());
    }

    #[test]
    fn importa_com_nova_nome_e_leva_as_pastas_nether_e_end_do_paper() {
        let t = TempDir::new().unwrap();
        let server = t.path().join("srv");
        std::fs::create_dir_all(&server).unwrap();
        let z = t.path().join("Mundo.zip");
        make_zip(&z, &[
            ("Mundo/level.dat", LEVEL_1_20_4),
            ("Mundo/region/r.0.0.mca", b"overworld"),
            ("Mundo/session.lock", b"trava"),
            ("Mundo_nether/DIM-1/region/r.0.0.mca", b"nether"),
            ("Mundo_the_end/DIM1/region/r.0.0.mca", b"end"),
            ("OutraCoisa/arquivo.txt", b"nao deve vir"),
        ]);
        let info = inspect_zip(&z).unwrap();
        assert!(info.has_nether_folder && info.has_end_folder);

        let res = extract_world(&server, &z, "Novo").unwrap();
        assert_eq!(res.folder, "Novo");
        assert_eq!(res.mc_version.as_deref(), Some("1.20.4"));
        assert_eq!(std::fs::read(server.join("Novo/region/r.0.0.mca")).unwrap(), b"overworld");
        assert_eq!(std::fs::read(server.join("Novo_nether/DIM-1/region/r.0.0.mca")).unwrap(), b"nether");
        assert_eq!(std::fs::read(server.join("Novo_the_end/DIM1/region/r.0.0.mca")).unwrap(), b"end");
        assert!(!server.join("Novo/session.lock").exists());
        assert!(!server.join("OutraCoisa").exists());
        // não deixa pasta temporária para trás
        let leftovers: Vec<_> = std::fs::read_dir(&server).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.starts_with('.')).collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn nunca_sobrescreve_um_mundo_existente() {
        let t = TempDir::new().unwrap();
        let server = t.path().join("srv");
        std::fs::create_dir_all(server.join("world")).unwrap();
        std::fs::write(server.join("world/level.dat"), b"o mundo de verdade").unwrap();
        let z = t.path().join("w.zip");
        make_zip(&z, &[("level.dat", LEVEL_1_20_4)]);
        assert!(extract_world(&server, &z, "world").is_err());
        assert_eq!(std::fs::read(server.join("world/level.dat")).unwrap(), b"o mundo de verdade");
    }

    #[test]
    fn entrada_com_caminho_perigoso_nao_escapa_e_zip_ruim_nao_deixa_lixo() {
        let t = TempDir::new().unwrap();
        let server = t.path().join("srv");
        std::fs::create_dir_all(&server).unwrap();
        let z = t.path().join("w.zip");
        make_zip(&z, &[("m/level.dat", LEVEL_1_20_4), ("m/../../fora.txt", b"escapou"), ("/abs.txt", b"x"), ("m/ok.txt", b"ok")]);
        let _ = extract_world(&server, &z, "m2").unwrap();
        assert!(!t.path().join("fora.txt").exists() && !server.join("fora.txt").exists());
        assert_eq!(std::fs::read(server.join("m2/ok.txt")).unwrap(), b"ok");

        // zip sem level.dat: erro e nenhuma pasta nem temporário
        let bad = t.path().join("bad.zip");
        make_zip(&bad, &[("a.txt", b"x")]);
        assert!(extract_world(&server, &bad, "m3").is_err());
        assert!(!server.join("m3").exists());
        assert!(std::fs::read_dir(&server).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(".cubicase-world-import")));
    }

    #[test]
    fn sugestao_de_nome_sempre_vira_nome_valido() {
        assert_eq!(suggest_name("Meu Mundo", &None), "Meu Mundo");
        assert_eq!(suggest_name("a:b", &None), "a_b");
        assert_eq!(suggest_name("..", &Some("Nome Interno".into())), "Nome Interno");
        assert_eq!(suggest_name("mods", &None), "mundo-importado");
        assert_eq!(suggest_name("CON", &None), "mundo-importado");
    }

    /// Verificação manual com um zip REAL (variáveis de ambiente CUBICASE_WORLD_ZIP, CUBICASE_WORLD_SERVER e
    /// CUBICASE_WORLD_NAME): `cargo test importar_mundo_real -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn importar_mundo_real() {
        let zip = std::env::var("CUBICASE_WORLD_ZIP").unwrap();
        let server = std::env::var("CUBICASE_WORLD_SERVER").unwrap();
        let name = std::env::var("CUBICASE_WORLD_NAME").unwrap_or_else(|_| "Teste".into());
        let info = inspect_zip(std::path::Path::new(&zip)).unwrap();
        println!("INSPECT {info:?}");
        let res = extract_world(std::path::Path::new(&server), std::path::Path::new(&zip), &name).unwrap();
        println!("IMPORT {res:?}");
    }
}
