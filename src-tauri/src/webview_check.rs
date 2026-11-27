//! Aviso amigável quando o Microsoft Edge WebView2 Runtime não está instalado.
//!
//! O Cubicase desenha a interface com o WebView2. O instalador já o instala quando falta, mas há casos em que ele
//! pode estar ausente na hora de abrir o app (um Windows muito enxuto, como o Windows Sandbox, uma instalação feita
//! sem internet, o runtime removido depois). Sem ele, a biblioteca de janelas mostra só "Could not find the WebView2
//! Runtime", em inglês e sem dizer o que fazer. Aqui a checagem roda ANTES de a janela existir e mostra uma mensagem
//! clara, no idioma do Windows, com a opção de abrir o download.
//!
//! A detecção usa a API OFICIAL do carregador do WebView2 (`GetAvailableCoreWebView2BrowserVersionString`), a mesma
//! que a janela do app usa para achar o runtime. Antes ela lia só o registro, e isso engana: o registro pode dizer
//! "instalado" enquanto os arquivos não existem (visto no Windows Sandbox), e aí o app falhava mesmo "com" runtime.
//! Como um falso "não achei" não pode trancar quem tem o runtime por outro caminho, a mensagem sempre deixa "abrir
//! mesmo assim".

/// Download direto do instalador (bootstrapper) oficial da Microsoft.
#[cfg(any(windows, test))]
const BOOTSTRAPPER_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

/// A versão devolvida pelo carregador indica um runtime utilizável? (vazio ou "0.0.0.0" = não)
pub(crate) fn version_means_installed(pv: Option<&str>) -> bool {
    match pv.map(str::trim) {
        Some(v) => !v.is_empty() && v != "0.0.0.0",
        None => false,
    }
}

/// "158.0.4370.33" -> [158, 0, 4370, 33]; qualquer outra coisa (ex.: "SetupMetrics") -> None.
#[cfg(any(windows, test))]
pub(crate) fn parse_version(name: &str) -> Option<Vec<u32>> {
    let parts: Vec<u32> = name.split('.').map(|p| p.parse::<u32>().ok()).collect::<Option<Vec<_>>>()?;
    (parts.len() >= 2).then_some(parts)
}

/// Entre as subpastas de `parent` (`...\EdgeWebView\Application`), a de maior versão que traz o `msedgewebview2.exe`.
/// É o runtime que existe de verdade em disco, quer o registro concorde ou não.
#[cfg(any(windows, test))]
pub(crate) fn newest_runtime_dir(parent: &std::path::Path) -> Option<std::path::PathBuf> {
    std::fs::read_dir(parent)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let version = parse_version(&e.file_name().to_string_lossy())?;
            path.join("msedgewebview2.exe").is_file().then_some((version, path))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, path)| path)
}

/// Textos da mensagem: (título, corpo) em português se o Windows estiver em português, senão em inglês.
pub(crate) fn message_texts(portuguese: bool) -> (&'static str, &'static str) {
    if portuguese {
        (
            "Cubicase",
            "O Cubicase precisa do Microsoft Edge WebView2 Runtime para abrir, e ele não foi encontrado neste computador.\n\n\
Sim: abrir o download (instale e depois abra o Cubicase de novo).\n\
Não: tentar abrir o Cubicase mesmo assim.\n\
Cancelar: fechar.",
        )
    } else {
        (
            "Cubicase",
            "Cubicase needs the Microsoft Edge WebView2 Runtime to open, and it was not found on this computer.\n\n\
Yes: open the download (install it, then open Cubicase again).\n\
No: try to open Cubicase anyway.\n\
Cancel: close.",
        )
    }
}

/// Devolve `true` para seguir abrindo o app e `false` para encerrar. Em sistemas que não são Windows, sempre `true`.
pub fn ensure_webview2() -> bool {
    #[cfg(windows)]
    {
        windows_impl::ensure()
    }
    #[cfg(not(windows))]
    {
        true
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use webview2_com_sys::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
    use windows_core::{PCWSTR, PWSTR};
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDCANCEL, IDYES, MB_ICONWARNING, MB_YESNOCANCEL, SW_SHOWNORMAL};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Versão do runtime que o carregador do WebView2 acharia agora (None = nenhum utilizável). É o mesmo caminho que a
    /// janela do app percorre, então responde exatamente "a janela vai abrir?".
    pub(super) fn available_version() -> Option<String> {
        unsafe {
            let mut version = PWSTR::null();
            let result = GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version);
            if version.is_null() {
                return None;
            }
            let text = version.to_string().ok();
            CoTaskMemFree(version.0 as *const core::ffi::c_void);
            if result.is_err() {
                return None;
            }
            text.filter(|v| version_means_installed(Some(v)))
        }
    }

    /// Versão que o carregador enxerga numa pasta de runtime EXPLÍCITA (sem passar pelo registro).
    pub(super) fn version_in_folder(folder: &std::path::Path) -> Option<String> {
        let folder_w = wide(&folder.to_string_lossy());
        unsafe {
            let mut version = PWSTR::null();
            let result = GetAvailableCoreWebView2BrowserVersionString(PCWSTR(folder_w.as_ptr()), &mut version);
            if version.is_null() {
                return None;
            }
            let text = version.to_string().ok();
            CoTaskMemFree(version.0 as *const core::ffi::c_void);
            if result.is_err() {
                return None;
            }
            text.filter(|v| version_means_installed(Some(v)))
        }
    }

    /// O runtime está em disco mas o registro não bate (visto no Windows Sandbox: o registro aponta uma versão e os
    /// arquivos são de outra). Acha a pasta real, confere que o carregador a aceita e devolve o caminho.
    pub(super) fn runtime_dir_on_disk() -> Option<std::path::PathBuf> {
        ["ProgramFiles(x86)", "ProgramFiles"].iter().find_map(|var| {
            let base = std::env::var_os(var)?;
            let parent = std::path::Path::new(&base).join(r"Microsoft\EdgeWebView\Application");
            let dir = newest_runtime_dir(&parent)?;
            version_in_folder(&dir).map(|_| dir)
        })
    }

    fn windows_in_portuguese() -> bool {
        // Idioma de exibição do usuário: o byte baixo é o idioma primário (0x16 = português).
        let lang = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() };
        (lang & 0xFF) == 0x16
    }

    pub fn ensure() -> bool {
        if available_version().is_some() {
            return true;
        }
        // O carregador não achou pelo registro, mas o runtime pode estar em disco: aponta a janela direto para ele.
        // `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` é o ajuste oficial do carregador para isso.
        if let Some(dir) = runtime_dir_on_disk() {
            std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &dir);
            return true;
        }
        let (title, body) = message_texts(windows_in_portuguese());
        let (title_w, body_w) = (wide(title), wide(body));
        let answer = unsafe { MessageBoxW(std::ptr::null_mut(), body_w.as_ptr(), title_w.as_ptr(), MB_YESNOCANCEL | MB_ICONWARNING) };
        if answer == IDYES {
            unsafe {
                ShellExecuteW(std::ptr::null_mut(), wide("open").as_ptr(), wide(BOOTSTRAPPER_URL).as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
            }
            return false;
        }
        answer != IDCANCEL
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versao_vazia_ou_zerada_nao_conta_como_instalado() {
        assert!(!version_means_installed(None));
        assert!(!version_means_installed(Some("")));
        assert!(!version_means_installed(Some("  ")));
        assert!(!version_means_installed(Some("0.0.0.0")));
        assert!(version_means_installed(Some("131.0.2903.112")));
    }

    /// Só confere que consultar o carregador não quebra (o valor depende da máquina: onde o app roda há runtime).
    #[cfg(windows)]
    #[test]
    fn consulta_ao_carregador_funciona_sem_quebrar() {
        let versao = super::windows_impl::available_version();
        eprintln!("WebView2 encontrado pelo carregador: {versao:?}");
    }

    #[test]
    fn acha_a_pasta_de_maior_versao_com_o_executavel() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mk = |name: &str, with_exe: bool| {
            let d = tmp.path().join(name);
            std::fs::create_dir_all(&d).unwrap();
            if with_exe {
                std::fs::write(d.join("msedgewebview2.exe"), b"x").unwrap();
            }
        };
        mk("157.0.4341.60", true);
        mk("158.0.4370.33", true);
        mk("159.0.1.1", false); // maior, mas vazia: não serve
        mk("SetupMetrics", true); // nome que não é versão: ignorado
        let found = newest_runtime_dir(tmp.path()).unwrap();
        assert_eq!(found.file_name().unwrap(), "158.0.4370.33");
        // comparação numérica, não de texto: 99 < 158
        mk("99.0.0.1", true);
        assert_eq!(newest_runtime_dir(tmp.path()).unwrap().file_name().unwrap(), "158.0.4370.33");
        assert!(newest_runtime_dir(&tmp.path().join("nao-existe")).is_none());
    }

    #[test]
    fn so_nomes_de_versao_contam() {
        assert_eq!(parse_version("158.0.4370.33"), Some(vec![158, 0, 4370, 33]));
        assert_eq!(parse_version("SetupMetrics"), None);
        assert_eq!(parse_version("158"), None);
        assert_eq!(parse_version("1.x.3"), None);
    }

    /// Onde o app roda há runtime: a pasta achada em disco precisa ser aceita pelo carregador (é o que o conserto usa).
    #[cfg(windows)]
    #[test]
    fn pasta_do_runtime_em_disco_e_aceita_pelo_carregador() {
        if let Some(dir) = super::windows_impl::runtime_dir_on_disk() {
            eprintln!("runtime em disco: {dir:?}");
            assert!(super::windows_impl::version_in_folder(&dir).is_some());
        }
    }

    #[test]
    fn mensagem_existe_nos_dois_idiomas_e_explica_as_tres_opcoes() {
        for pt in [true, false] {
            let (title, body) = message_texts(pt);
            assert_eq!(title, "Cubicase");
            assert!(body.contains("WebView2"));
            assert_eq!(body.lines().filter(|l| l.contains(':')).count(), 3, "uma linha por botão");
        }
        assert!(BOOTSTRAPPER_URL.starts_with("https://go.microsoft.com/"));
    }
}
