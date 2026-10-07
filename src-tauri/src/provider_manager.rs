use crate::api_client::ConnectionSessionResponse;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tokio::sync::mpsc;
use std::io::Write;

/// ProviderManager — sabe qual sidecar iniciar baseado no launcher
/// Recebe credentials como blob opaco — não sabe o formato.
pub struct ProviderManager;

impl ProviderManager {
    pub fn new() -> Self {
        Self
    }

    /// Inicia o sidecar apropriado baseado no launcher.
    pub async fn start_provider(
        &self,
        app: &AppHandle,
        session: &ConnectionSessionResponse,
        mode: &str,
        local_port: u16,
        target_ip: Option<&str>,
    ) -> Result<(CommandChild, mpsc::Receiver<CommandEvent>), String> {
        match session.launcher.as_str() {
            "tsnet-v1" => {
                self.start_tsnet(app, &session.credentials, mode, local_port, &session.session_id, target_ip).await
            }
            "link-v1" => {
                self.start_link(app, &session.credentials, mode, local_port).await
            }
            "mock-v1" => {
                self.start_mock(app, &session.credentials, mode, local_port).await
            }
            other => Err(tr!("provider.launcherUnsupported", launcher = other)),
        }
    }

    /// Inicia o sidecar tsnet-node (Tailscale) com arquivo temporário
    async fn start_tsnet(
        &self,
        app: &AppHandle,
        credentials: &serde_json::Value,
        mode: &str,
        local_port: u16,
        session_id: &str,
        target_ip: Option<&str>,
    ) -> Result<(CommandChild, mpsc::Receiver<CommandEvent>), String> {
        let auth_key = credentials.get("auth_key")
            .or_else(|| credentials.get("authKey"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| tr!("provider.noAuthKey"))?;

        let hostname = credentials.get("hostname")
            .and_then(|v| v.as_str())
            .unwrap_or("cubeforge-node");

        // Criar pasta de dados
        let data_dir = app.path().app_local_data_dir()
            .map_err(|e| tr!("provider.dataDir", error = e))?;
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| tr!("provider.dataDirCreate", error = e))?;

        // Criar arquivo temporário de configuração
        let config_path = data_dir.join(format!("tsnet_{}.json", session_id));
        let config = serde_json::json!({
            "authKey": auth_key,
            "hostname": hostname,
            "mode": mode,
            "targetIp": target_ip,
            "localPort": local_port,
        });
        let config_str = serde_json::to_string(&config)
            .map_err(|e| tr!("provider.serializeConfig", error = e))?;
        
        let mut file = std::fs::File::create(&config_path)
            .map_err(|e| tr!("provider.tempFile", error = e))?;
        file.write_all(config_str.as_bytes())
            .map_err(|e| tr!("provider.writeConfig", error = e))?;

        let config_path_str = config_path.to_string_lossy().to_string();
        let shell = app.shell();
        // Tauri v2 spawn retorna (Receiver<CommandEvent>, CommandChild)
        let (mut rx, child) = shell
            .sidecar("tsnet-node")
            .map_err(|e| tr!("provider.createSidecar", error = e))?
            .args(["--config", &config_path_str])
            .spawn()
            .map_err(|e| tr!("provider.spawnSidecar", error = e))?;

        Ok((child, rx))
    }

    /// Inicia o sidecar do transporte P2P (cubicase-link). A configuração (que inclui o token da
    /// sala e as credenciais do relay) vai pelo STDIN do processo — nunca para um arquivo em disco.
    /// O sidecar sai sozinho se o stdin fechar, então o `CommandChild` precisa continuar vivo no
    /// estado do app enquanto a rede estiver de pé (já é assim para todo provedor).
    async fn start_link(
        &self,
        app: &AppHandle,
        credentials: &serde_json::Value,
        mode: &str,
        local_port: u16,
    ) -> Result<(CommandChild, mpsc::Receiver<CommandEvent>), String> {
        let cfg = build_link_config(credentials, mode, local_port)?;
        let line = format!("{}\n", serde_json::to_string(&cfg).map_err(|e| tr!("provider.serializeConfig", error = e))?);

        let (rx, mut child) = app
            .shell()
            .sidecar("cubicase-link")
            .map_err(|e| tr!("provider.createSidecar", error = e))?
            .args(["--stdin"])
            .spawn()
            .map_err(|e| tr!("provider.spawnSidecar", error = e))?;
        child.write(line.as_bytes()).map_err(|e| tr!("provider.writeConfig", error = e))?;
        Ok((child, rx))
    }

    /// Inicia o provider Mock (para desenvolvimento offline)
    async fn start_mock(
        &self,
        _app: &AppHandle,
        credentials: &serde_json::Value,
        _mode: &str,
        _local_port: u16,
    ) -> Result<(CommandChild, mpsc::Receiver<CommandEvent>), String> {
        let _fake_ip = credentials.get("fakeIp")
            .and_then(|v| v.as_str())
            .unwrap_or("100.99.99.99");

        // Mock não precisa de sidecar real
        // Para simplificar, retornamos erro indicando que o mock deve ser tratado separadamente
        Err(tr!("provider.mockNoSidecar"))
    }
}
/// Monta a configuração do cubicase-link a partir das credenciais opacas da sessão `link-v1`
/// (ver buildLinkCredentials no Worker e Config em sidecars/cubicase-link/config.go).
pub fn build_link_config(credentials: &serde_json::Value, mode: &str, local_port: u16) -> Result<serde_json::Value, String> {
    let get = |k: &str| credentials.get(k).and_then(|v| v.as_str()).filter(|v| !v.is_empty());
    let signal_url = get("signalUrl").ok_or_else(|| tr!("provider.link.incomplete"))?;
    let signal_token = get("signalToken").ok_or_else(|| tr!("provider.link.incomplete"))?;
    let peer_id = get("peerId").ok_or_else(|| tr!("provider.link.incomplete"))?;
    Ok(serde_json::json!({
        "mode": mode,
        "peerId": peer_id,
        "signalUrl": signal_url,
        "signalToken": signal_token,
        "ice": credentials.get("ice").cloned().unwrap_or_else(|| serde_json::json!({ "stunUrls": [] })),
        "relayOnly": credentials.get("relayOnly").and_then(|v| v.as_bool()).unwrap_or(false),
        "localPort": local_port,
        // Servidor HTTP local do app (lista/arquivos de mods) e proxy de mods do convidado.
        "registryPort": 25567,
        "modsPort": 25568,
        "maxGuests": 20,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_config_maps_session_credentials_and_fixed_ports() {
        let creds = serde_json::json!({
            "signalUrl": "wss://api.example/api/v1/link/ws/ABC123",
            "signalToken": "tok", "peerId": "sess-1", "relayOnly": true,
            "ice": { "stunUrls": ["stun:x:1"], "turn": { "urls": ["turn:t:3478"], "username": "u", "credential": "c" } },
        });
        let cfg = build_link_config(&creds, "host", 25565).unwrap();
        assert_eq!(cfg["mode"], "host");
        assert_eq!(cfg["peerId"], "sess-1");
        assert_eq!(cfg["signalToken"], "tok");
        assert_eq!(cfg["relayOnly"], true);
        assert_eq!(cfg["ice"]["turn"]["username"], "u");
        assert_eq!((cfg["localPort"].as_u64(), cfg["registryPort"].as_u64(), cfg["modsPort"].as_u64()), (Some(25565), Some(25567), Some(25568)));
    }

    #[test]
    fn link_config_rejects_incomplete_credentials() {
        for creds in [
            serde_json::json!({}),
            serde_json::json!({ "signalUrl": "wss://x", "peerId": "p" }),
            serde_json::json!({ "signalUrl": "", "signalToken": "t", "peerId": "p" }),
        ] {
            assert!(build_link_config(&creds, "guest", 25565).is_err(), "{creds}");
        }
    }
}
