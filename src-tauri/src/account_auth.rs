//! Token de acesso da conta (Supabase) para as chamadas à API Central que dependem de ser o
//! assinante Cubicase Plus — hoje, criar a sessão de hospedagem. O frontend é quem faz o login e
//! renova o token; ele entrega o valor atual aqui (comando `set_private_mode`) e o transporte HTTP
//! o anexa só às sessões de host. Fica apenas em memória: nunca é gravado em disco nem logado.

use std::sync::{Mutex, OnceLock};

static TOKEN: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<String>> {
    TOKEN.get_or_init(|| Mutex::new(None))
}

/// Guarda (ou limpa, com `None`/vazio) o token da conta.
pub fn set(token: Option<String>) {
    *slot().lock().unwrap_or_else(|e| e.into_inner()) = token.filter(|t| !t.trim().is_empty());
}

pub fn bearer() -> Option<String> {
    slot().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guarda_limpa_e_ignora_token_vazio() {
        set(Some("abc.def.ghi".into()));
        assert_eq!(bearer().as_deref(), Some("abc.def.ghi"));
        set(Some("   ".into())); // token em branco equivale a deslogado
        assert_eq!(bearer(), None);
        set(Some("x".into()));
        set(None);
        assert_eq!(bearer(), None);
    }
}
