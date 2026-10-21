//! Identifica se uma pasta é MESMO um servidor Minecraft, pelo CONTEÚDO — não pelo nome dos arquivos.
//!
//! Usado ao importar uma pasta, ao reabrir servidores importados e ao liberar o acesso do frontend a elas.
//!
//! Princípios:
//! - A prova principal é o que está DENTRO dos `.jar`: o `Main-Class` do manifesto e as classes que o jar
//!   carrega (bundler da Mojang, Paperclip, launchers do Fabric/Quilt, CraftBukkit, Forge...). Um jar qualquer
//!   (biblioteca, mod, cliente do jogo, instalador) nunca é aceito como servidor.
//! - Nunca se reprova por AUSÊNCIA de arquivo "esperado": servidor que nunca rodou não tem `server.properties`,
//!   e um fork desconhecido tem outro `Main-Class`. Quando nenhum jar é reconhecido, há degraus de reserva que
//!   exigem evidência de que a pasta já foi um servidor (propriedades válidas, `eula.txt`, mundo, logs).
//! - Recusas têm um MOTIVO (cliente do jogo, pasta ampla demais, proxy, só instalador...) para a interface explicar.
//!
//! Só lê o índice (diretório central) dos zips e alguns arquivos pequenos dentro deles.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Quantas entradas de um jar examinamos no máximo (um servidor com todas as bibliotecas embutidas passa de 10 mil).
const MAX_JAR_ENTRIES: usize = 400_000;
/// Teto de um arquivo pequeno lido de dentro de um jar (manifesto, version.json...).
const MAX_SMALL_ENTRY: u64 = 256 * 1024;

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInspection {
    /// A pasta é um servidor que o Cubicase sabe iniciar?
    pub valid: bool,
    /// "vanilla", "paperclip", "spigot", "fabric", "quilt", "forge", "forge-modern", "other" ou "unknown" (reserva).
    pub kind: String,
    /// "jar" ou "argfile" (Forge/NeoForge modernos).
    pub launch_mode: Option<String>,
    pub jar_name: Option<String>,
    /// Pasta (relativa, com "/") que contém o `win_args.txt`/`unix_args.txt`.
    pub args_dir: Option<String>,
    /// Versão do Minecraft lida do próprio servidor, se achou.
    pub mc_version: Option<String>,
    /// "high" (jar/layout reconhecido pelo conteúdo), "medium" (nome conhecido + evidência de uso) ou "low" (reserva).
    pub confidence: String,
    /// Motivo da recusa quando `valid` é falso: NOT_A_DIRECTORY, TOO_BROAD, CLIENT_INSTALL, PROXY,
    /// ONLY_INSTALLER, NO_LAUNCHABLE.
    pub reason: Option<String>,
    /// Sinais encontrados (para diagnóstico).
    pub signals: Vec<String>,
    /// Outros jars que também poderiam ser o servidor (a interface pode oferecer a troca).
    pub candidates: Vec<String>,
}

fn refuse(reason: &str, signals: Vec<String>) -> ServerInspection {
    ServerInspection { reason: Some(reason.to_string()), signals, ..Default::default() }
}

// ---------------------------------------------------------------- jar

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum JarKind {
    /// Jar que não é servidor (biblioteca, mod, cliente, instalador, proxy...).
    NotServer(NotServer),
    Vanilla,
    Paperclip,
    Spigot,
    Fabric,
    Quilt,
    Forge,
    Other,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum NotServer {
    NotAJar,
    Installer,
    Client,
    Proxy,
    Unrecognized,
}

impl JarKind {
    /// Quem deve ganhar quando a pasta tem mais de um jar de servidor (ex.: um servidor Fabric tem o
    /// `server.jar` da Mojang E o `fabric-server-launch.jar`; vale o launcher).
    fn rank(self) -> u8 {
        match self {
            JarKind::Fabric | JarKind::Quilt => 90,
            JarKind::Paperclip => 80,
            JarKind::Spigot => 70,
            JarKind::Forge => 60,
            JarKind::Vanilla => 50,
            JarKind::Other => 40,
            JarKind::NotServer(_) => 0,
        }
    }

    fn label(self) -> &'static str {
        match self {
            JarKind::Fabric => "fabric",
            JarKind::Quilt => "quilt",
            JarKind::Paperclip => "paperclip",
            JarKind::Spigot => "spigot",
            JarKind::Forge => "forge",
            JarKind::Vanilla => "vanilla",
            JarKind::Other => "other",
            JarKind::NotServer(_) => "unknown",
        }
    }
}

#[derive(Debug)]
struct JarInfo {
    kind: JarKind,
    mc_version: Option<String>,
    size: u64,
    /// Zip válido com `Main-Class` (usado pelo degrau de reserva).
    has_main_class: bool,
}

/// Valor de um atributo do `MANIFEST.MF`, respeitando as linhas de continuação (começam com espaço).
fn manifest_attr(manifest: &str, key: &str) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in manifest.split('\n') {
        let line = raw.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix(' ') {
            if let Some(last) = lines.last_mut() {
                last.push_str(rest);
            }
        } else {
            lines.push(line.to_string());
        }
    }
    let prefix = format!("{}:", key.to_ascii_lowercase());
    lines.iter().find_map(|l| {
        if l.to_ascii_lowercase().starts_with(&prefix) {
            Some(l[prefix.len()..].trim().to_string())
        } else {
            None
        }
    })
}

fn looks_like_mc_version(v: &str) -> bool {
    let mut parts = v.split('.');
    let ok = |p: Option<&str>| p.map_or(false, |s| !s.is_empty() && s.len() <= 3 && s.bytes().all(|b| b.is_ascii_digit()));
    ok(parts.next()) && ok(parts.next()) && parts.next().map_or(true, |s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())) && parts.next().is_none()
}

fn read_small<R: Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Option<String> {
    let entry = zip.by_name(name).ok()?;
    if entry.size() > MAX_SMALL_ENTRY {
        return None;
    }
    let mut buf = String::new();
    entry.take(MAX_SMALL_ENTRY).read_to_string(&mut buf).ok()?;
    Some(buf)
}

/// Versão do Minecraft guardada no jar: `version.json` (Mojang), `patch.properties` (Paperclip) ou `versions.list`.
fn jar_mc_version<R: Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>) -> Option<String> {
    if let Some(txt) = read_small(zip, "version.json") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            for key in ["id", "name"] {
                if let Some(id) = v.get(key).and_then(|x| x.as_str()) {
                    if looks_like_mc_version(id) {
                        return Some(id.to_string());
                    }
                }
            }
        }
    }
    if let Some(txt) = read_small(zip, "patch.properties") {
        for l in txt.lines() {
            if let Some(v) = l.trim().strip_prefix("version=") {
                if looks_like_mc_version(v.trim()) {
                    return Some(v.trim().to_string());
                }
            }
        }
    }
    if let Some(txt) = read_small(zip, "META-INF/versions.list") {
        // <hash>\t<id>\t<caminho>
        for l in txt.lines() {
            if let Some(id) = l.split('\t').nth(1) {
                if looks_like_mc_version(id.trim()) {
                    return Some(id.trim().to_string());
                }
            }
        }
    }
    None
}

fn inspect_jar(path: &Path) -> JarInfo {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let not = |n: NotServer| JarInfo { kind: JarKind::NotServer(n), mc_version: None, size, has_main_class: false };
    let Ok(file) = File::open(path) else { return not(NotServer::NotAJar) };
    let Ok(mut zip) = zip::ZipArchive::new(file) else { return not(NotServer::NotAJar) };

    // Um passe pelo índice: guarda só o que importa.
    let mut count = 0usize;
    let (mut p_bundler, mut p_mc_server, mut p_mc_client, mut p_bukkit, mut p_forge) = (false, false, false, false, false);
    let (mut install_profile, mut p_craftbukkit_main, mut p_server_version_jar) = (false, false, false);
    for name in zip.file_names() {
        count += 1;
        if count > MAX_JAR_ENTRIES {
            break;
        }
        match name {
            "install_profile.json" => install_profile = true,
            "net/minecraft/bundler/Main.class" => p_bundler = true,
            "net/minecraft/server/MinecraftServer.class" => p_mc_server = true,
            "net/minecraft/client/main/Main.class" | "net/minecraft/client/Minecraft.class" => p_mc_client = true,
            "org/bukkit/craftbukkit/Main.class" => p_craftbukkit_main = true,
            _ => {
                if name.starts_with("org/bukkit/") {
                    p_bukkit = true;
                } else if name.starts_with("net/minecraftforge/") || name.starts_with("net/neoforged/") || name.starts_with("cpw/mods/fml/") {
                    p_forge = true;
                } else if name.starts_with("META-INF/versions/") && name.contains("/server-") && name.ends_with(".jar") {
                    p_server_version_jar = true;
                }
            }
        }
    }

    let manifest = read_small(&mut zip, "META-INF/MANIFEST.MF");
    let main_class = manifest.as_deref().and_then(|m| manifest_attr(m, "Main-Class"));
    let bundler_main = read_small(&mut zip, "META-INF/main-class");
    let main_lc = main_class.as_deref().unwrap_or("").to_ascii_lowercase();
    let has_main_class = main_class.is_some();

    let classify = |kind: JarKind| JarInfo { kind, mc_version: None, size, has_main_class };
    // O jar que a API do Fabric entrega como "server" (`.../server/jar`) é o ServerLauncher do próprio
    // instalador do Fabric (Main-Class net.fabricmc.installer.ServerLauncher): ele baixa o necessário na
    // primeira execução. É o jar que o Cubicase usa para iniciar o servidor, não um instalador a ignorar.
    let fabric_bootstrap = main_lc.contains("fabricmc.installer.serverlauncher");
    let mut info = if fabric_bootstrap {
        classify(JarKind::Fabric)
    } else if install_profile || main_lc.contains("installer") {
        classify(JarKind::NotServer(NotServer::Installer))
    } else if main_lc.contains("minecraft.client") || (p_mc_client && !has_main_class && !p_bundler) {
        // O jar do CLIENTE também carrega net/minecraft/server/MinecraftServer (servidor integrado) — o que o
        // denuncia é o Main-Class (net.minecraft.client.Main) e as classes net/minecraft/client/.
        classify(JarKind::NotServer(NotServer::Client))
    } else if main_lc.contains("bungeecord") || main_lc.contains("velocity") || main_lc.contains("waterfall") {
        classify(JarKind::NotServer(NotServer::Proxy))
    } else if main_lc.contains("fabricserverlauncher") {
        classify(JarKind::Fabric)
    } else if main_lc.contains("quiltserverlauncher") {
        classify(JarKind::Quilt)
    } else if main_lc.contains("paperclip") {
        classify(JarKind::Paperclip)
    } else if main_lc.contains("craftbukkit") || p_craftbukkit_main {
        classify(JarKind::Spigot)
    } else if p_forge && (main_class.is_some() || p_mc_server || p_bukkit) {
        classify(JarKind::Forge)
    } else if p_bundler
        || bundler_main.as_deref().map_or(false, |m| m.contains("bundler"))
        || (p_mc_server && !p_bukkit)
    {
        classify(JarKind::Vanilla)
    } else if has_main_class && (p_mc_server || p_bukkit || p_server_version_jar) {
        // Forks desconhecidos (Mohist, Arclight, Leaf...): carregam o servidor ou o Bukkit dentro.
        classify(JarKind::Other)
    } else if p_bukkit && p_mc_server {
        classify(JarKind::Other)
    } else {
        classify(JarKind::NotServer(NotServer::Unrecognized))
    };

    if info.kind.rank() > 0 {
        info.mc_version = jar_mc_version(&mut zip);
    }
    info
}

// ---------------------------------------------------------------- pasta

/// Nomes (em minúsculas) que um servidor costuma ter — só para desempate e para o degrau "nome conhecido".
fn known_server_name(lower: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "purpur-", "paper-", "spigot-", "craftbukkit", "bukkit-", "fabric-server", "quilt-server", "neoforge-", "forge-",
        "minecraft_server.", "sponge", "folia-", "pufferfish-", "mohist-", "arclight-", "magma",
    ];
    lower == "server.jar" || lower.ends_with("-shim.jar") || lower.ends_with("-universal.jar") || PREFIXES.iter().any(|p| lower.starts_with(p))
}

/// Propriedades que só um `server.properties` de verdade tem (precisa de pelo menos duas).
fn valid_server_properties(p: &Path) -> bool {
    let Ok(txt) = std::fs::read_to_string(p) else { return false };
    const KEYS: &[&str] = &[
        "server-port", "level-name", "motd", "max-players", "online-mode", "gamemode", "difficulty", "view-distance",
        "white-list", "enable-command-block", "level-seed", "pvp",
    ];
    let hits = txt
        .lines()
        .filter_map(|l| l.split_once('='))
        .filter(|(k, _)| KEYS.contains(&k.trim()))
        .count();
    hits >= 2
}

/// Evidência de que ALGUM servidor já rodou nesta pasta.
fn server_evidence(dir: &Path) -> Vec<String> {
    let mut v = Vec::new();
    if valid_server_properties(&dir.join("server.properties")) {
        v.push("server.properties".to_string());
    }
    if dir.join("eula.txt").is_file() {
        v.push("eula.txt".to_string());
    }
    if dir.join("logs").join("latest.log").is_file() {
        v.push("logs/latest.log".to_string());
    }
    if dir.join("world").join("level.dat").is_file() {
        v.push("world/level.dat".to_string());
    } else if let Ok(rd) = std::fs::read_dir(dir) {
        // `level-name` personalizado: qualquer subpasta com level.dat.
        if rd.flatten().any(|e| e.path().is_dir() && e.path().join("level.dat").is_file()) {
            v.push("level.dat".to_string());
        }
    }
    v
}

/// Pastas que nunca são "um servidor": raiz do disco e diretórios do sistema. As pastas do usuário
/// (Documentos, Desktop, Downloads) só passam com evidência de uso — ver `inspect_server_folder`.
fn broad_level(dir: &Path) -> Option<bool> {
    // Some(true) = recusa sempre; Some(false) = recusa se não houver evidência de uso; None = ok.
    let normal = |p: &Path| -> String { p.to_string_lossy().trim_end_matches(['\\', '/']).to_ascii_lowercase().replace('/', "\\") };
    let me = normal(dir);
    if dir.components().filter(|c| matches!(c, std::path::Component::Normal(_))).count() == 0 {
        return Some(true); // raiz do disco
    }
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let hard: Vec<Option<PathBuf>> = vec![
        env("USERPROFILE"), env("APPDATA"), env("LOCALAPPDATA"), env("ProgramFiles"), env("ProgramFiles(x86)"),
        env("ProgramW6432"), env("SystemRoot"), env("windir"), env("ProgramData"),
        env("USERPROFILE").map(|p| p.join("Documents").join("CubicaseServers")),
    ];
    if hard.into_iter().flatten().any(|p| normal(&p) == me) {
        return Some(true);
    }
    let soft = ["Documents", "Desktop", "Downloads"];
    if let Some(home) = env("USERPROFILE") {
        if soft.iter().any(|s| normal(&home.join(s)) == me) {
            return Some(false);
        }
    }
    None
}

/// Layout Forge/NeoForge moderno (1.17+): `user_jvm_args.txt` + `libraries/**/win_args.txt|unix_args.txt`.
fn find_args_dir(server: &Path) -> Option<String> {
    if !server.join("user_jvm_args.txt").is_file() {
        return None;
    }
    fn scan(dir: &Path, rel: &str, depth: u32) -> Option<String> {
        if depth > 8 {
            return None;
        }
        let rd = std::fs::read_dir(dir).ok()?;
        let entries: Vec<_> = rd.flatten().collect();
        if entries.iter().any(|e| {
            let n = e.file_name();
            let n = n.to_string_lossy();
            e.path().is_file() && (n == "win_args.txt" || n == "unix_args.txt")
        }) {
            return Some(rel.to_string());
        }
        let mut dirs: Vec<_> = entries.iter().filter(|e| e.path().is_dir()).collect();
        dirs.sort_by_key(|e| e.file_name());
        for e in dirs {
            if let Some(f) = scan(&e.path(), &format!("{}/{}", rel, e.file_name().to_string_lossy()), depth + 1) {
                return Some(f);
            }
        }
        None
    }
    scan(&server.join("libraries"), "libraries", 0)
}

/// Versão do Minecraft no nome da pasta do Forge: `libraries/net/minecraftforge/forge/<mc>-<forge>/...`
/// (ex.: `1.20.1-47.2.0`). O NeoForge usa só a versão dele (ex.: `21.1.264`), da qual não dá para
/// deduzir a do Minecraft com segurança — devolve None e a interface usa outra fonte.
fn forge_version_from_args_dir(args_dir: &str) -> Option<String> {
    let rest = args_dir.split("minecraftforge/forge/").nth(1)?;
    let seg = rest.split('/').next()?;
    let (mc, _forge) = seg.split_once('-')?;
    if looks_like_mc_version(mc) { Some(mc.to_string()) } else { None }
}

pub fn inspect_server_folder(dir: &Path) -> ServerInspection {
    if !dir.is_dir() {
        return refuse("NOT_A_DIRECTORY", vec![]);
    }
    let mut signals: Vec<String> = Vec::new();
    let evidence = server_evidence(dir);

    match broad_level(dir) {
        Some(true) => return refuse("TOO_BROAD", signals),
        Some(false) if evidence.is_empty() => return refuse("TOO_BROAD", signals),
        _ => {}
    }

    // Instalação do CLIENTE do jogo (launcher): nunca é um servidor, mesmo com jars soltos.
    if dir.join("launcher_profiles.json").is_file() || (dir.join("assets").join("indexes").is_dir() && evidence.is_empty()) {
        return refuse("CLIENT_INSTALL", signals);
    }

    // 1. Forge/NeoForge moderno: o layout é a prova.
    if let Some(args_dir) = find_args_dir(dir) {
        signals.push("user_jvm_args.txt + args file".to_string());
        return ServerInspection {
            valid: true,
            kind: "forge-modern".into(),
            launch_mode: Some("argfile".into()),
            mc_version: forge_version_from_args_dir(&args_dir),
            args_dir: Some(args_dir),
            confidence: "high".into(),
            signals,
            ..Default::default()
        };
    }

    // 2. Jars da raiz, examinados por dentro.
    let mut jars: Vec<(String, JarInfo)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_file() && name.to_ascii_lowercase().ends_with(".jar") {
                let info = inspect_jar(&p);
                jars.push((name, info));
            }
        }
    }
    jars.sort_by(|a, b| a.0.to_ascii_lowercase().cmp(&b.0.to_ascii_lowercase()));

    let mut candidates: Vec<&(String, JarInfo)> = jars.iter().filter(|(_, i)| i.kind.rank() > 0).collect();
    candidates.sort_by(|a, b| {
        let (na, nb) = (known_server_name(&a.0.to_ascii_lowercase()), known_server_name(&b.0.to_ascii_lowercase()));
        b.1.kind.rank().cmp(&a.1.kind.rank())
            .then(nb.cmp(&na))
            .then(b.1.size.cmp(&a.1.size))
            .then(a.0.cmp(&b.0))
    });

    if let Some((name, info)) = candidates.first() {
        signals.push(format!("jar {} reconhecido pelo conteúdo ({})", name, info.kind.label()));
        signals.extend(evidence.iter().map(|e| format!("evidência: {}", e)));
        return ServerInspection {
            valid: true,
            kind: info.kind.label().into(),
            launch_mode: Some("jar".into()),
            jar_name: Some(name.clone()),
            mc_version: info.mc_version.clone(),
            confidence: "high".into(),
            signals,
            candidates: candidates.iter().skip(1).map(|(n, _)| n.clone()).collect(),
            ..Default::default()
        };
    }

    // 3. Reserva (evita reprovar servidor legítimo de um fork que não conhecemos): jar válido
    //    + evidência de que um servidor já rodou aqui. Sem evidência, não adivinhamos.
    let usable: Vec<&(String, JarInfo)> = jars
        .iter()
        .filter(|(_, i)| matches!(i.kind, JarKind::NotServer(NotServer::Unrecognized)) && i.has_main_class)
        .collect();
    if !usable.is_empty() && !evidence.is_empty() {
        let mut pool = usable.clone();
        pool.sort_by(|a, b| {
            let (na, nb) = (known_server_name(&a.0.to_ascii_lowercase()), known_server_name(&b.0.to_ascii_lowercase()));
            nb.cmp(&na).then(b.1.size.cmp(&a.1.size)).then(a.0.cmp(&b.0))
        });
        let (name, _) = pool[0];
        let named = known_server_name(&name.to_ascii_lowercase());
        signals.push(format!("jar {} sem assinatura conhecida, mas há evidência de servidor", name));
        signals.extend(evidence.iter().map(|e| format!("evidência: {}", e)));
        // Vários jars desconhecidos e nenhum com nome de servidor: é ambíguo demais para adivinhar.
        if pool.len() == 1 || named {
            return ServerInspection {
                valid: true,
                kind: "unknown".into(),
                launch_mode: Some("jar".into()),
                jar_name: Some(name.clone()),
                confidence: if named { "medium" } else { "low" }.into(),
                signals,
                candidates: pool.iter().skip(1).map(|(n, _)| n.clone()).collect(),
                ..Default::default()
            };
        }
    }

    // 4. Nada lançável: explica o motivo mais útil.
    let kinds = |k: NotServer| jars.iter().any(|(_, i)| i.kind == JarKind::NotServer(k));
    if kinds(NotServer::Installer) {
        return refuse("ONLY_INSTALLER", signals);
    }
    if kinds(NotServer::Proxy) {
        return refuse("PROXY", signals);
    }
    if kinds(NotServer::Client) {
        return refuse("CLIENT_INSTALL", signals);
    }
    refuse("NO_LAUNCHABLE", signals)
}

#[tauri::command]
pub fn inspect_server_folder_cmd(path: String) -> ServerInspection {
    let p = PathBuf::from(path);
    if !p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return refuse("NOT_A_DIRECTORY", vec![]);
    }
    inspect_server_folder(&p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// Monta um jar (zip) com as entradas dadas: (nome, conteúdo).
    fn make_jar(path: &Path, entries: &[(&str, &str)]) {
        let f = File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            z.start_file(*name, opts).unwrap();
            z.write_all(body.as_bytes()).unwrap();
        }
        z.finish().unwrap();
    }

    fn manifest(main: &str) -> String {
        format!("Manifest-Version: 1.0\r\nMain-Class: {}\r\n\r\n", main)
    }

    fn vanilla_bundler(path: &Path, ver: &str) {
        make_jar(path, &[
            ("META-INF/MANIFEST.MF", &manifest("net.minecraft.bundler.Main")),
            ("META-INF/main-class", "net.minecraft.server.Main"),
            ("META-INF/versions.list", &format!("abc\t{}\t{}/server-{}.jar\n", ver, ver, ver)),
            ("net/minecraft/bundler/Main.class", "x"),
            ("version.json", &format!("{{\"id\":\"{}\",\"name\":\"{}\"}}", ver, ver)),
        ]);
    }

    fn props(dir: &Path) {
        std::fs::write(dir.join("server.properties"), "server-port=25565\nmotd=oi\nlevel-name=world\n").unwrap();
    }

    #[test]
    fn manifest_com_linha_de_continuacao() {
        let m = "Manifest-Version: 1.0\r\nMain-Class: net.fabricmc.loader.impl.launch.se\r\n rver.FabricServerLauncher\r\nOutro: x\r\n";
        assert_eq!(manifest_attr(m, "Main-Class").as_deref(), Some("net.fabricmc.loader.impl.launch.server.FabricServerLauncher"));
        assert_eq!(manifest_attr(m, "main-class").is_some(), true, "chave sem diferenciar maiúsculas");
        assert_eq!(manifest_attr(m, "Ausente"), None);
    }

    #[test]
    fn vanilla_moderno_pelo_conteudo_mesmo_com_nome_estranho() {
        let t = TempDir::new().unwrap();
        vanilla_bundler(&t.path().join("meu-servidor-final.jar"), "1.20.4");
        let r = inspect_server_folder(t.path());
        assert!(r.valid, "{:?}", r);
        assert_eq!(r.kind, "vanilla");
        assert_eq!(r.jar_name.as_deref(), Some("meu-servidor-final.jar"));
        assert_eq!(r.mc_version.as_deref(), Some("1.20.4"));
        assert_eq!(r.confidence, "high");
    }

    #[test]
    fn servidor_que_nunca_rodou_e_aceito_sem_server_properties() {
        let t = TempDir::new().unwrap();
        vanilla_bundler(&t.path().join("server.jar"), "1.21");
        assert!(inspect_server_folder(t.path()).valid);
    }

    #[test]
    fn vanilla_antigo_sem_bundler() {
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("minecraft_server.1.12.2.jar"), &[
            ("META-INF/MANIFEST.MF", &manifest("net.minecraft.server.MinecraftServer")),
            ("net/minecraft/server/MinecraftServer.class", "x"),
        ]);
        let r = inspect_server_folder(t.path());
        assert!(r.valid && r.kind == "vanilla", "{:?}", r);
    }

    #[test]
    fn paper_pelo_paperclip_e_versao_do_patch_properties() {
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("qualquercoisa.jar"), &[
            ("META-INF/MANIFEST.MF", &manifest("io.papermc.paperclip.Main")),
            ("patch.properties", "originalHash=aa\nversion=1.20.1\n"),
        ]);
        let r = inspect_server_folder(t.path());
        assert!(r.valid && r.kind == "paperclip", "{:?}", r);
        assert_eq!(r.mc_version.as_deref(), Some("1.20.1"));
    }

    #[test]
    fn fabric_vence_o_server_jar_da_mojang_na_mesma_pasta() {
        let t = TempDir::new().unwrap();
        vanilla_bundler(&t.path().join("server.jar"), "1.20.1");
        make_jar(&t.path().join("fabric-server-launch.jar"), &[
            ("META-INF/MANIFEST.MF", &manifest("net.fabricmc.loader.impl.launch.server.FabricServerLauncher")),
        ]);
        props(t.path());
        let r = inspect_server_folder(t.path());
        assert!(r.valid && r.kind == "fabric", "{:?}", r);
        assert_eq!(r.jar_name.as_deref(), Some("fabric-server-launch.jar"));
        assert!(r.candidates.contains(&"server.jar".to_string()));
    }

    #[test]
    fn launcher_do_fabric_que_a_api_entrega_nao_e_confundido_com_instalador() {
        // Manifesto real do jar baixado de meta.fabricmc.net/.../server/jar
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("fabric-server-launch.jar"), &[
            ("META-INF/MANIFEST.MF", "Manifest-Version: 1.0
Implementation-Title: FabricInstaller
Main-Class: net.fabricmc.installer.ServerLauncher

"),
            ("net/fabricmc/installer/ServerLauncher.class", "x"),
            ("net/fabricmc/installer/server/ServerInstaller.class", "x"),
        ]);
        let r = inspect_server_folder(t.path());
        assert!(r.valid && r.kind == "fabric", "{:?}", r);
        // o instalador de verdade do Fabric continua sendo só um instalador
        let t2 = TempDir::new().unwrap();
        make_jar(&t2.path().join("fabric-installer.jar"), &[("META-INF/MANIFEST.MF", &manifest("net.fabricmc.installer.Main"))]);
        assert_eq!(inspect_server_folder(t2.path()).reason.as_deref(), Some("ONLY_INSTALLER"));
    }

    #[test]
    fn fabric_com_launcher_renomeado_continua_sendo_fabric() {
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("start.jar"), &[
            ("META-INF/MANIFEST.MF", &manifest("net.fabricmc.loader.launch.server.FabricServerLauncher")),
        ]);
        let r = inspect_server_folder(t.path());
        assert!(r.valid && r.kind == "fabric", "{:?}", r);
    }

    #[test]
    fn spigot_e_forge_antigo() {
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("spigot-1.20.jar"), &[("META-INF/MANIFEST.MF", &manifest("org.bukkit.craftbukkit.bootstrap.Main"))]);
        assert_eq!(inspect_server_folder(t.path()).kind, "spigot");

        let t2 = TempDir::new().unwrap();
        make_jar(&t2.path().join("minecraft_server.1.12.2.jar"), &[("net/minecraft/server/MinecraftServer.class", "x"), ("META-INF/MANIFEST.MF", &manifest("net.minecraft.server.MinecraftServer"))]);
        make_jar(&t2.path().join("forge-1.12.2-14.23.5.2860-universal.jar"), &[
            ("META-INF/MANIFEST.MF", &manifest("net.minecraftforge.fml.relauncher.ServerLaunchWrapper")),
            ("net/minecraftforge/fml/relauncher/ServerLaunchWrapper.class", "x"),
        ]);
        let r = inspect_server_folder(t2.path());
        assert!(r.valid && r.kind == "forge", "{:?}", r);
        assert!(r.jar_name.unwrap().contains("universal"));
    }

    #[test]
    fn fork_desconhecido_que_carrega_o_servidor_dentro() {
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("mohist-1.20.1.jar"), &[
            ("META-INF/MANIFEST.MF", &manifest("com.mohistmc.MohistMCStart")),
            ("net/minecraft/server/MinecraftServer.class", "x"),
            ("org/bukkit/Bukkit.class", "x"),
        ]);
        let r = inspect_server_folder(t.path());
        assert!(r.valid, "{:?}", r);
    }

    #[test]
    fn forge_moderno_pelo_layout() {
        let t = TempDir::new().unwrap();
        std::fs::write(t.path().join("user_jvm_args.txt"), "-Xmx4G\n").unwrap();
        let d = t.path().join("libraries/net/minecraftforge/forge/1.20.1-47.2.0");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("win_args.txt"), "x").unwrap();
        let r = inspect_server_folder(t.path());
        assert!(r.valid && r.kind == "forge-modern" && r.launch_mode.as_deref() == Some("argfile"), "{:?}", r);
        assert_eq!(r.args_dir.as_deref(), Some("libraries/net/minecraftforge/forge/1.20.1-47.2.0"));
        assert_eq!(r.mc_version.as_deref(), Some("1.20.1"));
    }

    // ---- o que NÃO pode virar servidor ----

    #[test]
    fn jar_qualquer_nao_e_servidor() {
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("biblioteca.jar"), &[("com/exemplo/Util.class", "x"), ("META-INF/MANIFEST.MF", &manifest("com.exemplo.App"))]);
        make_jar(&t.path().join("server.jar"), &[("readme.txt", "isto nao e o minecraft")]);
        std::fs::write(t.path().join("falso.jar"), "nem e zip").unwrap();
        let r = inspect_server_folder(t.path());
        assert!(!r.valid, "{:?}", r);
        assert_eq!(r.reason.as_deref(), Some("NO_LAUNCHABLE"));
    }

    #[test]
    fn mod_nao_e_servidor() {
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("sodium.jar"), &[("fabric.mod.json", "{}"), ("me/jellysquid/Sodium.class", "x")]);
        assert!(!inspect_server_folder(t.path()).valid);
    }

    #[test]
    fn jar_do_cliente_nao_vira_servidor_mesmo_com_o_servidor_integrado_dentro() {
        // Jar de cliente real (versions/1.20.1/1.20.1.jar): Main-Class do cliente e MinecraftServer.class dentro.
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("1.20.1.jar"), &[
            ("META-INF/MANIFEST.MF", &manifest("net.minecraft.client.Main")),
            ("net/minecraft/client/main/Main.class", "x"),
            ("net/minecraft/server/MinecraftServer.class", "x"),
            ("version.json", "{\"id\":\"1.20.1\"}"),
        ]);
        let r = inspect_server_folder(t.path());
        assert!(!r.valid && r.reason.as_deref() == Some("CLIENT_INSTALL"), "{:?}", r);
        // cliente alterado por um launcher, sem Main-Class
        let t2 = TempDir::new().unwrap();
        make_jar(&t2.path().join("1.16.5-forge.jar"), &[("net/minecraft/client/Minecraft.class", "x"), ("net/minecraft/server/MinecraftServer.class", "x")]);
        assert!(!inspect_server_folder(t2.path()).valid);
    }

    #[test]
    fn cliente_do_jogo_e_instalador_e_proxy_sao_recusados_com_motivo() {
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("1.20.1.jar"), &[("net/minecraft/client/main/Main.class", "x"), ("net/minecraft/client/Minecraft.class", "x")]);
        assert_eq!(inspect_server_folder(t.path()).reason.as_deref(), Some("CLIENT_INSTALL"));

        let t2 = TempDir::new().unwrap();
        make_jar(&t2.path().join("forge-1.20.1-installer.jar"), &[("install_profile.json", "{}"), ("META-INF/MANIFEST.MF", &manifest("net.minecraftforge.installer.SimpleInstaller"))]);
        assert_eq!(inspect_server_folder(t2.path()).reason.as_deref(), Some("ONLY_INSTALLER"));

        let t3 = TempDir::new().unwrap();
        make_jar(&t3.path().join("velocity.jar"), &[("META-INF/MANIFEST.MF", &manifest("com.velocitypowered.proxy.Velocity"))]);
        assert_eq!(inspect_server_folder(t3.path()).reason.as_deref(), Some("PROXY"));

        let t4 = TempDir::new().unwrap();
        std::fs::write(t4.path().join("launcher_profiles.json"), "{}").unwrap();
        vanilla_bundler(&t4.path().join("server.jar"), "1.20.1");
        assert_eq!(inspect_server_folder(t4.path()).reason.as_deref(), Some("CLIENT_INSTALL"));
    }

    #[test]
    fn instalador_ao_lado_do_servidor_nao_atrapalha() {
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("forge-1.12.2-installer.jar"), &[("install_profile.json", "{}")]);
        vanilla_bundler(&t.path().join("server.jar"), "1.20.1");
        let r = inspect_server_folder(t.path());
        assert!(r.valid && r.jar_name.as_deref() == Some("server.jar"), "{:?}", r);
    }

    #[test]
    fn pasta_vazia_ou_so_com_server_properties_nao_e_servidor() {
        let t = TempDir::new().unwrap();
        assert_eq!(inspect_server_folder(t.path()).reason.as_deref(), Some("NO_LAUNCHABLE"));
        props(t.path());
        assert!(!inspect_server_folder(t.path()).valid, "sem nada para iniciar não adianta ter propriedades");
        assert_eq!(inspect_server_folder(&t.path().join("nao-existe")).reason.as_deref(), Some("NOT_A_DIRECTORY"));
    }

    // ---- degrau de reserva ----

    #[test]
    fn jar_de_assinatura_desconhecida_so_vale_com_evidencia_de_servidor() {
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("start.jar"), &[("META-INF/MANIFEST.MF", &manifest("br.com.fork.Inicio")), ("br/com/fork/Inicio.class", "x")]);
        assert!(!inspect_server_folder(t.path()).valid, "sem evidência: não adivinha");

        props(t.path());
        std::fs::write(t.path().join("eula.txt"), "eula=true\n").unwrap();
        let r = inspect_server_folder(t.path());
        assert!(r.valid && r.kind == "unknown" && r.confidence == "low", "{:?}", r);
    }

    #[test]
    fn reserva_ambigua_nao_chuta() {
        let t = TempDir::new().unwrap();
        make_jar(&t.path().join("a.jar"), &[("META-INF/MANIFEST.MF", &manifest("x.A"))]);
        make_jar(&t.path().join("b.jar"), &[("META-INF/MANIFEST.MF", &manifest("x.B"))]);
        props(t.path());
        assert!(!inspect_server_folder(t.path()).valid);
    }

    #[test]
    fn raiz_do_disco_e_pastas_do_sistema_sao_amplas_demais() {
        assert_eq!(inspect_server_folder(Path::new(std::path::MAIN_SEPARATOR_STR)).reason.as_deref().map(|r| r == "TOO_BROAD" || r == "NOT_A_DIRECTORY"), Some(true));
    }

    #[test]
    fn versao_vem_do_jar_e_do_nome_da_pasta_do_forge() {
        assert_eq!(forge_version_from_args_dir("libraries/net/neoforged/neoforge/21.1.5/x"), None, "NeoForge usa outra numeração");
        assert_eq!(forge_version_from_args_dir("libraries/net/minecraftforge/forge/26.1-60.0.0").as_deref(), Some("26.1"), "numeração nova");
        assert_eq!(forge_version_from_args_dir("libraries/net/minecraftforge/forge/1.19.2-43.2.0").as_deref(), Some("1.19.2"));
        assert!(looks_like_mc_version("1.21") && looks_like_mc_version("1.20.4") && !looks_like_mc_version("1.20.4.1") && !looks_like_mc_version("abc"));
    }

    /// Verificação manual com pastas REAIS (separe por `;`):
    /// `CUBICASE_INSPECT_DIRS="C:\a;C:\b" cargo test pastas_reais -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn pastas_reais() {
        let dirs = std::env::var("CUBICASE_INSPECT_DIRS").unwrap_or_default();
        for d in dirs.split(';').filter(|d| !d.trim().is_empty()) {
            let i = inspect_server_folder(Path::new(d.trim()));
            println!("RESULT {} => valid={} kind={} mode={:?} jar={:?} args={:?} mc={:?} conf={} reason={:?} cand={:?}", d, i.valid, i.kind, i.launch_mode, i.jar_name, i.args_dir, i.mc_version, i.confidence, i.reason, i.candidates);
        }
    }
}
