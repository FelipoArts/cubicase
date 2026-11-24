//! Permissão de rede do Windows (Firewall) para o `cubicase-link.exe`.
//!
//! O transporte P2P abre portas UDP/TCP em todas as interfaces; na primeira vez, o Windows pergunta se o
//! programa pode usar a rede. Aqui ficam três coisas:
//!
//! - `prewarm_firewall`: abre essas portas por um instante, só para a pergunta aparecer num momento previsível
//!   (antes de o app explicar o motivo), e não no meio da primeira conexão.
//! - `firewall_status`: lê (sem administrador) se há regra de bloqueio para o programa — é o que acontece
//!   quando a pessoa clica em Cancelar na pergunta do Windows, que grava um bloqueio e não pergunta mais.
//! - `allow_firewall`: a pedido da pessoa (botão), remove os bloqueios e cria a regra de permissão. Pede UMA
//!   confirmação de administrador (UAC) do próprio Windows.
//!
//! O caminho do programa vem sempre do executável do próprio app, nunca de um valor enviado pelo frontend.

use std::path::PathBuf;

const LINK_EXE: &str = "cubicase-link.exe";

/// Caminho do sidecar instalado ao lado do executável do app (é onde o Tauri o roda).
fn link_exe_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or_else(|| "pasta do app indisponível".to_string())?;
    let path = dir.join(LINK_EXE);
    // `\\?\C:\...` (prefixo estendido) não casa com o caminho que o Windows grava nas regras.
    let text = path.to_string_lossy().to_string();
    Ok(PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text)))
}

/// Texto para dentro de aspas simples do PowerShell: aspas simples são dobradas.
fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

/// Script (somente leitura) que classifica as regras de ENTRADA do programa: none | allowed | blocked | unknown.
pub(crate) fn status_script(program: &str) -> String {
    format!(
        "$ErrorActionPreference='Stop'; $p='{p}'; try {{ \
$f = @(Get-NetFirewallApplicationFilter | Where-Object {{ $_.Program -ieq $p }}); \
$blocked = $false; $allowed = $false; \
foreach ($x in $f) {{ foreach ($r in @($x | Get-NetFirewallRule)) {{ \
if ($r.Direction -eq 'Inbound' -and $r.Enabled -eq 'True') {{ if ($r.Action -eq 'Block') {{ $blocked = $true }} elseif ($r.Action -eq 'Allow') {{ $allowed = $true }} }} }} }}; \
if ($blocked) {{ 'blocked' }} elseif ($allowed) {{ 'allowed' }} else {{ 'none' }} }} catch {{ 'unknown' }}",
        p = ps_quote(program)
    )
}

/// Script (elevado) que tira os bloqueios de entrada do programa e garante uma regra de permissão.
/// Mexe só em regras ligadas a ESTE programa; o `foreach` evita que um filtro vazio vire "todas as regras".
pub(crate) fn allow_script(program: &str) -> String {
    format!(
        "$ErrorActionPreference='Stop'; $p='{p}'; \
$f = @(Get-NetFirewallApplicationFilter | Where-Object {{ $_.Program -ieq $p }}); \
$allowed = $false; \
foreach ($x in $f) {{ foreach ($r in @($x | Get-NetFirewallRule)) {{ \
if ($r.Direction -eq 'Inbound' -and $r.Action -eq 'Block') {{ $r | Remove-NetFirewallRule }} \
elseif ($r.Direction -eq 'Inbound' -and $r.Action -eq 'Allow' -and $r.Enabled -eq 'True') {{ $allowed = $true }} }} }}; \
if (-not $allowed) {{ New-NetFirewallRule -DisplayName 'Cubicase' -Direction Inbound -Program $p -Action Allow -Profile Any | Out-Null }}",
        p = ps_quote(program)
    )
}

/// Comando do PowerShell que roda `script` elevado (UAC). Sai com 2 se a pessoa cancelar a confirmação.
pub(crate) fn elevate_wrapper(script: &str) -> String {
    use base64::Engine;
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    format!(
        "try {{ $pr = Start-Process -FilePath powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden \
-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{encoded}'; exit $pr.ExitCode }} catch {{ exit 2 }}"
    )
}

#[cfg(target_os = "windows")]
fn powershell(command: &str) -> std::process::Command {
    let mut cmd = crate::silent_command("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]);
    cmd
}

/// Abre as portas por alguns segundos (processo separado, que sai sozinho) para o Windows fazer a pergunta agora.
#[tauri::command]
pub async fn prewarm_firewall() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let path = link_exe_path()?;
        if !path.is_file() {
            return Ok(()); // sem o sidecar (ex.: ambiente de desenvolvimento sem build): nada a fazer
        }
        crate::silent_command(&path.to_string_lossy())
            .arg("--prewarm")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// "blocked" (há bloqueio de entrada), "allowed", "none" (sem regra) ou "unknown" (não deu para ler).
#[tauri::command]
pub async fn firewall_status() -> Result<String, String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Ok("unknown".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let path = link_exe_path()?;
        if !path.is_file() {
            return Ok("unknown".to_string());
        }
        let script = status_script(&path.to_string_lossy());
        let run = tokio::task::spawn_blocking(move || powershell(&script).output());
        let out = match tokio::time::timeout(std::time::Duration::from_secs(40), run).await {
            Ok(Ok(Ok(o))) => o,
            _ => return Ok("unknown".to_string()),
        };
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Ok(match text.as_str() {
            "blocked" | "allowed" | "none" => text,
            _ => "unknown".to_string(),
        })
    }
}

/// Remove os bloqueios do programa e cria a regra de permissão, pedindo a confirmação de administrador do Windows.
/// Erro "cancelled" se a pessoa recusar a confirmação.
#[tauri::command]
pub async fn allow_firewall() -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Err("unsupported".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let path = link_exe_path()?;
        if !path.is_file() {
            return Err("missing".to_string());
        }
        let command = elevate_wrapper(&allow_script(&path.to_string_lossy()));
        let status = tokio::task::spawn_blocking(move || powershell(&command).status())
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        match status.code() {
            Some(0) => Ok(()),
            Some(2) => Err("cancelled".to_string()),
            other => Err(format!("failed:{:?}", other)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aspas_simples_no_caminho_sao_dobradas() {
        assert_eq!(ps_quote(r"C:\Users\O'Brien\cubicase-link.exe"), r"C:\Users\O''Brien\cubicase-link.exe");
    }

    #[test]
    fn scripts_so_mexem_em_regras_do_proprio_programa() {
        let allow = allow_script(r"C:\App\cubicase-link.exe");
        // percorre o filtro com foreach (um filtro vazio não vira "todas as regras")
        assert!(allow.contains("foreach ($x in $f)"));
        // só remove bloqueios de ENTRADA, e só os que vieram do filtro do programa
        assert!(allow.contains("$r.Direction -eq 'Inbound' -and $r.Action -eq 'Block'"));
        assert!(!allow.contains("Remove-NetFirewallRule -All"));
        assert!(allow.contains("-Program $p"));
        // somente leitura no status
        let status = status_script(r"C:\App\cubicase-link.exe");
        assert!(!status.contains("Remove-") && !status.contains("New-NetFirewallRule"));
    }

    #[test]
    fn o_comando_elevado_leva_o_script_em_base64_utf16() {
        use base64::Engine;
        let wrapper = elevate_wrapper("Write-Output 'ok'");
        assert!(wrapper.contains("-Verb RunAs") && wrapper.contains("-EncodedCommand"));
        let encoded = base64::engine::general_purpose::STANDARD
            .encode("Write-Output 'ok'".encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<u8>>());
        assert!(wrapper.contains(&encoded));
    }
}
