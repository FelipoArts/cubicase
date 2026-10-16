// ============================================================
// Plano B de conexão: Radmin VPN
// ============================================================
// Quando o caminho direto entre host e amigo não funciona (e o relay não resolve), o app guia o uso do
// Radmin VPN — gratuito, dispensa abrir portas. O Radmin cria uma rede virtual em que cada computador
// recebe um IPv4 da faixa 26.0.0.0/8; o amigo entra no Minecraft por esse IP.
//
// O que este módulo faz (e só usa o que o Windows expõe — o contrato do Radmin proíbe engenharia
// reversa e não há linha de comando nem API oficial para criar/entrar numa rede):
//   - detectar se o Radmin está instalado, se o serviço roda e qual o IP do adaptador;
//   - instalar pelo `winget` (pacote oficial Famatech.RadminVPN) quando o usuário pedir;
//   - testar se um IP da rede do Radmin responde numa porta (o "o host está alcançável?");
//   - liberar no firewall o Java do servidor para a rede do Radmin (o Windows trata essa rede como
//     Pública, onde o Minecraft do host fica bloqueado por padrão), com UMA confirmação de administrador.
// O nome e a senha da rede NÃO passam por aqui nem são guardados: o Radmin não permite verificar se
// continuam valendo, então o app só gera uma sugestão na tela e a verdade é sempre o teste de alcance.
// ============================================================

use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

#[derive(Serialize, Clone, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RadminStatus {
    /// Os arquivos do Radmin VPN estão no computador.
    pub installed: bool,
    /// O serviço do Radmin (RvControlSvc) está rodando.
    pub running: bool,
    /// IPv4 do adaptador do Radmin (faixa 26.x.x.x), se ele estiver conectado a alguma rede.
    pub ip: Option<String>,
}

// ---------------- partes puras (testadas) ----------------

/// Primeiro IPv4 da faixa do Radmin (26.x.x.x) encontrado na saída do `ipconfig`.
/// Aceita qualquer idioma: só procura por tokens que sejam um IPv4 começando em 26.
pub fn parse_radmin_ip(ipconfig_output: &str) -> Option<String> {
    ipconfig_output
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .filter_map(|tok| tok.trim_matches('.').parse::<Ipv4Addr>().ok())
        .find(|ip| ip.octets()[0] == 26)
        .map(|ip| ip.to_string())
}

/// `host` é um IPv4 da faixa do Radmin (26.0.0.0/8)? Usado para nunca deixar a interface pedir testes de
/// conexão para endereços quaisquer (o comando de teste viraria um escaneador de portas).
pub fn is_radmin_ip(host: &str) -> bool {
    host.parse::<Ipv4Addr>().map(|ip| ip.octets()[0] == 26).unwrap_or(false)
}

/// Código de estado da saída do `sc query` (4 = RUNNING). Independe do idioma do Windows.
pub fn parse_service_state(sc_output: &str) -> Option<u32> {
    sc_output.lines().find_map(|line| {
        let l = line.trim_start();
        let rest = l.strip_prefix("STATE").or_else(|| l.strip_prefix("ESTADO"))?;
        let rest = rest.trim_start().strip_prefix(':')?;
        rest.trim_start().split_whitespace().next()?.parse().ok()
    })
}

/// Rótulo estável de uma regra de firewall a partir do executável: `…\runtime\java-17\bin\java.exe` →
/// "java-17"; qualquer outro (o próprio app) → "app".
pub fn rule_label(program: &Path) -> String {
    let comps: Vec<String> = program.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
    if let Some(i) = comps.iter().rposition(|c| c.eq_ignore_ascii_case("runtime")) {
        if let Some(name) = comps.get(i + 1) {
            return name.clone();
        }
    }
    "app".to_string()
}

pub fn rule_name(program: &Path) -> String {
    format!("Cubicase Radmin - {}", rule_label(program))
}

/// Caminho seguro para ir dentro de um script do PowerShell entre aspas duplas?
fn path_is_script_safe(p: &Path) -> bool {
    let s = p.to_string_lossy();
    !s.is_empty() && !s.chars().any(|c| matches!(c, '"' | '\'' | '`' | '$' | ';' | '\n' | '\r' | '&' | '|' | '<' | '>'))
}

/// Script (PowerShell) que recria, de forma idempotente, as regras de entrada: permitir o programa só para
/// quem vem da faixa 26.0.0.0/8 (a rede do Radmin), em qualquer perfil de rede.
pub fn build_firewall_script(rules: &[(String, PathBuf)]) -> String {
    let mut s = String::from("$ErrorActionPreference = 'Stop'\n");
    for (name, program) in rules {
        s.push_str(&format!(
            "netsh advfirewall firewall delete rule name=\"{n}\" | Out-Null\nnetsh advfirewall firewall add rule name=\"{n}\" dir=in action=allow program=\"{p}\" remoteip=26.0.0.0/8 profile=any enable=yes description=\"Cubicase: amigos na rede do Radmin VPN\" | Out-Null\nif ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}\n",
            n = name,
            p = program.display()
        ));
    }
    s
}

/// `-EncodedCommand` do PowerShell: o script em UTF-16 little-endian, em base64 (evita qualquer problema de aspas).
pub fn encode_powershell(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// ---------------- leitura do estado ----------------

fn install_dirs() -> Vec<PathBuf> {
    ["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"]
        .iter()
        .filter_map(|var| std::env::var_os(var))
        .map(|base| PathBuf::from(base).join("Radmin VPN"))
        .collect()
}

pub fn is_installed() -> bool {
    install_dirs().iter().any(|d| d.join("RvRvpnGui.exe").is_file())
}

pub fn service_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = crate::silent_command("sc").args(["query", "RvControlSvc"]).output() {
            return parse_service_state(&String::from_utf8_lossy(&out.stdout)) == Some(4);
        }
    }
    false
}

fn read_ip() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let out = crate::silent_command("ipconfig").output().ok()?;
        return parse_radmin_ip(&String::from_utf8_lossy(&out.stdout));
    }
    #[allow(unreachable_code)]
    None
}

/// Estado atual (executa processos: chame fora da thread da interface).
pub fn status() -> RadminStatus {
    let installed = is_installed();
    let running = installed && service_running();
    let ip = if running { read_ip() } else { None };
    RadminStatus { installed, running, ip }
}

/// IP do Radmin deste computador, se conectado (mantido para compatibilidade).
pub fn detect() -> Option<String> {
    status().ip
}

static CACHE: OnceLock<Mutex<RadminStatus>> = OnceLock::new();

fn cache() -> &'static Mutex<RadminStatus> {
    CACHE.get_or_init(|| Mutex::new(RadminStatus::default()))
}

/// Último estado visto pelo supervisor (barato; sem executar nada). Usado no heartbeat do host.
pub fn cached() -> RadminStatus {
    cache().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn cached_ip() -> Option<String> {
    cached().ip
}

/// Guarda o estado e diz se mudou em relação ao anterior.
pub fn store_status(new: RadminStatus) -> bool {
    let mut guard = cache().lock().unwrap_or_else(|e| e.into_inner());
    let changed = *guard != new;
    *guard = new;
    changed
}

// ---------------- teste de alcance ----------------

/// O IP do Radmin responde (conexão TCP) nesta porta? Só aceita endereços da faixa do Radmin.
pub fn probe(host: &str, port: u16, timeout: Duration) -> bool {
    if !is_radmin_ip(host) || port < 1024 {
        return false;
    }
    let Ok(ip) = host.parse::<Ipv4Addr>() else { return false };
    TcpStream::connect_timeout(&SocketAddr::from((ip, port)), timeout).is_ok()
}

// ---------------- instalação ----------------

pub fn winget_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        return crate::silent_command("winget").arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

/// Instala o Radmin VPN pelo winget (pacote oficial `Famatech.RadminVPN`). O instalador pede a confirmação
/// de administrador do Windows. Só devolve Ok se o Radmin realmente passou a existir no computador.
/// Erros: "WINGET_MISSING", "INSTALL_FAILED".
pub fn install_with_winget() -> Result<(), String> {
    if is_installed() {
        return Ok(());
    }
    if !winget_available() {
        return Err("WINGET_MISSING".into());
    }
    #[cfg(target_os = "windows")]
    {
        let _ = crate::silent_command("winget")
            .args([
                "install", "--id", "Famatech.RadminVPN", "--exact", "--silent",
                "--accept-package-agreements", "--accept-source-agreements",
            ])
            .status();
        // O código de saída do winget não é confiável (já instalado, reinício pendente...): vale o que existe no disco.
        for _ in 0..20 {
            if is_installed() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    Err("INSTALL_FAILED".into())
}

// ---------------- firewall ----------------

/// Programas que precisam aceitar conexões vindas da rede do Radmin: o Java de cada runtime do Cubicase
/// (o servidor Minecraft) e o próprio app (o servidor local de mods).
pub fn firewall_programs(app_data_dir: &Path) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(rd) = std::fs::read_dir(app_data_dir.join("runtime")) {
        for e in rd.flatten() {
            let java = e.path().join("bin").join("java.exe");
            if java.is_file() {
                v.push(java);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        v.push(exe);
    }
    v
}

fn rule_exists(name: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        // `netsh ... show rule` sai com erro quando nenhuma regra tem esse nome (não depende do idioma).
        return crate::silent_command("netsh")
            .args(["advfirewall", "firewall", "show", "rule", &format!("name={}", name)])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

/// Regras que ainda não existem.
pub fn missing_firewall_rules(app_data_dir: &Path) -> Vec<(String, PathBuf)> {
    firewall_programs(app_data_dir)
        .into_iter()
        .map(|p| (rule_name(&p), p))
        .filter(|(name, _)| !rule_exists(name))
        .collect()
}

/// Cria as regras que faltam, com UMA confirmação de administrador. Erros: "CANCELLED", "FAILED".
pub fn allow_firewall(app_data_dir: &Path) -> Result<(), String> {
    let missing = missing_firewall_rules(app_data_dir);
    if missing.is_empty() {
        return Ok(());
    }
    if missing.iter().any(|(_, p)| !path_is_script_safe(p)) {
        return Err("FAILED".into());
    }
    #[cfg(target_os = "windows")]
    {
        let encoded = encode_powershell(&build_firewall_script(&missing));
        let launcher = format!(
            "Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{}'",
            encoded
        );
        let ok = crate::silent_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &launcher])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return Err("CANCELLED".into()); // não aceitou a confirmação do Windows
        }
        return if missing_firewall_rules(app_data_dir).is_empty() { Ok(()) } else { Err("FAILED".into()) };
    }
    #[allow(unreachable_code)]
    Err("FAILED".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acha_o_ip_do_radmin_em_saida_em_portugues() {
        let out = "Adaptador Ethernet Radmin VPN:\n\n   Endereço IPv4. . . . . . . . . . . . . . : 26.202.7.93\n   Máscara de Sub-rede . . . . . . . . . . : 255.0.0.0\n\nAdaptador Ethernet Ethernet:\n   Endereço IPv4. . . . . . . . . . . . . . : 192.168.1.15\n";
        assert_eq!(parse_radmin_ip(out).as_deref(), Some("26.202.7.93"));
    }

    #[test]
    fn acha_o_ip_do_radmin_em_saida_em_ingles() {
        let out = "Ethernet adapter Radmin VPN:\n   IPv4 Address. . . . . . . . . . . : 26.1.2.3\n   Subnet Mask . . . . . . . . . . . : 255.0.0.0\n";
        assert_eq!(parse_radmin_ip(out).as_deref(), Some("26.1.2.3"));
    }

    #[test]
    fn sem_radmin_nao_devolve_nada() {
        let out = "   IPv4 Address. . . : 192.168.1.15\n   IPv4 Address. . . : 172.16.16.145\n   Default Gateway . : 192.168.1.1\n";
        assert_eq!(parse_radmin_ip(out), None);
    }

    #[test]
    fn nao_confunde_octetos_que_apenas_contem_26() {
        // 126.x e 192.168.26.x não são a faixa do Radmin; a máscara 255.255.255.26 também não.
        let out = "IPv4 Address: 126.5.5.5\nIPv4 Address: 192.168.26.10\nMask: 255.255.255.26\n";
        assert_eq!(parse_radmin_ip(out), None);
    }

    #[test]
    fn ignora_ipv6_e_numeros_soltos() {
        let out = "IPv6: fe80::26:1%12\nPorta 26\nIPv4: 26.9.9.9.";
        assert_eq!(parse_radmin_ip(out).as_deref(), Some("26.9.9.9"));
    }

    #[test]
    fn so_a_faixa_do_radmin_e_aceita_no_teste_de_alcance() {
        assert!(is_radmin_ip("26.202.7.93"));
        for no in ["127.0.0.1", "192.168.1.5", "100.64.0.1", "26.1.1", "26.300.1.1", "evil.com", "", "26.1.1.1:80", "0.0.0.0"] {
            assert!(!is_radmin_ip(no), "{no}");
        }
        // e o teste de conexão se recusa a olhar para qualquer outro endereço (nem tenta conectar)
        assert!(!probe("127.0.0.1", 25565, Duration::from_millis(50)));
        assert!(!probe("26.1.1.1", 80, Duration::from_millis(50))); // portas baixas: nunca
    }

    #[test]
    fn estado_do_servico_vem_do_codigo_numerico_em_qualquer_idioma() {
        let en = "SERVICE_NAME: RvControlSvc\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : 4  RUNNING\n";
        let pt = "NOME_DO_SERVIÇO: RvControlSvc\n        TIPO               : 10  WIN32_OWN_PROCESS\n        ESTADO             : 1  STOPPED\n";
        assert_eq!(parse_service_state(en), Some(4));
        assert_eq!(parse_service_state(pt), Some(1));
        assert_eq!(parse_service_state("O serviço especificado não existe"), None);
    }

    #[test]
    fn regra_de_firewall_tem_nome_estavel_por_runtime() {
        let java = Path::new(r"C:\Users\ana\AppData\Local\com.cubicase.app\runtime\java-17\bin\java.exe");
        assert_eq!(rule_name(java), "Cubicase Radmin - java-17");
        assert_eq!(rule_name(Path::new(r"C:\Users\ana\AppData\Local\Cubicase\app.exe")), "Cubicase Radmin - app");
    }

    #[test]
    fn script_do_firewall_limita_a_faixa_do_radmin_e_nao_abre_nada_a_mais() {
        let rules = vec![("Cubicase Radmin - java-17".to_string(), PathBuf::from(r"C:\x\java.exe"))];
        let s = build_firewall_script(&rules);
        assert!(s.contains("remoteip=26.0.0.0/8"), "{s}");
        assert!(s.contains("program=\"C:\\x\\java.exe\""));
        assert!(s.contains("dir=in action=allow"));
        assert!(s.contains("delete rule name=\"Cubicase Radmin - java-17\""), "recria sem duplicar");
        assert!(!s.contains("remoteip=any") && !s.contains("remoteip=*"));
    }

    #[test]
    fn caminhos_com_caracteres_de_script_nao_entram_no_comando_elevado() {
        assert!(path_is_script_safe(Path::new(r"C:\Users\João Silva\AppData\Local\x\java.exe")));
        for bad in [r#"C:\a"b\java.exe"#, r"C:\a'b\java.exe", r"C:\a;rm\java.exe", r"C:\a$x\java.exe", r"C:\a`b\java.exe", r"C:\a&b\java.exe"] {
            assert!(!path_is_script_safe(Path::new(bad)), "{bad}");
        }
    }

    #[test]
    fn comando_codificado_e_utf16_em_base64() {
        use base64::Engine;
        let enc = encode_powershell("ab");
        let raw = base64::engine::general_purpose::STANDARD.decode(enc).unwrap();
        assert_eq!(raw, vec![b'a', 0, b'b', 0]);
    }

    #[test]
    fn so_registra_mudanca_quando_o_estado_muda() {
        let a = RadminStatus { installed: true, running: true, ip: Some("26.1.2.3".into()) };
        store_status(RadminStatus::default());
        assert!(store_status(a.clone()));
        assert!(!store_status(a.clone()), "mesmo estado: sem mudança");
        assert!(store_status(RadminStatus { ip: None, ..a }));
    }
}
