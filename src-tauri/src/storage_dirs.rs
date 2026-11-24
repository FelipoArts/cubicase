//! Onde ficam os servidores (e, por padrão, os backups) criados pelo Cubicase.
//!
//! Antes, o caminho `Documentos\CubicaseServers` estava repetido por todo o código. Documentos é uma
//! pasta problemática para guardar mundos de Minecraft: o "Acesso controlado a pastas" do Windows
//! (proteção contra ransomware) pode bloquear a gravação, e quem usa o OneDrive com backup das pastas
//! tem Documentos sincronizado na nuvem (mundos que mudam o tempo todo, arquivos travados).
//!
//! Regra:
//! - **Quem já usa o Cubicase continua onde está.** Se `Documentos\CubicaseServers` existe, essa continua
//!   sendo a pasta de servidores — nada é movido sem a pessoa pedir.
//! - **Instalações novas** usam `C:\Users\<você>\Cubicase\Servers` (e `...\Cubicase\Backups`): fora das pastas
//!   protegidas, fora do OneDrive, visível e fora da pasta de dados do app (que o desinstalador pode apagar).
//!
//! A decisão é tomada uma vez e gravada em `storage_settings.json` (pasta de dados do app), para não
//! mudar sozinha depois. Este módulo é a ÚNICA fonte da pasta de servidores: o frontend a pede por
//! `get_servers_root`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "storage_settings.json";
const LEGACY_SERVERS: &str = "CubicaseServers";
const LEGACY_BACKUPS: &str = "CubicaseBackups";

#[derive(Serialize, Deserialize, Default, Clone)]
struct Stored {
    /// Pasta de servidores decidida no primeiro uso.
    #[serde(default)]
    servers_root: Option<String>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join(SETTINGS_FILE))
}

fn read_stored(app: &AppHandle) -> Stored {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_stored(app: &AppHandle, stored: &Stored) {
    let Some(path) = settings_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(stored) {
        let _ = std::fs::write(path, json);
    }
}

/// `C:\Users\<você>\Cubicase` — a raiz das pastas novas.
pub fn home_root() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("Cubicase"))
}

fn legacy_docs(app: &AppHandle) -> Option<PathBuf> {
    app.path().document_dir().ok()
}

fn is_plain_absolute(p: &Path) -> bool {
    p.is_absolute() && !p.components().any(|c| matches!(c, std::path::Component::ParentDir))
}

/// Decisão pura (testável): mantém a pasta antiga se ela já existe; senão usa a nova na pasta do usuário;
/// sem pasta de usuário (improvável), cai na antiga.
pub(crate) fn decide_root(legacy: Option<PathBuf>, legacy_exists: bool, new_root: Option<PathBuf>) -> Option<PathBuf> {
    if legacy_exists {
        return legacy;
    }
    new_root.or(legacy)
}

/// Pasta onde ficam os servidores criados pelo Cubicase.
pub fn servers_root(app: &AppHandle) -> PathBuf {
    let mut stored = read_stored(app);
    if let Some(p) = stored.servers_root.as_deref().map(PathBuf::from).filter(|p| is_plain_absolute(p)) {
        return p;
    }
    let legacy = legacy_docs(app).map(|d| d.join(LEGACY_SERVERS));
    let exists = legacy.as_deref().map(Path::is_dir).unwrap_or(false);
    let chosen = decide_root(legacy, exists, home_root().map(|r| r.join("Servers")))
        .unwrap_or_else(|| PathBuf::from(".").join("CubicaseServers"));
    stored.servers_root = Some(chosen.to_string_lossy().to_string());
    write_stored(app, &stored);
    chosen
}

/// Pasta padrão dos backups: a antiga (Documentos) se ela já existe; senão `...\Cubicase\Backups`.
pub fn default_backups_root(app: &AppHandle) -> PathBuf {
    let legacy = legacy_docs(app).map(|d| d.join(LEGACY_BACKUPS));
    let exists = legacy.as_deref().map(Path::is_dir).unwrap_or(false);
    decide_root(legacy, exists, home_root().map(|r| r.join("Backups"))).unwrap_or_else(|| PathBuf::from(".").join(LEGACY_BACKUPS))
}

/// Pastas que não podem ser tratadas como "um servidor" (são contêineres): as de servidores e de backups,
/// antigas e novas.
pub fn container_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = vec![servers_root(app)];
    if let Some(docs) = legacy_docs(app) {
        out.push(docs.join(LEGACY_SERVERS));
    }
    out
}

/// Pasta de servidores, para o frontend (única fonte do caminho). Não cria a pasta.
#[tauri::command]
pub fn get_servers_root(app: AppHandle) -> String {
    servers_root(&app).to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instalacao_nova_usa_a_pasta_do_usuario() {
        let legacy = Some(PathBuf::from(r"C:\Users\x\Documents\CubicaseServers"));
        let novo = Some(PathBuf::from(r"C:\Users\x\Cubicase\Servers"));
        assert_eq!(decide_root(legacy, false, novo.clone()), novo);
    }

    #[test]
    fn quem_ja_tem_a_pasta_antiga_continua_nela() {
        let legacy = Some(PathBuf::from(r"C:\Users\x\Documents\CubicaseServers"));
        let novo = Some(PathBuf::from(r"C:\Users\x\Cubicase\Servers"));
        assert_eq!(decide_root(legacy.clone(), true, novo), legacy);
    }

    #[test]
    fn sem_pasta_de_usuario_cai_na_antiga() {
        let legacy = Some(PathBuf::from(r"C:\Users\x\Documents\CubicaseServers"));
        assert_eq!(decide_root(legacy.clone(), false, None), legacy);
    }
}
