//! Pacotes `.cubicase` — exportar um servidor inteiro (mundo, configurações,
//! mods e, no modo completo, o servidor e o Java) num único arquivo e importá-lo
//! em outro computador.
//!
//! Um `.cubicase` é um zip comum com:
//! - `cubicase-manifest.json` (PRIMEIRA entrada): versão do formato, modo,
//!   metadados do servidor, contagem/tamanho total e a lista do que foi omitido
//!   (modo leve);
//! - a pasta do servidor, na raiz do zip;
//! - `__jre/…`: o Java usado pelo servidor (só no modo completo).
//!
//! Modos: `full` (autossuficiente, funciona sem internet no destino) e `light`
//! (sem o Java e sem os mods que existem no Modrinth — o destino baixa o que
//! faltar; ver `omitted_mods` no manifesto).
//!
//! Princípios (todos cobertos por testes no fim do arquivo):
//! - tudo que dá pra checar é checado ANTES de escrever um byte (servidor ligado,
//!   espaço, caminho longo, destino gravável, nomes inseguros);
//! - a escrita vai para um `.tmp` e só vira `.cubicase` num rename atômico depois
//!   de verificada; qualquer erro/cancelamento apaga o `.tmp`;
//! - o importador trata o arquivo como NÃO confiável: zip-slip, links simbólicos,
//!   nomes reservados do Windows, zip bomb (razão de compressão e tamanho
//!   declarado vs. real), entradas duplicadas e manifesto divergente são
//!   rejeitados; a extração é feita numa pasta temporária e só então renomeada.

use super::*;
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};

pub const PACK_FORMAT_VERSION: u32 = 1;
const PACK_KIND: &str = "cubicase-pack";
const MANIFEST_NAME: &str = "cubicase-manifest.json";
const JRE_PREFIX: &str = "__jre";
const JRE_MARKER: &str = ".cubicase-install-complete";
const STAGING_PREFIX: &str = ".cbi-";

const MAX_ENTRIES: usize = 1_000_000;
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
/// Limite de caracteres do caminho final de qualquer arquivo importado — o
/// MAX_PATH do Windows é 260; sobra folga pro Java/Minecraft criarem arquivos
/// (logs, crash-reports) dentro da pasta.
const MAX_PATH_CHARS: usize = 240;
/// Limite do caminho do `.cubicase.tmp` de destino (mesma razão, sem folga extra).
const MAX_DEST_CHARS: usize = 250;
const SPACE_FIXED_MARGIN: u64 = 64 * 1024 * 1024;
const VERIFY_STEP: usize = 25;
const PROGRESS_EVERY_MS: u128 = 120;
const IN_USE_CHECK_EVERY_MS: u128 = 3000;

// ------------------------------------------------------------
// Tipos
// ------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OmittedMod {
    pub filename: String,
    pub sha1: String,
    pub url: String,
    #[serde(default)]
    pub size_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackManifest {
    pub format_version: u32,
    pub kind: String,
    /// "full" | "light"
    pub mode: String,
    pub name: String,
    pub created_at: String,
    #[serde(default)]
    pub app_version: String,
    /// Subconjunto do cubicase-meta.json (versão, tipo, RAM, jar, loader…) — o
    /// importador recria o meta do novo servidor a partir daqui, com UUID e
    /// código de convite NOVOS (nunca os do servidor original).
    #[serde(default)]
    pub meta: serde_json::Value,
    #[serde(default)]
    pub java_version: Option<u32>,
    #[serde(default)]
    pub includes_jre: bool,
    #[serde(default)]
    pub includes_player_lists: bool,
    pub file_count: u64,
    pub total_bytes: u64,
    #[serde(default)]
    pub omitted_mods: Vec<OmittedMod>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub server_dir: String,
    pub dest_path: String,
    pub mode: String,
    pub name: String,
    #[serde(default)]
    pub meta: serde_json::Value,
    #[serde(default)]
    pub java_version: Option<u32>,
    #[serde(default)]
    pub jre_dir: Option<String>,
    #[serde(default)]
    pub include_player_lists: bool,
    #[serde(default)]
    pub omit_mods: Vec<OmittedMod>,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default)]
    pub app_version: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackProblem {
    pub code: String,
    pub message: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    pub problems: Vec<PackProblem>,
    pub total_bytes: u64,
    pub file_count: u64,
    pub omitted_bytes: u64,
    pub required_bytes: u64,
    pub free_bytes: Option<u64>,
    pub dest_exists: bool,
    pub has_world: bool,
    pub skipped_links: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub dest_path: String,
    pub size_bytes: u64,
    pub file_count: u64,
    pub total_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackProgress {
    pub job: String,
    pub phase: String,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub done_files: u64,
    pub total_files: u64,
    pub current: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackInspectionView {
    pub manifest: PackManifest,
    pub total_bytes: u64,
    pub file_count: u64,
    pub archive_bytes: u64,
    pub longest_path: usize,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub pack_path: String,
    /// Pasta que vai conter o servidor (ex.: Documentos/CubicaseServers).
    pub parent_dir: String,
    pub folder_name: String,
    /// Onde instalar o Java do pacote (ex.: AppLocalData/runtime/java-21); None = não instalar.
    #[serde(default)]
    pub jre_dest: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub server_path: String,
    pub jre_installed: bool,
    pub jre_warning: Option<String>,
    pub manifest: PackManifest,
}

// ------------------------------------------------------------
// Trava de job (um export/import por vez) e cancelamento
// ------------------------------------------------------------

static JOB_ACTIVE: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
static EXPORTING_DIRS: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct JobGuard {
    dir_key: Option<String>,
}

impl JobGuard {
    fn begin(dir: Option<&str>) -> Result<Self, String> {
        if JOB_ACTIVE.swap(true, Ordering::SeqCst) {
            return Err(tr!("pack.err.busy"));
        }
        CANCEL.store(false, Ordering::SeqCst);
        let dir_key = dir.map(norm_path);
        if let Some(key) = &dir_key {
            if let Ok(mut g) = EXPORTING_DIRS.lock() {
                g.push(key.clone());
            }
        }
        Ok(JobGuard { dir_key })
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Some(key) = &self.dir_key {
            if let Ok(mut g) = EXPORTING_DIRS.lock() {
                g.retain(|d| d != key);
            }
        }
        JOB_ACTIVE.store(false, Ordering::SeqCst);
    }
}

/// `true` se o servidor foi importado de um pacote leve e ainda faltam mods
/// (`cubicase-pending.json` com mods). Consultado por `start_minecraft_server`:
/// iniciar assim rodaria o servidor sem os mods e poderia corromper o mundo.
/// Arquivo ilegível conta como "sem pendência" — não trava o servidor para sempre.
pub fn has_pending_mods(server_dir: &str) -> bool {
    std::fs::read_to_string(Path::new(server_dir).join("cubicase-pending.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("mods").and_then(|m| m.as_array()).map(|a| !a.is_empty()))
        .unwrap_or(false)
}

/// `true` enquanto uma exportação desta pasta está em andamento — consultado por
/// `start_minecraft_server` (a trava tem que estar no backend, não só na UI).
pub fn export_in_progress_for(server_dir: &str) -> bool {
    let key = norm_path(server_dir);
    EXPORTING_DIRS.lock().map(|g| g.iter().any(|d| *d == key)).unwrap_or(false)
}

// ------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------

fn norm_path(p: &str) -> String {
    let mut s = p.replace('/', "\\");
    if let Some(rest) = s.strip_prefix("\\\\?\\") {
        s = rest.to_string();
    }
    s.trim_end_matches('\\').to_lowercase()
}

fn path_chars(p: &Path) -> usize {
    p.to_string_lossy().chars().count()
}

fn is_disk_full(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(112) | Some(39) | Some(28)) || e.kind() == std::io::ErrorKind::StorageFull
}

fn is_transient_lock(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(32) | Some(33) | Some(5)) || e.kind() == std::io::ErrorKind::PermissionDenied
}

fn write_err(e: &std::io::Error) -> String {
    if is_disk_full(e) {
        tr!("pack.err.diskFull")
    } else {
        tr!("pack.err.writeFailed", error = e)
    }
}

fn zip_write_err(e: zip::result::ZipError) -> String {
    match &e {
        zip::result::ZipError::Io(io) => write_err(io),
        other => tr!("pack.err.writeFailed", error = other),
    }
}

fn format_bytes(b: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    let v = b as f64;
    if v < MB {
        format!("{} KB", (v / 1024.0).ceil().max(1.0) as u64)
    } else if v < MB * 1024.0 {
        format!("{:.0} MB", v / MB)
    } else {
        format!("{:.1} GB", v / (MB * 1024.0))
    }
}

fn is_reserved_windows_name(comp: &str) -> bool {
    let stem = comp.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// Valida o nome de uma entrada do zip (ou o nome de uma pasta de servidor) e
/// devolve o caminho relativo seguro. Usa SEMPRE `/` como separador (é o que o
/// exportador escreve); `\`, `:`, `..`, caminhos absolutos, nomes reservados do
/// Windows e componentes com espaço/ponto no fim são rejeitados — é isto que
/// barra o zip-slip, além de nomes que o Windows aceitaria escrever mas
/// truncaria ou trataria de forma diferente.
fn validate_entry_name(name: &str) -> Result<PathBuf, String> {
    let bad = || tr!("pack.err.unsafeEntry", name = name);
    if name.is_empty()
        || name.starts_with('/')
        || name.contains('\\')
        || name.chars().any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err(bad());
    }
    let trimmed = name.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(bad());
    }
    let mut out = PathBuf::new();
    for comp in trimmed.split('/') {
        if comp.is_empty()
            || comp == "."
            || comp == ".."
            || comp.chars().count() > 255
            || comp.ends_with(' ')
            || comp.ends_with('.')
            || is_reserved_windows_name(comp)
        {
            return Err(bad());
        }
        out.push(comp);
    }
    Ok(out)
}

fn validate_folder_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(tr!("pack.err.nameEmpty"));
    }
    let path = validate_entry_name(trimmed).map_err(|_| tr!("pack.err.nameInvalid", name = trimmed))?;
    if path.components().count() != 1 {
        return Err(tr!("pack.err.nameInvalid", name = trimmed));
    }
    Ok(trimmed.to_string())
}

fn free_space_for(path: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let target = norm_path(&path.to_string_lossy());
    disks
        .list()
        .iter()
        .filter_map(|d| {
            let mount = norm_path(&d.mount_point().to_string_lossy());
            if target == mount || target.starts_with(&format!("{}\\", mount)) {
                Some((mount.len(), d.available_space()))
            } else {
                None
            }
        })
        .max_by_key(|(len, _)| *len)
        .map(|(_, free)| free)
}

fn required_space(total_bytes: u64) -> u64 {
    total_bytes + total_bytes / 10 + SPACE_FIXED_MARGIN
}

/// Procura um processo Java com a pasta do servidor como diretório de trabalho
/// (ou citada na linha de comando) — pega o Minecraft iniciado por FORA do
/// Cubicase (um .bat, por exemplo), que `ensure_mc_server_stopped` não enxerga.
fn server_process_using(server_dir: &Path) -> Option<u32> {
    let target = norm_path(&server_dir.to_string_lossy());
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new()
            .with_cwd(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );
    let under = |p: &str| {
        let n = norm_path(p);
        n == target || n.starts_with(&format!("{}\\", target))
    };
    for (pid, proc_) in sys.processes() {
        if !proc_.name().to_string_lossy().to_lowercase().contains("java") {
            continue;
        }
        if let Some(cwd) = proc_.cwd() {
            if under(&cwd.to_string_lossy()) {
                return Some(pid.as_u32());
            }
        }
        if proc_.cmd().iter().any(|a| norm_path(&a.to_string_lossy()).contains(&target)) {
            return Some(pid.as_u32());
        }
    }
    None
}

/// (tamanho, mtime) de `level.dat` e `session.lock` de cada pasta de mundo —
/// se isto mudar entre o começo e o fim do export, o servidor rodou no meio.
fn world_stamps(server_dir: &Path) -> Vec<Option<(u64, u128)>> {
    let dir = server_dir.to_string_lossy().to_string();
    let level = read_level_name(&dir);
    let mut out = Vec::new();
    for folder in world_folder_paths(&dir, &level) {
        for file in ["level.dat", "session.lock"] {
            let stamp = std::fs::metadata(folder.join(file)).ok().map(|m| {
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                (m.len(), mtime)
            });
            out.push(stamp);
        }
    }
    out
}

// ------------------------------------------------------------
// O que entra no pacote
// ------------------------------------------------------------

fn is_excluded_dir(rel_lower: &str) -> bool {
    if rel_lower.contains('/') {
        return false;
    }
    matches!(rel_lower, "logs" | "crash-reports")
        || rel_lower.starts_with(".restore_staging_")
        || rel_lower.starts_with(".cubicase-")
        || rel_lower.starts_with(STAGING_PREFIX)
}

fn is_excluded_file(rel: &str, include_player_lists: bool) -> bool {
    let lower = rel.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or("");
    if name == "session.lock" || name.ends_with(".tmp") || name.ends_with(".cubicase") {
        return true;
    }
    if lower.contains('/') {
        return false;
    }
    // Arquivos de raiz. `network_session.json` e `usercache.json` nunca saem;
    // `cubicase-meta.json` é substituído pelo manifesto (UUID/código novos).
    if matches!(
        name,
        "network_session.json" | "usercache.json" | "cubicase-meta.json" | "cubicase-pending.json" | "cubeforge-mods-cache.json"
    ) {
        return true;
    }
    !include_player_lists
        && matches!(name, "whitelist.json" | "ops.json" | "banned-players.json" | "banned-ips.json")
}

fn sanitize_properties(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let t = line.trim_start();
        if !t.starts_with('#') {
            if let Some((k, _)) = t.split_once('=') {
                if k.trim().eq_ignore_ascii_case("rcon.password") {
                    out.push_str("rcon.password=\n");
                    continue;
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

struct PackEntry {
    abs: Option<PathBuf>,
    rel: String,
    size: u64,
    is_dir: bool,
    inline: Option<Vec<u8>>,
}

#[derive(Default)]
struct Plan {
    entries: Vec<PackEntry>,
    file_count: u64,
    total_bytes: u64,
    omitted_bytes: u64,
    has_world: bool,
    skipped_links: u32,
    jre_included: bool,
}

fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|r| {
            r.components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

/// Percorre `root` e acrescenta ao plano. `keep_file`/`keep_dir` decidem o que
/// entra (caminhos relativos a `root`, com `/`); `prefix` é prefixado ao nome
/// dentro do zip (ex.: "__jre"). Erros de leitura de pasta e nomes inseguros
/// FALHAM em vez de serem pulados em silêncio — um pacote que "parece bom" mas
/// perdeu arquivos é pior do que um erro claro.
fn collect_tree(
    root: &Path,
    prefix: &str,
    keep_dir: &dyn Fn(&str) -> bool,
    file_action: &dyn Fn(&str) -> FileAction,
    plan: &mut Plan,
) -> Result<(), String> {
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 || !e.file_type().is_dir() {
                return true;
            }
            keep_dir(&rel_of(root, e.path()).to_lowercase())
        });

    for entry in walker {
        let entry = entry.map_err(|e| tr!("pack.err.walk", error = e))?;
        if entry.depth() == 0 {
            continue;
        }
        if entry.path_is_symlink() {
            plan.skipped_links += 1;
            continue;
        }
        let rel_str = match entry.path().strip_prefix(root).ok().and_then(|r| {
            r.components().map(|c| c.as_os_str().to_str()).collect::<Option<Vec<_>>>()
        }) {
            Some(parts) => parts.join("/"),
            None => return Err(tr!("pack.err.unsafeName", file = entry.path().to_string_lossy())),
        };
        let zip_name = if prefix.is_empty() { rel_str.clone() } else { format!("{}/{}", prefix, rel_str) };

        if entry.file_type().is_dir() {
            validate_entry_name(&zip_name).map_err(|_| tr!("pack.err.unsafeName", file = entry.path().to_string_lossy()))?;
            plan.entries.push(PackEntry { abs: None, rel: format!("{}/", zip_name), size: 0, is_dir: true, inline: None });
            continue;
        }
        if !entry.file_type().is_file() {
            plan.skipped_links += 1;
            continue;
        }

        let meta = entry.metadata().map_err(|e| tr!("pack.err.readFile", file = entry.path().to_string_lossy(), error = e))?;
        match file_action(&rel_str) {
            FileAction::Skip => continue,
            FileAction::Omit => {
                plan.omitted_bytes += meta.len();
                continue;
            }
            FileAction::Include => {}
        }
        validate_entry_name(&zip_name).map_err(|_| tr!("pack.err.unsafeName", file = entry.path().to_string_lossy()))?;

        let (size, inline) = if prefix.is_empty() && rel_str == "server.properties" {
            let text = std::fs::read_to_string(entry.path())
                .map_err(|e| tr!("pack.err.readFile", file = entry.path().to_string_lossy(), error = e))?;
            let bytes = sanitize_properties(&text).into_bytes();
            (bytes.len() as u64, Some(bytes))
        } else {
            (meta.len(), None)
        };
        plan.file_count += 1;
        plan.total_bytes += size;
        plan.entries.push(PackEntry { abs: Some(entry.path().to_path_buf()), rel: zip_name, size, is_dir: false, inline });
    }
    Ok(())
}

enum FileAction {
    Include,
    Skip,
    Omit,
}

fn build_plan(req: &ExportRequest) -> Result<Plan, String> {
    let server_dir = Path::new(&req.server_dir);
    let omit: HashSet<String> = req
        .omit_mods
        .iter()
        .map(|m| format!("mods/{}", m.filename).to_lowercase())
        .collect();
    let include_lists = req.include_player_lists;

    let mut plan = Plan::default();
    collect_tree(
        server_dir,
        "",
        &|rel| !is_excluded_dir(rel),
        &|rel| {
            if is_excluded_file(rel, include_lists) {
                FileAction::Skip
            } else if omit.contains(&rel.to_lowercase()) {
                FileAction::Omit
            } else {
                FileAction::Include
            }
        },
        &mut plan,
    )?;

    let level = read_level_name(&req.server_dir);
    plan.has_world = !world_folder_paths(&req.server_dir, &level).is_empty();

    if req.mode == "full" {
        if let Some(jre) = &req.jre_dir {
            let jre_path = Path::new(jre);
            if !jre_path.join(JRE_MARKER).is_file() {
                return Err(tr!("pack.err.jreIncomplete"));
            }
            collect_tree(jre_path, JRE_PREFIX, &|_| true, &|_| FileAction::Include, &mut plan)?;
            plan.jre_included = true;
        }
    }
    Ok(plan)
}

// ------------------------------------------------------------
// Pré-voo
// ------------------------------------------------------------

type CheckErr = (&'static str, String);

fn check_mode(mode: &str) -> Result<(), CheckErr> {
    if mode == "full" || mode == "light" {
        Ok(())
    } else {
        Err(("mode", tr!("pack.err.badMode", mode = mode)))
    }
}

fn check_dest(req: &ExportRequest) -> Result<(), CheckErr> {
    let dest = Path::new(&req.dest_path);
    let server_dir = Path::new(&req.server_dir);
    if !server_dir.is_dir() {
        return Err(("serverMissing", tr!("pack.err.serverMissing")));
    }
    if !req.dest_path.to_lowercase().ends_with(".cubicase") {
        return Err(("destInvalid", tr!("pack.err.destExtension")));
    }
    let parent = match dest.parent() {
        Some(p) if p.is_dir() => p,
        _ => return Err(("destInvalid", tr!("pack.err.destFolderMissing"))),
    };
    let dest_norm = norm_path(&req.dest_path);
    let server_norm = norm_path(&req.server_dir);
    if dest_norm == server_norm || dest_norm.starts_with(&format!("{}\\", server_norm)) {
        return Err(("destInsideServer", tr!("pack.err.destInsideServer")));
    }
    let tmp_len = req.dest_path.chars().count() + ".tmp".len();
    if tmp_len > MAX_DEST_CHARS {
        return Err(("destPathTooLong", tr!("pack.err.destPathTooLong", max = MAX_DEST_CHARS)));
    }
    // Probe de escrita: pega pasta somente-leitura, sem permissão ou em disco
    // bloqueado ANTES de varrer o servidor inteiro.
    let probe = parent.join(format!(".cubicase-write-test-{}", std::process::id()));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(mut f) => {
            let _ = f.write_all(b"x");
            drop(f);
            let _ = std::fs::remove_file(&probe);
        }
        Err(e) => return Err(("destNotWritable", tr!("pack.err.destNotWritable", error = e))),
    }
    Ok(())
}

fn check_idle(server_dir: &Path) -> Result<(), CheckErr> {
    if let Some(pid) = server_process_using(server_dir) {
        return Err(("serverRunning", tr!("pack.err.serverExternal", pid = pid)));
    }
    Ok(())
}

fn check_space(dest: &Path, total_bytes: u64) -> Result<(u64, Option<u64>), CheckErr> {
    let required = required_space(total_bytes);
    let free = dest.parent().and_then(free_space_for);
    if let Some(free) = free {
        if free < required {
            return Err((
                "noSpace",
                tr!(
                    "pack.err.noSpaceExport",
                    need = format_bytes(required),
                    free = format_bytes(free),
                    missing = format_bytes(required - free)
                ),
            ));
        }
    }
    Ok((required, free))
}

fn run_preflight(req: &ExportRequest, server_running_hint: Option<String>) -> PreflightResult {
    let mut res = PreflightResult::default();
    fn push(res: &mut PreflightResult, code: &str, message: String) {
        res.problems.push(PackProblem { code: code.to_string(), message });
    }

    if let Err((c, m)) = check_mode(&req.mode) {
        push(&mut res, c, m);
        return res;
    }
    if JOB_ACTIVE.load(Ordering::SeqCst) {
        push(&mut res, "busy", tr!("pack.err.busy"));
    }
    if let Some(msg) = server_running_hint {
        push(&mut res, "serverRunning", msg);
    }
    if let Err((c, m)) = check_dest(req) {
        push(&mut res, c, m);
        return res;
    }
    if let Err((c, m)) = check_idle(Path::new(&req.server_dir)) {
        if !res.problems.iter().any(|p| p.code == "serverRunning") {
            push(&mut res, c, m);
        }
    }
    if req.mode == "full" && req.jre_dir.is_none() {
        push(&mut res, "jreRequired", tr!("pack.err.jreRequired"));
    }
    res.dest_exists = Path::new(&req.dest_path).exists();

    match build_plan(req) {
        Ok(plan) => {
            res.total_bytes = plan.total_bytes;
            res.file_count = plan.file_count;
            res.omitted_bytes = plan.omitted_bytes;
            res.has_world = plan.has_world;
            res.skipped_links = plan.skipped_links;
            match check_space(Path::new(&req.dest_path), plan.total_bytes) {
                Ok((required, free)) => {
                    res.required_bytes = required;
                    res.free_bytes = free;
                }
                Err((c, m)) => {
                    res.required_bytes = required_space(plan.total_bytes);
                    res.free_bytes = Path::new(&req.dest_path).parent().and_then(free_space_for);
                    push(&mut res, c, m);
                }
            }
        }
        Err(m) => push(&mut res, "unreadable", m),
    }
    res
}

// ------------------------------------------------------------
// Exportação
// ------------------------------------------------------------

struct TmpGuard {
    path: PathBuf,
    keep: bool,
}

impl Drop for TmpGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

struct Throttle {
    last: Instant,
}

impl Throttle {
    /// Pronto imediatamente na primeira chamada.
    fn new() -> Self {
        let now = Instant::now();
        Throttle { last: now.checked_sub(Duration::from_secs(10)).unwrap_or(now) }
    }
    /// Só fica pronto depois de `every_ms` a partir de agora.
    fn starting_now() -> Self {
        Throttle { last: Instant::now() }
    }
    fn ready(&mut self, every_ms: u128) -> bool {
        if self.last.elapsed().as_millis() >= every_ms {
            self.last = Instant::now();
            true
        } else {
            false
        }
    }
}

fn open_with_retry(path: &Path) -> std::io::Result<File> {
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..4 {
        match File::open(path) {
            Ok(f) => return Ok(f),
            Err(e) if attempt < 3 && is_transient_lock(&e) => {
                last = Some(e);
                thread::sleep(Duration::from_millis(300));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("open failed")))
}

fn entry_options(rel: &str, size: u64) -> zip::write::SimpleFileOptions {
    let lower = rel.to_lowercase();
    let already_compressed = [".jar", ".zip", ".png", ".ogg", ".gz", ".jpg", ".mrpack"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    let opts = zip::write::SimpleFileOptions::default().large_file(size >= 0xFFFF_FFFF);
    if already_compressed {
        opts.compression_method(zip::CompressionMethod::Stored)
    } else {
        opts.compression_method(zip::CompressionMethod::Deflated).compression_level(Some(4))
    }
}

fn verify_written_pack(tmp: &Path, expected_entries: usize) -> Result<(), String> {
    let file = File::open(tmp).map_err(|e| tr!("pack.err.verifyFailed", error = e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| tr!("pack.err.verifyFailed", error = e))?;
    if archive.len() != expected_entries {
        return Err(tr!("pack.err.verifyFailed", error = format!("{} != {}", archive.len(), expected_entries)));
    }
    let len = archive.len();
    for i in 0..len {
        let mut ent = archive.by_index(i).map_err(|e| tr!("pack.err.verifyFailed", error = e))?;
        let name = ent.name().to_lowercase();
        let sample = i == 0 || i + 1 == len || i % VERIFY_STEP == 0 || name.ends_with("level.dat");
        if !sample || ent.is_dir() {
            continue;
        }
        // Ler até o fim faz a crate conferir o CRC32 da entrada.
        std::io::copy(&mut ent, &mut std::io::sink()).map_err(|e| tr!("pack.err.verifyFailed", error = e))?;
    }
    Ok(())
}

fn run_export(
    req: &ExportRequest,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(PackProgress),
) -> Result<ExportOutcome, String> {
    let server_dir = Path::new(&req.server_dir);
    let dest = Path::new(&req.dest_path);
    let cancelled = || tr!("pack.cancelled");
    let progress = |phase: &str, done_b: u64, total_b: u64, done_f: u64, total_f: u64, cur: &str| PackProgress {
        job: "export".into(),
        phase: phase.into(),
        done_bytes: done_b,
        total_bytes: total_b,
        done_files: done_f,
        total_files: total_f,
        current: cur.into(),
    };

    check_mode(&req.mode).map_err(|(_, m)| m)?;
    check_dest(req).map_err(|(_, m)| m)?;
    if dest.exists() && !req.overwrite {
        return Err(tr!("pack.err.destExists"));
    }
    if dest.is_dir() {
        return Err(tr!("pack.err.destIsFolder"));
    }
    check_idle(server_dir).map_err(|(_, m)| m)?;
    if req.mode == "full" && req.jre_dir.is_none() {
        return Err(tr!("pack.err.jreRequired"));
    }

    emit(progress("scanning", 0, 0, 0, 0, ""));
    let plan = build_plan(req)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    check_space(dest, plan.total_bytes).map_err(|(_, m)| m)?;

    let stamps_before = world_stamps(server_dir);

    let tmp_path = PathBuf::from(format!("{}.tmp", req.dest_path));
    if tmp_path.exists() {
        std::fs::remove_file(&tmp_path).map_err(|e| tr!("pack.err.staleTmp", error = e))?;
    }
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|e| write_err(&e))?;
    let mut guard = TmpGuard { path: tmp_path.clone(), keep: false };
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::with_capacity(1 << 20, file));

    let manifest = PackManifest {
        format_version: PACK_FORMAT_VERSION,
        kind: PACK_KIND.to_string(),
        mode: req.mode.clone(),
        name: req.name.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        app_version: req.app_version.clone(),
        meta: req.meta.clone(),
        java_version: if plan.jre_included { req.java_version } else { None },
        includes_jre: plan.jre_included,
        includes_player_lists: req.include_player_lists,
        file_count: plan.file_count,
        total_bytes: plan.total_bytes,
        omitted_mods: req.omit_mods.clone(),
    };
    let manifest_json = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.start_file(MANIFEST_NAME, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated))
        .map_err(zip_write_err)?;
    zip.write_all(&manifest_json).map_err(|e| write_err(&e))?;

    let mut done_bytes = 0u64;
    let mut done_files = 0u64;
    let mut throttle = Throttle::new();
    let mut in_use_throttle = Throttle::starting_now(); // a checagem inicial já rodou
    let mut buf = vec![0u8; 256 * 1024];

    for entry in &plan.entries {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        if in_use_throttle.ready(IN_USE_CHECK_EVERY_MS) {
            if let Some(pid) = server_process_using(server_dir) {
                return Err(tr!("pack.err.serverStartedDuring", pid = pid));
            }
        }
        if entry.is_dir {
            zip.add_directory(entry.rel.clone(), zip::write::SimpleFileOptions::default()).map_err(zip_write_err)?;
            continue;
        }
        zip.start_file(entry.rel.clone(), entry_options(&entry.rel, entry.size)).map_err(zip_write_err)?;

        if let Some(bytes) = &entry.inline {
            zip.write_all(bytes).map_err(|e| write_err(&e))?;
            done_bytes += bytes.len() as u64;
        } else if let Some(abs) = &entry.abs {
            let mut src = open_with_retry(abs)
                .map_err(|e| tr!("pack.err.readFile", file = abs.to_string_lossy(), error = e))?;
            let mut read_total = 0u64;
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err(cancelled());
                }
                let n = src
                    .read(&mut buf)
                    .map_err(|e| tr!("pack.err.readFile", file = abs.to_string_lossy(), error = e))?;
                if n == 0 {
                    break;
                }
                read_total += n as u64;
                if read_total > entry.size {
                    return Err(tr!("pack.err.changedDuring", file = entry.rel));
                }
                zip.write_all(&buf[..n]).map_err(|e| write_err(&e))?;
                done_bytes += n as u64;
                if throttle.ready(PROGRESS_EVERY_MS) {
                    emit(progress("writing", done_bytes, plan.total_bytes, done_files, plan.file_count, &entry.rel));
                }
            }
            if read_total != entry.size {
                return Err(tr!("pack.err.changedDuring", file = entry.rel));
            }
        }
        done_files += 1;
        if throttle.ready(PROGRESS_EVERY_MS) {
            emit(progress("writing", done_bytes, plan.total_bytes, done_files, plan.file_count, &entry.rel));
        }
    }

    let mut writer = zip.finish().map_err(zip_write_err)?;
    writer.flush().map_err(|e| write_err(&e))?;
    writer.get_ref().sync_all().map_err(|e| write_err(&e))?;
    drop(writer);

    // O servidor rodou no meio? (mundo mexido, ou um Java novo apontando pra pasta)
    if world_stamps(server_dir) != stamps_before || server_process_using(server_dir).is_some() {
        return Err(tr!("pack.err.serverStartedAfter"));
    }

    emit(progress("verifying", done_bytes, plan.total_bytes, done_files, plan.file_count, ""));
    // +1: o manifesto
    verify_written_pack(&tmp_path, plan.entries.len() + 1)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(cancelled());
    }

    if dest.exists() {
        if !req.overwrite {
            return Err(tr!("pack.err.destExists"));
        }
        std::fs::remove_file(dest).map_err(|e| tr!("pack.err.replaceFailed", error = e))?;
    }
    std::fs::rename(&tmp_path, dest).map_err(|e| tr!("pack.err.renameFailed", error = e))?;
    guard.keep = true;

    let size_bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    emit(progress("done", done_bytes, plan.total_bytes, done_files, plan.file_count, ""));
    Ok(ExportOutcome {
        dest_path: req.dest_path.clone(),
        size_bytes,
        file_count: plan.file_count,
        total_bytes: plan.total_bytes,
    })
}

// ------------------------------------------------------------
// Inspeção e importação
// ------------------------------------------------------------

struct InspEntry {
    index: usize,
    rel: PathBuf,
    is_dir: bool,
    size: u64,
}

struct Inspection {
    manifest: PackManifest,
    entries: Vec<InspEntry>,
    total_bytes: u64,
    file_count: u64,
    longest_rel: usize,
    longest_jre_rel: usize,
    archive_bytes: u64,
}

fn inspect_pack(path: &Path) -> Result<Inspection, String> {
    let file = File::open(path).map_err(|e| tr!("pack.err.openPack", error = e))?;
    let archive_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut archive = zip::ZipArchive::new(file).map_err(|e| tr!("pack.err.notAPack", error = e))?;
    if archive.len() > MAX_ENTRIES {
        return Err(tr!("pack.err.tooManyEntries"));
    }

    let manifest: PackManifest = {
        let entry = archive.by_name(MANIFEST_NAME).map_err(|_| tr!("pack.err.noManifest"))?;
        let mut text = String::new();
        entry
            .take(MAX_MANIFEST_BYTES)
            .read_to_string(&mut text)
            .map_err(|e| tr!("pack.err.manifestInvalid", error = e))?;
        serde_json::from_str(&text).map_err(|e| tr!("pack.err.manifestInvalid", error = e))?
    };
    if manifest.kind != PACK_KIND {
        return Err(tr!("pack.err.notAPack", error = "kind"));
    }
    if manifest.format_version > PACK_FORMAT_VERSION {
        return Err(tr!("pack.err.newerFormat"));
    }
    if manifest.mode != "full" && manifest.mode != "light" {
        return Err(tr!("pack.err.badMode", mode = manifest.mode));
    }

    let mut entries = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let (mut total, mut files, mut longest, mut longest_jre) = (0u64, 0u64, 0usize, 0usize);

    for i in 0..archive.len() {
        let f = archive.by_index_raw(i).map_err(|e| tr!("pack.err.notAPack", error = e))?;
        let name = f.name().to_string();
        if name == MANIFEST_NAME {
            continue;
        }
        let rel = validate_entry_name(&name)?;
        let key = name.trim_end_matches('/').to_lowercase();
        if !seen.insert(key) {
            return Err(tr!("pack.err.duplicateEntry", name = name));
        }
        if let Some(mode) = f.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(tr!("pack.err.symlinkEntry", name = name));
            }
        }
        let is_dir = f.is_dir();
        let size = f.size();
        if !is_dir {
            total = total.saturating_add(size);
            files += 1;
        }
        let is_jre = rel.components().next().map(|c| c.as_os_str() == JRE_PREFIX).unwrap_or(false);
        let chars = name.chars().count();
        if is_jre {
            longest_jre = longest_jre.max(chars);
        } else {
            longest = longest.max(chars);
        }
        entries.push(InspEntry {
            index: i,
            rel,
            is_dir,
            size,
        });
    }

    if total > MAX_TOTAL_BYTES {
        return Err(tr!("pack.err.tooBig", max = format_bytes(MAX_TOTAL_BYTES)));
    }
    if total != manifest.total_bytes || files != manifest.file_count {
        return Err(tr!("pack.err.manifestMismatch"));
    }
    Ok(Inspection { manifest, entries, total_bytes: total, file_count: files, longest_rel: longest, longest_jre_rel: longest_jre, archive_bytes })
}

fn remove_dir_with_retry(dir: &Path) {
    for attempt in 0..3 {
        if !dir.exists() || std::fs::remove_dir_all(dir).is_ok() {
            return;
        }
        if attempt < 2 {
            thread::sleep(Duration::from_millis(300));
        }
    }
}

fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Move o Java extraído para o destino final (rename; se for outro volume, copia).
/// Se já existe um Java completo ali, mantém o que existe.
fn install_staged_jre(staged: &Path, dest: &Path) -> Result<(), String> {
    if dest.join(JRE_MARKER).is_file() {
        remove_dir_with_retry(staged);
        return Ok(());
    }
    if dest.exists() {
        remove_dir_with_retry(dest); // instalação incompleta de antes
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| write_err(&e))?;
    }
    if std::fs::rename(staged, dest).is_err() {
        if let Err(e) = copy_dir_recursive(staged, dest) {
            remove_dir_with_retry(dest);
            return Err(write_err(&e));
        }
        remove_dir_with_retry(staged);
    }
    std::fs::write(dest.join(JRE_MARKER), chrono::Utc::now().to_rfc3339()).map_err(|e| write_err(&e))?;
    Ok(())
}

fn run_import(
    req: &ImportRequest,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(PackProgress),
) -> Result<ImportOutcome, String> {
    let cancelled = || tr!("pack.cancelled");
    let progress = |phase: &str, done_b: u64, total_b: u64, done_f: u64, total_f: u64, cur: &str| PackProgress {
        job: "import".into(),
        phase: phase.into(),
        done_bytes: done_b,
        total_bytes: total_b,
        done_files: done_f,
        total_files: total_f,
        current: cur.into(),
    };

    emit(progress("reading", 0, 0, 0, 0, ""));
    let pack_path = Path::new(&req.pack_path);
    let insp = inspect_pack(pack_path)?;

    let folder_name = validate_folder_name(&req.folder_name)?;
    let parent = Path::new(&req.parent_dir);
    std::fs::create_dir_all(parent).map_err(|e| write_err(&e))?;
    let final_dir = parent.join(&folder_name);
    if final_dir.exists() {
        return Err(tr!("pack.err.nameExists", name = folder_name));
    }

    // Orçamento de caminho: o maior arquivo do pacote, já dentro da pasta final.
    let final_len = path_chars(&final_dir) + 1 + insp.longest_rel;
    if final_len > MAX_PATH_CHARS {
        let allowed = MAX_PATH_CHARS
            .saturating_sub(path_chars(parent) + 1 + 1 + insp.longest_rel);
        return Err(tr!("pack.err.pathTooLong", allowed = allowed, max = MAX_PATH_CHARS));
    }

    let required = required_space(insp.total_bytes);
    if let Some(free) = free_space_for(parent) {
        if free < required {
            return Err(tr!(
                "pack.err.noSpaceImport",
                need = format_bytes(required),
                free = format_bytes(free),
                missing = format_bytes(required - free)
            ));
        }
    }

    let ts = chrono::Utc::now().timestamp_millis();
    let staging = parent.join(format!("{}{}", STAGING_PREFIX, ts));
    std::fs::create_dir_all(&staging).map_err(|e| write_err(&e))?;

    let result = (|| -> Result<(bool, Option<String>), String> {
        let file = File::open(pack_path).map_err(|e| tr!("pack.err.openPack", error = e))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| tr!("pack.err.notAPack", error = e))?;
        let mut buf = vec![0u8; 256 * 1024];
        let (mut done_b, mut done_f) = (0u64, 0u64);
        let mut throttle = Throttle::new();

        for e in &insp.entries {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            let out_path = staging.join(&e.rel);
            if e.is_dir {
                std::fs::create_dir_all(&out_path).map_err(|err| write_err(&err))?;
                continue;
            }
            if let Some(p) = out_path.parent() {
                std::fs::create_dir_all(p).map_err(|err| write_err(&err))?;
            }
            let mut src = archive.by_index(e.index).map_err(|err| tr!("pack.err.corruptEntry", name = e.rel.display(), error = err))?;
            let mut out = File::create(&out_path).map_err(|err| write_err(&err))?;
            let mut written = 0u64;
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err(cancelled());
                }
                let n = src
                    .read(&mut buf)
                    .map_err(|err| tr!("pack.err.corruptEntry", name = e.rel.display(), error = err))?;
                if n == 0 {
                    break;
                }
                written += n as u64;
                // O tamanho declarado no índice do zip pode mentir (zip bomb):
                // nunca escreve mais do que foi declarado — e o total declarado
                // já foi conferido contra o manifesto, o teto (MAX_TOTAL_BYTES)
                // e o espaço livre antes de começar.
                if written > e.size {
                    return Err(tr!("pack.err.declaredSizeExceeded", name = e.rel.display()));
                }
                out.write_all(&buf[..n]).map_err(|err| write_err(&err))?;
                done_b += n as u64;
                if throttle.ready(PROGRESS_EVERY_MS) {
                    emit(progress("extracting", done_b, insp.total_bytes, done_f, insp.file_count, &e.rel.to_string_lossy()));
                }
            }
            if written != e.size {
                return Err(tr!("pack.err.corruptEntry", name = e.rel.display(), error = "size"));
            }
            out.flush().map_err(|err| write_err(&err))?;
            done_f += 1;
        }

        emit(progress("finalizing", done_b, insp.total_bytes, done_f, insp.file_count, ""));

        // Java do pacote: falha aqui NÃO derruba a importação — o servidor fica
        // importado e o Java é baixado depois (ou ao iniciar, se houver internet).
        let staged_jre = staging.join(JRE_PREFIX);
        let mut jre_installed = false;
        let mut jre_warning = None;
        if staged_jre.is_dir() {
            match &req.jre_dest {
                Some(dest) => {
                    let dest = Path::new(dest);
                    if path_chars(dest) + 1 + insp.longest_jre_rel > MAX_PATH_CHARS {
                        jre_warning = Some(tr!("pack.warn.jrePathTooLong"));
                        remove_dir_with_retry(&staged_jre);
                    } else {
                        match install_staged_jre(&staged_jre, dest) {
                            Ok(()) => jre_installed = true,
                            Err(m) => {
                                jre_warning = Some(m);
                                remove_dir_with_retry(&staged_jre);
                            }
                        }
                    }
                }
                None => remove_dir_with_retry(&staged_jre),
            }
        }
        Ok((jre_installed, jre_warning))
    })();

    match result {
        Ok((jre_installed, jre_warning)) => {
            if final_dir.exists() {
                remove_dir_with_retry(&staging);
                return Err(tr!("pack.err.nameExists", name = folder_name));
            }
            if let Err(e) = std::fs::rename(&staging, &final_dir) {
                remove_dir_with_retry(&staging);
                return Err(tr!("pack.err.renameFailed", error = e));
            }
            emit(progress("done", insp.total_bytes, insp.total_bytes, insp.file_count, insp.file_count, ""));
            Ok(ImportOutcome {
                server_path: final_dir.to_string_lossy().to_string(),
                jre_installed,
                jre_warning,
                manifest: insp.manifest,
            })
        }
        Err(e) => {
            remove_dir_with_retry(&staging);
            Err(e)
        }
    }
}

// ------------------------------------------------------------
// Comandos Tauri
// ------------------------------------------------------------

#[tauri::command]
pub async fn pack_preflight(state: tauri::State<'_, AppState>, req: ExportRequest) -> Result<PreflightResult, String> {
    let running_hint = ensure_mc_server_stopped(&state).err();
    tauri::async_runtime::spawn_blocking(move || run_preflight(&req, running_hint))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pack_export(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    req: ExportRequest,
) -> Result<ExportOutcome, String> {
    ensure_mc_server_stopped(&state)?;
    let guard = JobGuard::begin(Some(&req.server_dir))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let mut emit = |p: PackProgress| {
            let _ = app.emit("cubicase-pack-progress", p);
        };
        run_export(&req, &CANCEL, &mut emit)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pack_read(pack_path: String) -> Result<PackInspectionView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let insp = inspect_pack(Path::new(&pack_path))?;
        Ok(PackInspectionView {
            total_bytes: insp.total_bytes,
            file_count: insp.file_count,
            archive_bytes: insp.archive_bytes,
            longest_path: insp.longest_rel,
            manifest: insp.manifest,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pack_import(app: tauri::AppHandle, req: ImportRequest) -> Result<ImportOutcome, String> {
    let guard = JobGuard::begin(None)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let mut emit = |p: PackProgress| {
            let _ = app.emit("cubicase-pack-progress", p);
        };
        run_import(&req, &CANCEL, &mut emit)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn pack_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Apaga pastas de importação interrompidas (app fechado no meio) — só as que o
/// próprio importador cria (`.cbi-<timestamp>`), e só quando nenhum job está ativo.
#[tauri::command]
pub fn pack_cleanup_stale(parent_dir: String) -> u32 {
    if JOB_ACTIVE.load(Ordering::SeqCst) {
        return 0;
    }
    let mut removed = 0;
    if let Ok(rd) = std::fs::read_dir(&parent_dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_ours = name
                .strip_prefix(STAGING_PREFIX)
                .map(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
                .unwrap_or(false);
            if is_ours && entry.path().is_dir() {
                remove_dir_with_retry(&entry.path());
                removed += 1;
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn req_for(server: &Path, dest: &Path, mode: &str) -> ExportRequest {
        ExportRequest {
            server_dir: server.to_string_lossy().to_string(),
            dest_path: dest.to_string_lossy().to_string(),
            mode: mode.to_string(),
            name: "meu".into(),
            meta: serde_json::json!({ "version": "1.20.1", "serverType": "vanilla" }),
            java_version: Some(21),
            jre_dir: None,
            include_player_lists: false,
            omit_mods: vec![],
            overwrite: false,
            app_version: "test".into(),
        }
    }

    fn make_server(tmp: &TempDir) -> PathBuf {
        let s = tmp.path().join("srv");
        fs::create_dir_all(s.join("world/region")).unwrap();
        fs::create_dir_all(s.join("mods")).unwrap();
        fs::create_dir_all(s.join("logs")).unwrap();
        fs::write(s.join("server.properties"), "level-name=world\nrcon.password=segredo\nmotd=oi\n").unwrap();
        fs::write(s.join("server.jar"), vec![7u8; 2048]).unwrap();
        fs::write(s.join("world/level.dat"), b"leveldata").unwrap();
        fs::write(s.join("world/session.lock"), b"lock").unwrap();
        fs::write(s.join("world/region/r.0.0.mca"), vec![1u8; 10_000]).unwrap();
        fs::write(s.join("mods/a.jar"), b"mod-a").unwrap();
        fs::write(s.join("mods/b.jar"), b"mod-b").unwrap();
        fs::write(s.join("logs/latest.log"), b"log").unwrap();
        fs::write(s.join("network_session.json"), b"{\"apiKey\":\"tskey-xxx\"}").unwrap();
        fs::write(s.join("usercache.json"), b"[]").unwrap();
        fs::write(s.join("ops.json"), b"[]").unwrap();
        fs::write(s.join("cubicase-meta.json"), b"{\"uuid\":\"u\"}").unwrap();
        s
    }

    fn make_fake_jre(tmp: &TempDir) -> PathBuf {
        let j = tmp.path().join("jre");
        fs::create_dir_all(j.join("bin")).unwrap();
        fs::write(j.join("bin/java.exe"), b"MZ").unwrap();
        fs::write(j.join(JRE_MARKER), b"ok").unwrap();
        j
    }

    fn export(req: &ExportRequest) -> Result<ExportOutcome, String> {
        run_export(req, &AtomicBool::new(false), &mut |_| {})
    }

    fn import(pack: &Path, parent: &Path, name: &str, jre_dest: Option<&Path>) -> Result<ImportOutcome, String> {
        let req = ImportRequest {
            pack_path: pack.to_string_lossy().to_string(),
            parent_dir: parent.to_string_lossy().to_string(),
            folder_name: name.to_string(),
            jre_dest: jre_dest.map(|p| p.to_string_lossy().to_string()),
        };
        run_import(&req, &AtomicBool::new(false), &mut |_| {})
    }

    fn zip_names(pack: &Path) -> Vec<String> {
        let mut ar = zip::ZipArchive::new(File::open(pack).unwrap()).unwrap();
        (0..ar.len()).map(|i| ar.by_index(i).unwrap().name().to_string()).collect()
    }

    // ---- validação de nomes ----

    #[test]
    fn entry_name_rejeita_zip_slip_e_nomes_perigosos() {
        for bad in [
            "../evil.txt", "a/../../evil", "/abs/file", "C:/Windows/x", "a\\b", "", "a//b", "./x",
            "con", "nul.txt", "COM1", "lpt9.log", "dir/trailing.", "dir/trailing ", "a:b", "x*y", "q?",
        ] {
            assert!(validate_entry_name(bad).is_err(), "deveria rejeitar {bad:?}");
        }
        for ok in ["world/region/r.0.0.mca", "mods/Some Mod-1.0+build.jar", "__jre/bin/java.exe", "dir/"] {
            assert!(validate_entry_name(ok).is_ok(), "deveria aceitar {ok:?}");
        }
        assert!(validate_entry_name("COM0").is_ok());
    }

    #[test]
    fn folder_name_valido_so_aceita_um_componente() {
        assert!(validate_folder_name("Meu Servidor").is_ok());
        assert!(validate_folder_name("  ").is_err());
        assert!(validate_folder_name("a/b").is_err());
        assert!(validate_folder_name("..").is_err());
        assert!(validate_folder_name("CON").is_err());
        assert!(validate_folder_name("termina.").is_err());
    }

    #[test]
    fn exclusoes_de_arquivos_e_pastas() {
        assert!(is_excluded_dir("logs") && is_excluded_dir("crash-reports") && is_excluded_dir(".restore_staging_123"));
        assert!(!is_excluded_dir("world") && !is_excluded_dir("config/logs"));
        for f in ["network_session.json", "usercache.json", "cubicase-meta.json", "world/session.lock", "x.tmp", "a.cubicase"] {
            assert!(is_excluded_file(f, true), "{f}");
        }
        assert!(is_excluded_file("ops.json", false) && !is_excluded_file("ops.json", true));
        assert!(!is_excluded_file("config/ops.json", false));
        assert!(!is_excluded_file("server.jar", false));
    }

    #[test]
    fn properties_perdem_a_senha_do_rcon() {
        let out = sanitize_properties("# c\nmotd=x\nrcon.password=abc\nRCON.PASSWORD = y\nserver-port=1\n");
        assert!(!out.contains("abc") && !out.contains("= y"));
        assert!(out.contains("rcon.password=\n") && out.contains("motd=x") && out.contains("server-port=1"));
    }

    // ---- exportar / importar ----

    #[test]
    fn roundtrip_modo_completo_inclui_jre_e_nao_vaza_dados() {
        let tmp = TempDir::new().unwrap();
        let server = make_server(&tmp);
        let jre = make_fake_jre(&tmp);
        let out_dir = tmp.path().join("out");
        fs::create_dir_all(&out_dir).unwrap();
        let dest = out_dir.join("meu.cubicase");

        let mut req = req_for(&server, &dest, "full");
        req.jre_dir = Some(jre.to_string_lossy().to_string());
        let outcome = export(&req).unwrap();
        assert!(dest.is_file() && !out_dir.join("meu.cubicase.tmp").exists());
        assert!(outcome.size_bytes > 0);

        let names = zip_names(&dest);
        assert_eq!(names[0], MANIFEST_NAME, "manifesto deve ser a primeira entrada");
        for must in ["server.jar", "server.properties", "world/level.dat", "world/region/r.0.0.mca", "mods/a.jar", "mods/b.jar", "__jre/bin/java.exe"] {
            assert!(names.iter().any(|n| n == must), "faltou {must}");
        }
        for never in ["network_session.json", "usercache.json", "ops.json", "cubicase-meta.json", "world/session.lock", "logs/latest.log"] {
            assert!(!names.iter().any(|n| n == never), "não deveria conter {never}");
        }

        let parent = tmp.path().join("servers");
        let jre_dest = tmp.path().join("runtime").join("java-21");
        let res = import(&dest, &parent, "Importado", Some(&jre_dest)).unwrap();
        let imported = PathBuf::from(&res.server_path);
        assert_eq!(fs::read(imported.join("server.jar")).unwrap(), vec![7u8; 2048]);
        assert_eq!(fs::read(imported.join("world/region/r.0.0.mca")).unwrap(), vec![1u8; 10_000]);
        let props = fs::read_to_string(imported.join("server.properties")).unwrap();
        assert!(!props.contains("segredo") && props.contains("motd=oi"));
        assert!(!imported.join("__jre").exists(), "o JRE não pode ficar dentro da pasta do servidor");
        assert!(res.jre_installed && jre_dest.join("bin/java.exe").is_file() && jre_dest.join(JRE_MARKER).is_file());
        assert!(!parent.read_dir().unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with(STAGING_PREFIX)));
        assert_eq!(res.manifest.mode, "full");
        assert_eq!(res.manifest.java_version, Some(21));
        assert!(res.manifest.includes_jre);
    }

    #[test]
    fn modo_leve_omite_mods_listados_e_nao_leva_jre() {
        let tmp = TempDir::new().unwrap();
        let server = make_server(&tmp);
        let jre = make_fake_jre(&tmp);
        let dest = tmp.path().join("leve.cubicase");

        let mut req = req_for(&server, &dest, "light");
        req.jre_dir = Some(jre.to_string_lossy().to_string()); // ignorado no modo leve
        req.omit_mods = vec![OmittedMod { filename: "a.jar".into(), sha1: "abc".into(), url: "https://cdn/a.jar".into(), size_bytes: 5 }];
        let outcome = export(&req).unwrap();
        assert!(outcome.file_count > 0);

        let names = zip_names(&dest);
        assert!(!names.iter().any(|n| n == "mods/a.jar"));
        assert!(names.iter().any(|n| n == "mods/b.jar"));
        assert!(!names.iter().any(|n| n.starts_with("__jre")));

        let view = inspect_pack(&dest).unwrap();
        assert_eq!(view.manifest.omitted_mods.len(), 1);
        assert_eq!(view.manifest.omitted_mods[0].sha1, "abc");
        assert!(!view.manifest.includes_jre && view.manifest.java_version.is_none());
    }

    #[test]
    fn lista_de_jogadores_so_entra_se_pedido() {
        let tmp = TempDir::new().unwrap();
        let server = make_server(&tmp);
        let dest = tmp.path().join("p.cubicase");
        let mut req = req_for(&server, &dest, "light");
        req.include_player_lists = true;
        export(&req).unwrap();
        assert!(zip_names(&dest).iter().any(|n| n == "ops.json"));
    }

    #[test]
    fn completo_sem_jre_e_jre_incompleto_sao_recusados() {
        let tmp = TempDir::new().unwrap();
        let server = make_server(&tmp);
        let dest = tmp.path().join("x.cubicase");
        let mut req = req_for(&server, &dest, "full");
        assert!(export(&req).is_err());
        let bad_jre = tmp.path().join("badjre");
        fs::create_dir_all(bad_jre.join("bin")).unwrap();
        req.jre_dir = Some(bad_jre.to_string_lossy().to_string());
        assert!(export(&req).is_err());
        assert!(!dest.exists() && !tmp.path().join("x.cubicase.tmp").exists());
    }

    #[test]
    fn export_recusa_destino_dentro_do_servidor_extensao_errada_e_sobrescrita_silenciosa() {
        let tmp = TempDir::new().unwrap();
        let server = make_server(&tmp);

        let inside = server.join("x.cubicase");
        assert!(export(&req_for(&server, &inside, "light")).unwrap_err().len() > 0);
        assert!(!inside.exists());

        let wrong_ext = tmp.path().join("x.zip");
        assert!(export(&req_for(&server, &wrong_ext, "light")).is_err());

        let missing_folder = tmp.path().join("nao-existe").join("x.cubicase");
        assert!(export(&req_for(&server, &missing_folder, "light")).is_err());

        let dest = tmp.path().join("ok.cubicase");
        fs::write(&dest, b"antigo").unwrap();
        assert!(export(&req_for(&server, &dest, "light")).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"antigo", "arquivo existente não pode ser tocado");
        let mut req = req_for(&server, &dest, "light");
        req.overwrite = true;
        export(&req).unwrap();
        assert!(inspect_pack(&dest).is_ok());
    }

    #[test]
    fn export_cancelado_nao_deixa_tmp_nem_destino() {
        let tmp = TempDir::new().unwrap();
        let server = make_server(&tmp);
        let dest = tmp.path().join("c.cubicase");
        let cancel = AtomicBool::new(true);
        let err = run_export(&req_for(&server, &dest, "light"), &cancel, &mut |_| {}).unwrap_err();
        assert_eq!(err, tr!("pack.cancelled"));
        assert!(!dest.exists() && !tmp.path().join("c.cubicase.tmp").exists());
    }

    #[test]
    fn export_com_destino_de_caminho_longo_e_recusado_antes_de_escrever() {
        let tmp = TempDir::new().unwrap();
        let server = make_server(&tmp);
        let long = tmp.path().join(format!("{}.cubicase", "a".repeat(260)));
        let err = export(&req_for(&server, &long, "light")).unwrap_err();
        assert!(!err.is_empty());
        assert!(!long.exists());
    }

    #[test]
    fn preflight_reporta_problemas_sem_escrever_nada() {
        let tmp = TempDir::new().unwrap();
        let server = make_server(&tmp);
        let inside = server.join("x.cubicase");
        let res = run_preflight(&req_for(&server, &inside, "light"), None);
        assert!(res.problems.iter().any(|p| p.code == "destInsideServer"));

        let dest = tmp.path().join("ok.cubicase");
        let res = run_preflight(&req_for(&server, &dest, "light"), None);
        assert!(res.problems.is_empty(), "{:?}", res.problems);
        assert!(res.file_count > 0 && res.total_bytes > 0 && res.has_world && !res.dest_exists);

        let res = run_preflight(&req_for(&server, &dest, "light"), Some("ligado".into()));
        assert!(res.problems.iter().any(|p| p.code == "serverRunning"));

        let res = run_preflight(&req_for(&server, &dest, "full"), None);
        assert!(res.problems.iter().any(|p| p.code == "jreRequired"));
        assert!(!dest.exists());
    }

    #[test]
    fn pendencia_de_mods_so_conta_com_lista_nao_vazia() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        assert!(!has_pending_mods(&dir));
        fs::write(tmp.path().join("cubicase-pending.json"), "lixo").unwrap();
        assert!(!has_pending_mods(&dir));
        fs::write(tmp.path().join("cubicase-pending.json"), r#"{"version":1,"mods":[]}"#).unwrap();
        assert!(!has_pending_mods(&dir));
        fs::write(tmp.path().join("cubicase-pending.json"), r#"{"version":1,"mods":[{"filename":"a.jar"}]}"#).unwrap();
        assert!(has_pending_mods(&dir));
    }

    #[test]
    fn exportar_nunca_leva_o_arquivo_de_pendencias() {
        assert!(is_excluded_file("cubicase-pending.json", true));
    }

    #[test]
    fn trava_de_export_bloqueia_o_inicio_do_servidor() {
        let dir = "C:\\Teste\\ServidorTravado";
        assert!(!export_in_progress_for(dir));
        {
            // Sem usar JOB_ACTIVE global para não interferir nos outros testes.
            EXPORTING_DIRS.lock().unwrap().push(norm_path(dir));
            assert!(export_in_progress_for("c:/teste/servidortravado/"));
            EXPORTING_DIRS.lock().unwrap().retain(|d| *d != norm_path(dir));
        }
        assert!(!export_in_progress_for(dir));
    }

    // ---- importação hostil ----

    fn craft_zip(path: &Path, entries: &[(&str, &[u8])], manifest: Option<&PackManifest>) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        if let Some(m) = manifest {
            zip.start_file(MANIFEST_NAME, opts).unwrap();
            zip.write_all(&serde_json::to_vec(m).unwrap()).unwrap();
        }
        for (name, data) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    fn manifest_for(files: u64, bytes: u64) -> PackManifest {
        PackManifest {
            format_version: PACK_FORMAT_VERSION,
            kind: PACK_KIND.into(),
            mode: "light".into(),
            name: "x".into(),
            created_at: "now".into(),
            app_version: "t".into(),
            meta: serde_json::Value::Null,
            java_version: None,
            includes_jre: false,
            includes_player_lists: false,
            file_count: files,
            total_bytes: bytes,
            omitted_mods: vec![],
        }
    }

    #[test]
    fn import_rejeita_zip_slip_e_nao_escreve_fora_da_pasta() {
        let tmp = TempDir::new().unwrap();
        let pack = tmp.path().join("evil.cubicase");
        craft_zip(&pack, &[("../evil.txt", b"x")], Some(&manifest_for(1, 1)));
        let parent = tmp.path().join("servers");
        assert!(import(&pack, &parent, "S", None).is_err());
        assert!(!tmp.path().join("evil.txt").exists() && !parent.join("evil.txt").exists());
        assert!(!parent.join("S").exists());
        assert_eq!(parent.read_dir().map(|d| d.count()).unwrap_or(0), 0, "staging deve ser limpo");
    }

    #[test]
    fn import_rejeita_nomes_reservados_absolutos_e_duplicados() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("servers");
        for (i, name) in ["con", "C:/x", "/etc/passwd", "a\\b"].iter().enumerate() {
            let pack = tmp.path().join(format!("p{i}.cubicase"));
            craft_zip(&pack, &[(name, b"x")], Some(&manifest_for(1, 1)));
            assert!(import(&pack, &parent, "S", None).is_err(), "{name}");
        }
        let dup = tmp.path().join("dup.cubicase");
        craft_zip(&dup, &[("a.txt", b"x"), ("A.TXT", b"y")], Some(&manifest_for(2, 2)));
        assert!(import(&dup, &parent, "S", None).is_err());
    }

    #[test]
    fn import_rejeita_manifesto_ausente_divergente_ou_de_versao_futura() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("servers");

        let no_manifest = tmp.path().join("a.cubicase");
        craft_zip(&no_manifest, &[("a.txt", b"x")], None);
        assert!(import(&no_manifest, &parent, "S", None).is_err());

        let mismatch = tmp.path().join("b.cubicase");
        craft_zip(&mismatch, &[("a.txt", b"x")], Some(&manifest_for(1, 999)));
        assert!(import(&mismatch, &parent, "S", None).is_err());

        let mut future = manifest_for(1, 1);
        future.format_version = PACK_FORMAT_VERSION + 1;
        let fut = tmp.path().join("c.cubicase");
        craft_zip(&fut, &[("a.txt", b"x")], Some(&future));
        assert_eq!(import(&fut, &parent, "S", None).unwrap_err(), tr!("pack.err.newerFormat"));

        let mut wrong_kind = manifest_for(1, 1);
        wrong_kind.kind = "outra-coisa".into();
        let wk = tmp.path().join("d.cubicase");
        craft_zip(&wk, &[("a.txt", b"x")], Some(&wrong_kind));
        assert!(import(&wk, &parent, "S", None).is_err());

        let not_zip = tmp.path().join("e.cubicase");
        fs::write(&not_zip, b"isto nao e um zip").unwrap();
        assert!(import(&not_zip, &parent, "S", None).is_err());
        assert!(!parent.join("S").exists());
    }

    #[test]
    fn import_recusa_nome_existente_nome_invalido_e_caminho_longo() {
        let tmp = TempDir::new().unwrap();
        let server = make_server(&tmp);
        let dest = tmp.path().join("p.cubicase");
        export(&req_for(&server, &dest, "light")).unwrap();
        let parent = tmp.path().join("servers");

        import(&dest, &parent, "Um", None).unwrap();
        let err = import(&dest, &parent, "Um", None).unwrap_err();
        assert_eq!(err, tr!("pack.err.nameExists", name = "Um"));
        assert!(import(&dest, &parent, "a/b", None).is_err());
        assert!(import(&dest, &parent, "  ", None).is_err());

        let too_long = "n".repeat(250);
        let err = import(&dest, &parent, &too_long, None).unwrap_err();
        assert!(err.contains("240"), "{err}");
        assert!(!parent.join(&too_long).exists());
    }

    #[test]
    fn import_nao_falha_quando_o_jre_nao_pode_ser_instalado() {
        let tmp = TempDir::new().unwrap();
        let server = make_server(&tmp);
        let jre = make_fake_jre(&tmp);
        let dest = tmp.path().join("full.cubicase");
        let mut req = req_for(&server, &dest, "full");
        req.jre_dir = Some(jre.to_string_lossy().to_string());
        export(&req).unwrap();

        let parent = tmp.path().join("servers");
        // destino do JRE impossível: um ARQUIVO no lugar da pasta "runtime"
        let blocker = tmp.path().join("runtime");
        fs::write(&blocker, b"arquivo").unwrap();
        let res = import(&dest, &parent, "S", Some(&blocker.join("java-21"))).unwrap();
        assert!(!res.jre_installed && res.jre_warning.is_some());
        assert!(PathBuf::from(&res.server_path).join("server.jar").is_file());
        assert!(!PathBuf::from(&res.server_path).join("__jre").exists());
    }

    #[test]
    fn import_mantem_jre_ja_instalado_e_limpa_instalacao_incompleta() {
        let tmp = TempDir::new().unwrap();
        let server = make_server(&tmp);
        let jre = make_fake_jre(&tmp);
        let dest = tmp.path().join("full.cubicase");
        let mut req = req_for(&server, &dest, "full");
        req.jre_dir = Some(jre.to_string_lossy().to_string());
        export(&req).unwrap();
        let parent = tmp.path().join("servers");

        let installed = tmp.path().join("rt-ok");
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join("keep.txt"), b"k").unwrap();
        fs::write(installed.join(JRE_MARKER), b"ok").unwrap();
        import(&dest, &parent, "A", Some(&installed)).unwrap();
        assert!(installed.join("keep.txt").is_file(), "JRE completo já instalado não deve ser substituído");

        let partial = tmp.path().join("rt-partial");
        fs::create_dir_all(&partial).unwrap();
        fs::write(partial.join("lixo.txt"), b"l").unwrap();
        let res = import(&dest, &parent, "B", Some(&partial)).unwrap();
        assert!(res.jre_installed && !partial.join("lixo.txt").exists() && partial.join(JRE_MARKER).is_file());
    }

    #[test]
    fn import_cancelado_limpa_a_pasta_temporaria() {
        let tmp = TempDir::new().unwrap();
        let server = make_server(&tmp);
        let dest = tmp.path().join("p.cubicase");
        export(&req_for(&server, &dest, "light")).unwrap();
        let parent = tmp.path().join("servers");
        let req = ImportRequest {
            pack_path: dest.to_string_lossy().to_string(),
            parent_dir: parent.to_string_lossy().to_string(),
            folder_name: "S".into(),
            jre_dest: None,
        };
        let err = run_import(&req, &AtomicBool::new(true), &mut |_| {}).unwrap_err();
        assert_eq!(err, tr!("pack.cancelled"));
        assert_eq!(parent.read_dir().unwrap().count(), 0);
    }

    #[test]
    fn cleanup_remove_so_pastas_de_staging_do_importador() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".cbi-1759200000000/x")).unwrap();
        fs::create_dir_all(tmp.path().join(".cbi-abc")).unwrap();
        fs::create_dir_all(tmp.path().join("Meu Servidor")).unwrap();
        let removed = pack_cleanup_stale(tmp.path().to_string_lossy().to_string());
        assert_eq!(removed, 1);
        assert!(!tmp.path().join(".cbi-1759200000000").exists());
        assert!(tmp.path().join(".cbi-abc").exists() && tmp.path().join("Meu Servidor").exists());
    }
}
