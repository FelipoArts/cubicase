//! Identidade dos mods/plugins lida dos próprios `.jar`.
//!
//! Nome de arquivo não identifica um mod: `sodium-0.5.8.jar` e
//! `sodium-0.5.11.jar` são o mesmo mod, e o mesmo mod pode vir da Modrinth num
//! pacote e da CurseForge noutro. Quem identifica de verdade é o id que o mod
//! declara dentro do jar:
//!
//! - Fabric:   `fabric.mod.json`            → `id`, `version`
//! - Quilt:    `quilt.mod.json`             → `quilt_loader.id`, `quilt_loader.version`
//! - NeoForge: `META-INF/neoforge.mods.toml` → `modId`, `version`
//! - Forge:    `META-INF/mods.toml`         → `modId`, `version`
//! - Paper & cia: `paper-plugin.yml` / `plugin.yml` → `name`, `version`
//!
//! Serve para (1) apontar o mesmo mod em dois arquivos da pasta e (2) decidir,
//! ao instalar um modpack num servidor que já tem mods, o que é idêntico, o
//! que é novo e o que conflita em versão. Jars sem metadados reconhecível (mods
//! muito antigos) voltam com `mod_id: None` e o chamador cai na comparação por
//! nome de arquivo. Jars embutidos (jar-in-jar) são ignorados de propósito: só
//! a identidade de nível superior importa para a pasta.

use super::*;
use std::io::Read;
use std::path::Path;

/// Limite de leitura de cada arquivo de metadados — nenhum manifest legítimo chega perto.
const MAX_META_BYTES: u64 = 1024 * 1024;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct JarIdentity {
    pub mod_id: Option<String>,
    pub version: Option<String>,
    /// "fabric" | "quilt" | "neoforge" | "forge" | "bukkit"
    pub loader: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ModIdentityEntry {
    pub file_name: String,
    pub enabled: bool,
    pub mod_id: Option<String>,
    pub version: Option<String>,
    pub loader: Option<String>,
}

// ------------------------------------------------------------
// Parsers (puros — testados sem precisar de jar de verdade)
// ------------------------------------------------------------

pub(crate) fn parse_fabric_json(text: &str) -> Option<(String, Option<String>)> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let id = v.get("id")?.as_str()?.to_string();
    let version = v.get("version").and_then(|x| x.as_str()).map(str::to_string);
    Some((id, version))
}

pub(crate) fn parse_quilt_json(text: &str) -> Option<(String, Option<String>)> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let loader = v.get("quilt_loader")?;
    let id = loader.get("id")?.as_str()?.to_string();
    let version = loader.get("version").and_then(|x| x.as_str()).map(str::to_string);
    Some((id, version))
}

/// Valor de uma linha `chave = "valor"` (TOML) ou `chave: valor` (YAML), sem aspas nem comentário.
fn unquote(raw: &str) -> String {
    let raw = raw.trim();
    if let Some(rest) = raw.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return rest[..end].to_string();
        }
    }
    if let Some(rest) = raw.strip_prefix('\'') {
        if let Some(end) = rest.find('\'') {
            return rest[..end].to_string();
        }
    }
    raw.split('#').next().unwrap_or("").trim().to_string()
}

/// Lê o primeiro `[[mods]]` de um mods.toml/neoforge.mods.toml. Não usa um parser
/// TOML completo: só precisamos de `modId` e `version` da tabela `[[mods]]`.
pub(crate) fn parse_mods_toml(text: &str) -> Option<(String, Option<String>)> {
    let mut in_mods = false;
    let mut id: Option<String> = None;
    let mut version: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("[[mods]]") {
            if id.is_some() {
                break; // só o primeiro mod do jar
            }
            in_mods = true;
            continue;
        }
        if line.starts_with('[') {
            in_mods = false;
            continue;
        }
        if !in_mods {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            match key.trim() {
                "modId" => id = Some(unquote(value)),
                "version" => version = Some(unquote(value)),
                _ => {}
            }
        }
    }
    id.filter(|s| !s.is_empty()).map(|id| (id, version))
}

/// `name:` e `version:` de nível superior de um plugin.yml / paper-plugin.yml.
pub(crate) fn parse_plugin_yml(text: &str) -> Option<(String, Option<String>)> {
    let mut name: Option<String> = None;
    let mut version: Option<String> = None;
    for line in text.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            continue; // só chaves de nível superior
        }
        if let Some(value) = line.strip_prefix("name:") {
            name = Some(unquote(value));
        } else if let Some(value) = line.strip_prefix("version:") {
            version = Some(unquote(value));
        }
    }
    name.filter(|s| !s.is_empty()).map(|n| (n, version))
}

/// `Implementation-Version` do MANIFEST.MF — Forge/NeoForge costumam deixar
/// `version = "${file.jarVersion}"` no toml, que só se resolve por aqui.
pub(crate) fn parse_manifest_version(text: &str) -> Option<String> {
    text.lines()
        .find_map(|l| l.strip_prefix("Implementation-Version:"))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

// ------------------------------------------------------------
// Leitura do jar
// ------------------------------------------------------------

fn read_entry<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>, name: &str) -> Option<String> {
    let entry = archive.by_name(name).ok()?;
    let mut buf = String::new();
    entry.take(MAX_META_BYTES).read_to_string(&mut buf).ok()?;
    Some(buf)
}

/// Identidade de um jar. Qualquer falha (zip inválido, sem metadados) vira
/// `JarIdentity::default()` — identificar é um bônus, nunca motivo de erro.
pub(crate) fn identify_jar(path: &Path) -> JarIdentity {
    let Ok(file) = File::open(path) else { return JarIdentity::default() };
    let Ok(mut archive) = zip::ZipArchive::new(file) else { return JarIdentity::default() };

    type Parser = fn(&str) -> Option<(String, Option<String>)>;
    let candidates: [(&str, &str, Parser); 6] = [
        ("fabric.mod.json", "fabric", parse_fabric_json),
        ("quilt.mod.json", "quilt", parse_quilt_json),
        ("META-INF/neoforge.mods.toml", "neoforge", parse_mods_toml),
        ("META-INF/mods.toml", "forge", parse_mods_toml),
        ("paper-plugin.yml", "bukkit", parse_plugin_yml),
        ("plugin.yml", "bukkit", parse_plugin_yml),
    ];

    for (entry, loader, parse) in candidates {
        let Some(text) = read_entry(&mut archive, entry) else { continue };
        let Some((id, mut version)) = parse(&text) else { continue };
        if version.as_deref().map_or(true, |v| v.starts_with("${")) {
            version = read_entry(&mut archive, "META-INF/MANIFEST.MF").and_then(|m| parse_manifest_version(&m));
        }
        return JarIdentity { mod_id: Some(id), version, loader: Some(loader.to_string()) };
    }
    JarIdentity::default()
}

/// Rejeita caminhos que escapam de `base` (".." ou outro prefixo) — as operações
/// de arquivo abaixo só podem mexer dentro da pasta do servidor.
fn is_inside(base: &Path, path: &Path) -> bool {
    path.starts_with(base) && !path.components().any(|c| matches!(c, std::path::Component::ParentDir))
}

/// Mesmo conteúdo (tamanho + SHA-1)? Usado para tratar "já existe, e é o mesmo
/// arquivo" como sucesso em vez de erro — reinstalar o mesmo modpack não pode falhar.
fn same_content(a: &Path, b: &Path) -> bool {
    let (Ok(ma), Ok(mb)) = (std::fs::metadata(a), std::fs::metadata(b)) else { return false };
    if ma.len() != mb.len() {
        return false;
    }
    let digest = |p: &Path| std::fs::read(p).ok().map(|bytes| sha1_smol::Sha1::from(&bytes).digest().to_string());
    matches!((digest(a), digest(b)), (Some(x), Some(y)) if x == y)
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // rename falha entre volumes diferentes (staging em AppData, servidor em outro disco).
    std::fs::copy(from, to).map_err(|e| e.to_string())?;
    std::fs::remove_file(from).map_err(|e| e.to_string())
}

// ------------------------------------------------------------
// Comandos
// ------------------------------------------------------------

/// Identidade de todos os jars (ativos e desabilitados) de uma pasta mods/plugins.
#[tauri::command]
pub async fn read_mod_identities(server_dir: String, folder_name: Option<String>) -> Result<Vec<ModIdentityEntry>, String> {
    let dir = PathBuf::from(&server_dir).join(folder_name.as_deref().unwrap_or("mods"));
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let lower = file_name.to_lowercase();
        if !lower.ends_with(".jar") && !lower.ends_with(".jar.disabled") {
            continue;
        }
        let id = identify_jar(&path);
        out.push(ModIdentityEntry {
            enabled: !lower.ends_with(".disabled"),
            file_name,
            mod_id: id.mod_id,
            version: id.version,
            loader: id.loader,
        });
    }
    Ok(out)
}

/// Identidade de um jar avulso (usado nos mods baixados para a área de preparo).
#[tauri::command]
pub async fn read_jar_identity(path: String) -> Result<JarIdentity, String> {
    Ok(identify_jar(Path::new(&path)))
}

/// Move um mod da área de preparo para a pasta do servidor. Se `replace_path`
/// for informado, o arquivo antigo vai antes para `backup_dir` (nunca é
/// apagado: dá para desfazer a troca). Tudo precisa ficar dentro de `server_dir`.
#[tauri::command]
pub async fn install_staged_mod(
    server_dir: String,
    staged_path: String,
    dest_path: String,
    replace_path: Option<String>,
    backup_dir: Option<String>,
) -> Result<(), String> {
    let base = PathBuf::from(&server_dir);
    let dest = PathBuf::from(&dest_path);
    if !is_inside(&base, &dest) {
        return Err("Destino fora da pasta do servidor.".to_string());
    }
    let staged = PathBuf::from(&staged_path);
    if !staged.is_file() {
        return Err("Arquivo preparado não encontrado.".to_string());
    }

    if let Some(replace) = replace_path {
        let replace = PathBuf::from(replace);
        if !is_inside(&base, &replace) {
            return Err("Arquivo a substituir fora da pasta do servidor.".to_string());
        }
        if replace.is_file() {
            let backup = PathBuf::from(backup_dir.ok_or("Pasta de backup não informada.")?);
            if !is_inside(&base, &backup) {
                return Err("Pasta de backup fora da pasta do servidor.".to_string());
            }
            let name = replace.file_name().ok_or("Nome de arquivo inválido.")?;
            let mut target = backup.join(name);
            if target.exists() {
                let stamp = chrono::Utc::now().format("%H%M%S%3f");
                target = backup.join(format!("{}.{}", name.to_string_lossy(), stamp));
            }
            move_file(&replace, &target)?;
        }
    } else if dest.exists() {
        if same_content(&staged, &dest) {
            // Já está lá, idêntico: nada a fazer além de descartar o arquivo preparado.
            let _ = std::fs::remove_file(&staged);
            return Ok(());
        }
        let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        return Err(format!("Já existe um arquivo diferente chamado \"{}\" no servidor.", name));
    }

    move_file(&staged, &dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn make_jar(dir: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let path = dir.join(name);
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        for (entry, content) in files {
            zip.start_file(*entry, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn fabric_json_le_id_e_versao() {
        let (id, v) = parse_fabric_json(r#"{"id":"sodium","version":"0.5.8+mc1.20.1","name":"Sodium"}"#).unwrap();
        assert_eq!(id, "sodium");
        assert_eq!(v.as_deref(), Some("0.5.8+mc1.20.1"));
    }

    #[test]
    fn quilt_json_le_dentro_de_quilt_loader() {
        let (id, v) = parse_quilt_json(r#"{"quilt_loader":{"id":"qsl","version":"1.2"}}"#).unwrap();
        assert_eq!((id.as_str(), v.as_deref()), ("qsl", Some("1.2")));
    }

    #[test]
    fn mods_toml_pega_so_o_primeiro_mod_e_ignora_dependencias() {
        let toml = r#"
modLoader="javafml"
loaderVersion="[47,)"
license="MIT"

[[mods]] # lista de mods
modId="jei"
version="15.2.0.27" # versão
displayName="JEI"

[[dependencies.jei]]
modId="forge"
mandatory=true
versionRange="[47,)"

[[mods]]
modId="outro"
version="9"
"#;
        let (id, v) = parse_mods_toml(toml).unwrap();
        assert_eq!(id, "jei");
        assert_eq!(v.as_deref(), Some("15.2.0.27"));
    }

    #[test]
    fn mods_toml_sem_tabela_mods_nao_identifica() {
        assert!(parse_mods_toml("modLoader=\"javafml\"\n[[dependencies.x]]\nmodId=\"y\"").is_none());
    }

    #[test]
    fn plugin_yml_ignora_chaves_aninhadas() {
        let yml = "name: WorldEdit\nversion: '7.2.15'\ncommands:\n  worldedit:\n    version: x\n";
        let (name, v) = parse_plugin_yml(yml).unwrap();
        assert_eq!((name.as_str(), v.as_deref()), ("WorldEdit", Some("7.2.15")));
    }

    #[test]
    fn manifest_version() {
        assert_eq!(parse_manifest_version("Manifest-Version: 1.0\nImplementation-Version: 2.3.4\n").as_deref(), Some("2.3.4"));
        assert_eq!(parse_manifest_version("Manifest-Version: 1.0\n"), None);
    }

    #[test]
    fn identifica_jar_fabric_e_forge_com_placeholder_de_versao() {
        let tmp = tempfile::TempDir::new().unwrap();
        let fabric = make_jar(tmp.path(), "a.jar", &[("fabric.mod.json", r#"{"id":"lithium","version":"0.11.2"}"#)]);
        let id = identify_jar(&fabric);
        assert_eq!(id.mod_id.as_deref(), Some("lithium"));
        assert_eq!(id.loader.as_deref(), Some("fabric"));

        let forge = make_jar(
            tmp.path(),
            "b.jar",
            &[
                ("META-INF/mods.toml", "[[mods]]\nmodId=\"curios\"\nversion=\"${file.jarVersion}\"\n"),
                ("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\nImplementation-Version: 5.4.0\n"),
            ],
        );
        let id = identify_jar(&forge);
        assert_eq!(id.mod_id.as_deref(), Some("curios"));
        assert_eq!(id.version.as_deref(), Some("5.4.0"));
        assert_eq!(id.loader.as_deref(), Some("forge"));
    }

    #[test]
    fn jar_sem_metadados_ou_invalido_nao_da_erro() {
        let tmp = tempfile::TempDir::new().unwrap();
        let vazio = make_jar(tmp.path(), "c.jar", &[("readme.txt", "oi")]);
        assert_eq!(identify_jar(&vazio), JarIdentity::default());
        std::fs::write(tmp.path().join("d.jar"), b"nao e zip").unwrap();
        assert_eq!(identify_jar(&tmp.path().join("d.jar")), JarIdentity::default());
    }

    #[tokio::test]
    async fn install_staged_mod_move_e_faz_backup_do_substituido() {
        let tmp = tempfile::TempDir::new().unwrap();
        let server = tmp.path().join("srv");
        std::fs::create_dir_all(server.join("mods")).unwrap();
        let old = server.join("mods").join("x-1.jar");
        std::fs::write(&old, b"velho").unwrap();
        let staged = tmp.path().join("x-2.jar");
        std::fs::write(&staged, b"novo").unwrap();

        install_staged_mod(
            server.to_string_lossy().to_string(),
            staged.to_string_lossy().to_string(),
            server.join("mods").join("x-2.jar").to_string_lossy().to_string(),
            Some(old.to_string_lossy().to_string()),
            Some(server.join("mods-backup").to_string_lossy().to_string()),
        )
        .await
        .unwrap();

        assert!(!old.exists());
        assert_eq!(std::fs::read(server.join("mods-backup").join("x-1.jar")).unwrap(), b"velho");
        assert_eq!(std::fs::read(server.join("mods").join("x-2.jar")).unwrap(), b"novo");
        assert!(!staged.exists());
    }

    #[tokio::test]
    async fn install_staged_mod_recusa_destino_fora_do_servidor_e_sobrescrita_silenciosa() {
        let tmp = tempfile::TempDir::new().unwrap();
        let server = tmp.path().join("srv");
        std::fs::create_dir_all(server.join("mods")).unwrap();
        let staged = tmp.path().join("a.jar");
        std::fs::write(&staged, b"a").unwrap();
        let s = server.to_string_lossy().to_string();

        let fora = install_staged_mod(s.clone(), staged.to_string_lossy().to_string(), tmp.path().join("fora.jar").to_string_lossy().to_string(), None, None).await;
        assert!(fora.is_err());

        let escapa = server.join("mods").join("..").join("..").join("evil.jar");
        assert!(install_staged_mod(s.clone(), staged.to_string_lossy().to_string(), escapa.to_string_lossy().to_string(), None, None).await.is_err());

        std::fs::write(server.join("mods").join("a.jar"), b"ja existe").unwrap();
        let dup = install_staged_mod(s, staged.to_string_lossy().to_string(), server.join("mods").join("a.jar").to_string_lossy().to_string(), None, None).await;
        assert!(dup.is_err());
        assert_eq!(std::fs::read(server.join("mods").join("a.jar")).unwrap(), b"ja existe");
    }

    #[tokio::test]
    async fn overrides_em_servidor_existente_nao_sobrescrevem_arquivos_do_host() {
        let tmp = tempfile::TempDir::new().unwrap();
        let pack = make_jar(
            tmp.path(),
            "pack.mrpack",
            &[("overrides/server.properties", "motd=do-pack"), ("overrides/config/novo.toml", "x=1")],
        );
        let server = tmp.path().join("srv");
        std::fs::create_dir_all(&server).unwrap();
        std::fs::write(server.join("server.properties"), "motd=do-host").unwrap();

        let n = extract_modpack_overrides(
            pack.to_string_lossy().to_string(),
            server.to_string_lossy().to_string(),
            "overrides".to_string(),
            Some(true),
        )
        .await
        .unwrap();

        assert_eq!(n, 1);
        assert_eq!(std::fs::read_to_string(server.join("server.properties")).unwrap(), "motd=do-host");
        assert_eq!(std::fs::read_to_string(server.join("config").join("novo.toml")).unwrap(), "x=1");

        // Sem skip_existing (servidor novo criado a partir do pack) o comportamento antigo se mantém.
        extract_modpack_overrides(pack.to_string_lossy().to_string(), server.to_string_lossy().to_string(), "overrides".to_string(), None)
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(server.join("server.properties")).unwrap(), "motd=do-pack");
    }

    #[tokio::test]
    async fn install_staged_mod_em_arquivo_identico_ja_existente_e_sucesso() {
        let tmp = tempfile::TempDir::new().unwrap();
        let server = tmp.path().join("srv");
        std::fs::create_dir_all(server.join("mods")).unwrap();
        std::fs::write(server.join("mods").join("Pack.zip"), b"mesmo conteudo").unwrap();
        let staged = tmp.path().join("Pack.zip");
        std::fs::write(&staged, b"mesmo conteudo").unwrap();

        // Reinstalar o mesmo modpack não pode falhar só porque o arquivo já está lá.
        install_staged_mod(
            server.to_string_lossy().to_string(),
            staged.to_string_lossy().to_string(),
            server.join("mods").join("Pack.zip").to_string_lossy().to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(!staged.exists());
        assert_eq!(std::fs::read(server.join("mods").join("Pack.zip")).unwrap(), b"mesmo conteudo");
    }

    #[test]
    fn safe_manifest_dir_separa_pasta_do_arquivo_e_descarta_segmentos_perigosos() {
        assert_eq!(safe_manifest_dir("mods/sodium.jar"), "mods");
        assert_eq!(safe_manifest_dir("resourcepacks/Chat Reporting Helper.zip"), "resourcepacks");
        assert_eq!(safe_manifest_dir("config\\sub\\a.toml"), "config/sub");
        assert_eq!(safe_manifest_dir("../../AppData/x.jar"), "AppData");
        assert_eq!(safe_manifest_dir("C:/Windows/x.jar"), "Windows");
        assert_eq!(safe_manifest_dir("so-arquivo.jar"), "");
    }
}
