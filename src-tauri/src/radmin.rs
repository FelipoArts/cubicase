// ============================================================
// Endereço do Radmin VPN neste computador
// ============================================================
// Plano B de conexão: quando o caminho direto entre host e amigo não funciona (e o relay não
// está disponível), o app recomenda o Radmin VPN — gratuito, e dispensa abrir portas. O Radmin
// cria uma rede virtual em que cada computador recebe um IPv4 da faixa 26.0.0.0/8; o amigo
// entra no Minecraft por esse IP. Aqui só detectamos o IP do host para o app mostrá-lo pronto
// para copiar, sem o usuário precisar abrir o `ipconfig`.
//
// Lê a saída do `ipconfig` em vez de enumerar adaptadores via API do Windows: não exige
// dependência nova e a faixa 26/8 é exclusiva do Radmin entre as redes que um usuário comum tem.
// ============================================================

use std::net::Ipv4Addr;

/// Primeiro IPv4 da faixa do Radmin (26.x.x.x) encontrado na saída do `ipconfig`.
/// Aceita qualquer idioma: só procura por tokens que sejam um IPv4 começando em 26.
pub fn parse_radmin_ip(ipconfig_output: &str) -> Option<String> {
    ipconfig_output
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .filter_map(|tok| tok.trim_matches('.').parse::<Ipv4Addr>().ok())
        .find(|ip| ip.octets()[0] == 26)
        .map(|ip| ip.to_string())
}

/// IP do Radmin VPN deste computador, se o Radmin estiver instalado e conectado a uma rede.
pub fn detect() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let out = crate::silent_command("ipconfig").output().ok()?;
        parse_radmin_ip(&String::from_utf8_lossy(&out.stdout))
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::parse_radmin_ip;

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
}
