; Ganchos do instalador NSIS (ver bundle > windows > nsis > installerHooks em tauri.conf.json).
;
; Sem a tela de escolha de idioma (displayLanguageSelector = false), o instalador usa o idioma do
; Windows, mas NÃO grava essa escolha no registro. O desinstalador lê o idioma justamente dali
; (MUI_UNGETLANGUAGE), então sem esta linha ele não sabe qual idioma usar e cai no inglês padrão.
; Gravamos aqui o idioma em uso, no mesmo lugar e com o mesmo nome que o desinstalador procura.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "${MANUPRODUCTKEY}" "Installer Language" "$LANGUAGE"
!macroend
