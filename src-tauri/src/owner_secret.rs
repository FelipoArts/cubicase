//! Segredo de dono dos servidores registrados na API Central.
//!
//! O shortCode é público (todo convidado o conhece), então ele não pode ser a
//! credencial das ações de dono (apagar, renomear, regenerar código,
//! heartbeat, hospedar). Cada servidor tem um segredo aleatório, gerado aqui,
//! enviado no header `X-Owner-Secret`; a API guarda só o hash (ver
//! `requireOwner` em api/src/index.ts).
//!
//! Onde fica: o mapa `shortCode -> segredo` mora em `owner_secrets.json` no
//! AppData e é espelhado no `cubicase-meta.json` da pasta do servidor (campo
//! `ownerSecret`). O espelho faz o segredo acompanhar o servidor ao reinstalar
//! o app ou mover a pasta para outro PC — sem ele, o dono ficaria trancado
//! para fora do próprio servidor.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rand::distributions::Alphanumeric;
use rand::Rng;

struct Store {
    path: Option<PathBuf>,
    map: HashMap<String, String>,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();

fn store() -> &'static Mutex<Store> {
    STORE.get_or_init(|| Mutex::new(Store { path: None, map: HashMap::new() }))
}

fn norm(code: &str) -> String {
    code.trim().to_uppercase()
}

/// Segredo novo: 32 caracteres alfanuméricos (≈190 bits), dentro do formato
/// aceito pela API (`[A-Za-z0-9_-]{24,128}`).
pub fn generate() -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(32).map(char::from).collect()
}

fn persist(s: &Store) {
    let Some(path) = &s.path else { return };
    let Ok(json) = serde_json::to_string(&s.map) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Carrega o mapa do disco. Chamar uma vez na inicialização do app.
pub fn init(data_dir: &Path) {
    let _ = std::fs::create_dir_all(data_dir);
    let path = data_dir.join("owner_secrets.json");
    let map = std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str::<HashMap<String, String>>(&c).ok())
        .unwrap_or_default();
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    s.path = Some(path);
    s.map = map;
}

pub fn get(code: &str) -> Option<String> {
    store().lock().unwrap_or_else(|e| e.into_inner()).map.get(&norm(code)).cloned()
}

/// Segredo do servidor, criando (e gravando) um se ainda não existir.
pub fn get_or_create(code: &str) -> String {
    let key = norm(code);
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = s.map.get(&key) {
        return v.clone();
    }
    let secret = generate();
    s.map.insert(key, secret.clone());
    persist(&s);
    secret
}

pub fn set(code: &str, secret: &str) {
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    s.map.insert(norm(code), secret.to_string());
    persist(&s);
}

pub fn remove(code: &str) {
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    if s.map.remove(&norm(code)).is_some() {
        persist(&s);
    }
}

fn valid(secret: &str) -> bool {
    (24..=128).contains(&secret.len())
        && secret.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Reconcilia o segredo de `code` com o `cubicase-meta.json` da pasta do
/// servidor: se a pasta já traz um (veio de outro PC/instalação), ele vale;
/// senão grava ali o do mapa local (criando um, se preciso).
pub fn sync_with_meta(code: &str, server_dir: &str) {
    let meta_path = Path::new(server_dir).join("cubicase-meta.json");
    let Ok(raw) = std::fs::read_to_string(&meta_path) else { return };
    let Ok(mut meta) = serde_json::from_str::<serde_json::Value>(&raw) else { return };
    let Some(obj) = meta.as_object_mut() else { return };

    let in_meta = obj.get("ownerSecret").and_then(|v| v.as_str()).filter(|v| valid(v)).map(|v| v.to_string());
    match in_meta {
        Some(secret) => {
            if get(code).as_deref() != Some(secret.as_str()) {
                set(code, &secret);
            }
        }
        None => {
            let secret = get_or_create(code);
            obj.insert("ownerSecret".to_string(), serde_json::Value::String(secret));
            if let Ok(out) = serde_json::to_string_pretty(&meta) {
                let tmp = meta_path.with_extension("json.tmp");
                if std::fs::write(&tmp, out).is_ok() && std::fs::rename(&tmp, &meta_path).is_err() {
                    let _ = std::fs::remove_file(&tmp);
                }
            }
        }
    }
}

/// Depois de a API ter emitido um código novo (a propriedade do antigo não
/// pôde ser provada): guarda o segredo novo e grava código + segredo no
/// `cubicase-meta.json`, preservando o resto do arquivo.
pub fn adopt_rotated(old_code: &str, new_code: &str, secret: &str, server_dir: &str) {
    set(new_code, secret);
    remove(old_code);
    let meta_path = Path::new(server_dir).join("cubicase-meta.json");
    let mut meta = std::fs::read_to_string(&meta_path)
        .ok()
        .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = meta.as_object_mut() {
        obj.insert("shortCode".to_string(), serde_json::Value::String(new_code.to_string()));
        obj.insert("ownerSecret".to_string(), serde_json::Value::String(secret.to_string()));
        if let Ok(out) = serde_json::to_string_pretty(&meta) {
            let tmp = meta_path.with_extension("json.tmp");
            if std::fs::write(&tmp, out).is_ok() && std::fs::rename(&tmp, &meta_path).is_err() {
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_secret_matches_api_format() {
        let s = generate();
        assert!(valid(&s));
        assert_ne!(s, generate());
    }

    #[test]
    fn adopt_rotated_moves_secret_and_rewrites_meta() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("cubicase-meta.json"), r#"{"shortCode":"OLD111","name":"x","ownerSecret":"old"}"#).unwrap();
        set("OLD111", "old-secret-old-secret-old-secret");
        let new_secret = "N".repeat(32);
        adopt_rotated("OLD111", "NEW222", &new_secret, &d);
        assert_eq!(get("NEW222").as_deref(), Some(new_secret.as_str()));
        assert!(get("OLD111").is_none());
        let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("cubicase-meta.json")).unwrap()).unwrap();
        assert_eq!(meta["shortCode"], "NEW222");
        assert_eq!(meta["ownerSecret"], new_secret);
        assert_eq!(meta["name"], "x");
    }

    #[test]
    fn meta_secret_wins_and_missing_one_is_written_back() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_string_lossy().to_string();

        // Pasta sem segredo: grava o do mapa local.
        std::fs::write(dir.path().join("cubicase-meta.json"), r#"{"shortCode":"T1EST1","name":"x"}"#).unwrap();
        sync_with_meta("T1EST1", &d);
        let local = get("t1est1").expect("criado");
        let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("cubicase-meta.json")).unwrap()).unwrap();
        assert_eq!(meta["ownerSecret"], local);
        assert_eq!(meta["name"], "x", "não pode perder os outros campos");

        // Pasta trazida de outro PC (já com segredo): ele passa a valer.
        let other = "B".repeat(32);
        std::fs::write(dir.path().join("cubicase-meta.json"), format!(r#"{{"ownerSecret":"{}"}}"#, other)).unwrap();
        sync_with_meta("T1EST1", &d);
        assert_eq!(get("T1EST1").as_deref(), Some(other.as_str()));
    }
}
