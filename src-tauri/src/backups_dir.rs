//! Pasta onde ficam os backups do mundo.
//!
//! Por padrão é `Documentos/CubicaseBackups`; a pessoa pode escolher outra (um HD maior, uma pasta fora do OneDrive).
//! A escolha fica em `backup_settings.json` na pasta de dados do app, e não só no front: o Rust também precisa dela
//! (o backup pedido pelo painel web ou pelo Discord roda sem passar pela interface). Cada servidor ganha uma subpasta
//! com o nome dele dentro da pasta escolhida.
//!
//! Mudar a pasta NÃO move os backups que já existem: eles continuam onde estavam (o app avisa e oferece abrir a pasta
//! anterior). Mover centenas de MB sem a pessoa pedir seria arriscado e demorado.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::tr;

const SETTINGS_FILE: &str = "backup_settings.json";

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
struct Stored {
    /// Pasta escolhida (None = a padrão).
    root: Option<String>,
    /// Pasta que valia antes da última troca, para o app poder apontar onde ficaram os backups antigos.
    previous: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupsSettings {
    pub path: String,
    pub default_path: String,
    pub is_custom: bool,
    /// Pasta anterior, só se ainda existir.
    pub previous: Option<String>,
    /// A pasta atual existe agora (um HD externo desconectado, por exemplo, faz isto ser false).
    pub available: bool,
}

pub fn default_root(app: &AppHandle) -> PathBuf {
    app.path().document_dir().unwrap_or_else(|_| PathBuf::from(".")).join("CubicaseBackups")
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

fn write_stored(app: &AppHandle, stored: &Stored) -> Result<(), String> {
    let path = settings_path(app).ok_or_else(|| "pasta de dados indisponível".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn is_plain_absolute(p: &Path) -> bool {
    p.is_absolute() && !p.components().any(|c| matches!(c, std::path::Component::ParentDir))
}

fn valid_stored_root(stored: &Stored) -> Option<PathBuf> {
    let raw = stored.root.as_deref()?.trim();
    let path = PathBuf::from(raw);
    (!raw.is_empty() && is_plain_absolute(&path)).then_some(path)
}

/// Pasta de backups em uso agora (a escolhida, ou a padrão se não houver escolha válida).
pub fn current_root(app: &AppHandle) -> PathBuf {
    valid_stored_root(&read_stored(app)).unwrap_or_else(|| default_root(app))
}

fn describe(app: &AppHandle, stored: &Stored) -> BackupsSettings {
    let custom = valid_stored_root(stored);
    let path = custom.clone().unwrap_or_else(|| default_root(app));
    BackupsSettings {
        available: path.is_dir() || (custom.is_none()),
        path: path.to_string_lossy().to_string(),
        default_path: default_root(app).to_string_lossy().to_string(),
        is_custom: custom.is_some(),
        previous: stored.previous.clone().filter(|p| Path::new(p).is_dir()),
    }
}

/// Comparação de caminhos sem diferenciar maiúsculas (Windows) nem o tipo de barra, ignorando barra final.
fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\");
    let s = s.trim_end_matches('\\').to_string();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

fn is_inside(child: &Path, parent: &Path) -> bool {
    let (c, p) = (norm(child), norm(parent));
    !p.is_empty() && (c == p || c.starts_with(&format!("{p}\\")))
}

/// Confere se `candidate` serve como pasta de backups: caminho completo, não é um disco inteiro, não fica dentro de
/// nenhuma pasta de servidor (apagar o servidor apagaria os backups junto) e dá para gravar nela. Cria a pasta.
pub fn validate_root(candidate: &Path, forbidden_inside: &[PathBuf]) -> Result<(), String> {
    if !is_plain_absolute(candidate) {
        return Err(tr!("backupsDir.notAbsolute"));
    }
    if candidate.parent().is_none() {
        return Err(tr!("backupsDir.driveRoot"));
    }
    if forbidden_inside.iter().any(|f| is_inside(candidate, f)) {
        return Err(tr!("backupsDir.insideServers"));
    }
    std::fs::create_dir_all(candidate).map_err(|e| tr!("backupsDir.notWritable", error = e))?;
    if !candidate.is_dir() {
        return Err(tr!("backupsDir.notAbsolute"));
    }
    // Um arquivo de teste: criar a pasta não prova que dá para escrever nela (pasta somente leitura, sem permissão).
    let probe = candidate.join(format!(".cubicase-escrita-{}", std::process::id()));
    std::fs::write(&probe, b"ok").map_err(|e| tr!("backupsDir.notWritable", error = e))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Pastas que nunca podem conter os backups: a de servidores e as dos servidores importados.
fn forbidden_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(docs) = app.path().document_dir() {
        out.push(docs.join("CubicaseServers"));
    }
    out.extend(crate::panel_agent::load_imported_server_paths(app).into_iter().map(PathBuf::from));
    out
}

#[tauri::command]
pub fn get_backups_settings(app: AppHandle) -> BackupsSettings {
    describe(&app, &read_stored(&app))
}

/// Troca a pasta de backups (`None` volta para a padrão). Os backups que já existem não são movidos.
#[tauri::command]
pub fn set_backups_root(app: AppHandle, path: Option<String>) -> Result<BackupsSettings, String> {
    let before = current_root(&app);
    let old = read_stored(&app);
    let next = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => {
            let candidate = PathBuf::from(p);
            validate_root(&candidate, &forbidden_roots(&app))?;
            let same = norm(&candidate) == norm(&before);
            Stored { root: Some(candidate.to_string_lossy().to_string()), previous: if same { old.previous } else { Some(before.to_string_lossy().to_string()) } }
        }
        None => {
            let same = norm(&default_root(&app)) == norm(&before);
            Stored { root: None, previous: if same { old.previous } else { Some(before.to_string_lossy().to_string()) } }
        }
    };
    write_stored(&app, &next)?;
    Ok(describe(&app, &next))
}

/// Nome de pasta simples: sem separadores nem "..". Vem do nome do servidor, que a interface já valida; aqui é a segunda barreira.
fn plain_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', ':']) && Path::new(name).file_name().map(|n| n == name).unwrap_or(false)
}

/// Quando um servidor é renomeado, a subpasta dos backups dele acompanha o nome novo. Devolve se havia o que mover.
#[tauri::command]
pub fn rename_server_backups(app: AppHandle, old_name: String, new_name: String) -> Result<bool, String> {
    if !plain_name(&old_name) || !plain_name(&new_name) {
        return Err(tr!("backupsDir.notAbsolute"));
    }
    move_server_backups(&current_root(&app), &old_name, &new_name)
}

fn move_server_backups(root: &Path, old_name: &str, new_name: &str) -> Result<bool, String> {
    let (from, to) = (root.join(old_name), root.join(new_name));
    if !from.is_dir() {
        return Ok(false);
    }
    if to.exists() {
        return Err(tr!("backupsDir.targetExists", name = new_name));
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aceita_pasta_nova_e_cria_o_caminho() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("a").join("b");
        assert!(validate_root(&target, &[]).is_ok());
        assert!(target.is_dir());
        assert!(std::fs::read_dir(&target).unwrap().next().is_none(), "o arquivo de teste não pode sobrar");
    }

    #[test]
    fn recusa_caminho_relativo_ou_com_ponto_ponto() {
        assert!(validate_root(Path::new("backups"), &[]).is_err());
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_root(&tmp.path().join("..").join("x"), &[]).is_err());
    }

    #[test]
    fn recusa_a_raiz_do_disco() {
        let root = tempfile::tempdir().unwrap().path().ancestors().last().unwrap().to_path_buf();
        assert!(validate_root(&root, &[]).is_err());
    }

    #[test]
    fn recusa_pasta_dentro_de_servidor_sem_criar_nada() {
        let tmp = tempfile::tempdir().unwrap();
        let servers = tmp.path().join("CubicaseServers");
        let inside = servers.join("Kukusen").join("backups");
        assert!(validate_root(&inside, &[servers.clone()]).is_err());
        assert!(validate_root(&servers, &[servers.clone()]).is_err());
        assert!(!servers.exists(), "não pode criar pasta dentro da área proibida");
        // vizinha com nome parecido não conta como "dentro"
        assert!(validate_root(&tmp.path().join("CubicaseServers-extra"), &[servers]).is_ok());
    }

    #[test]
    fn recusa_quando_o_caminho_e_um_arquivo() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("arquivo.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(validate_root(&file, &[]).is_err());
    }

    #[test]
    fn comparacao_ignora_barra_final_e_maiusculas_no_windows() {
        assert!(is_inside(Path::new("/a/b/"), Path::new("/a/b")));
        assert!(is_inside(Path::new("/a/b/c"), Path::new("/a/b")));
        assert!(!is_inside(Path::new("/a/bc"), Path::new("/a/b")));
        if cfg!(windows) {
            assert!(is_inside(Path::new(r"C:\Docs\CubicaseServers\X"), Path::new(r"c:\docs\cubicaseservers")));
        }
    }

    #[test]
    fn nome_de_servidor_nao_escapa_da_pasta() {
        for ok in ["Kukusen", "Meu Servidor", "mundo-1"] {
            assert!(plain_name(ok), "{ok}");
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "..\\x", "C:", "C:\\x"] {
            assert!(!plain_name(bad), "{bad}");
        }
    }

    #[test]
    fn renomear_move_a_subpasta_dos_backups() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("Velho")).unwrap();
        std::fs::write(tmp.path().join("Velho").join("w.zip"), "z").unwrap();
        assert_eq!(move_server_backups(tmp.path(), "Velho", "Novo"), Ok(true));
        assert!(tmp.path().join("Novo").join("w.zip").is_file());
        assert!(!tmp.path().join("Velho").exists());
        // sem subpasta: nada a mover
        assert_eq!(move_server_backups(tmp.path(), "Fantasma", "Outro"), Ok(false));
    }

    #[test]
    fn renomear_nao_sobrescreve_backups_de_outro_servidor() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("A")).unwrap();
        std::fs::create_dir_all(tmp.path().join("B")).unwrap();
        assert!(move_server_backups(tmp.path(), "A", "B").is_err());
        assert!(tmp.path().join("A").is_dir());
    }

    #[test]
    fn escolha_invalida_guardada_cai_na_padrao() {
        let relative = Stored { root: Some("backups".into()), previous: None };
        assert!(valid_stored_root(&relative).is_none());
        assert!(valid_stored_root(&Stored { root: Some("  ".into()), previous: None }).is_none());
        assert!(valid_stored_root(&Stored::default()).is_none());
        let tmp = tempfile::tempdir().unwrap();
        let ok = Stored { root: Some(tmp.path().to_string_lossy().to_string()), previous: None };
        assert_eq!(valid_stored_root(&ok), Some(tmp.path().to_path_buf()));
    }
}
