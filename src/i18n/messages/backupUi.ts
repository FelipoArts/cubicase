import { defineMessages } from "./define";

// Aviso de backup do mundo em andamento (src/app/components/BackupIndicator.tsx).
export default defineMessages({
  "pt-BR": {
    "backupUi.running.title": "Fazendo backup de {name}…",
    "backupUi.running.hint": "Em mundos grandes isso leva alguns minutos. Pode continuar usando o Cubicase, mas não feche o app até terminar.",
    "backupUi.running.remote": "Pedido pelo painel web ou pelo Discord.",
    "backupUi.done.title": "Backup concluído",
    "backupUi.failed.title": "O backup falhou",
  },
  en: {
    "backupUi.running.title": "Backing up {name}…",
    "backupUi.running.hint": "On big worlds this takes a few minutes. You can keep using Cubicase, but don't close the app until it finishes.",
    "backupUi.running.remote": "Requested from the web panel or Discord.",
    "backupUi.done.title": "Backup finished",
    "backupUi.failed.title": "The backup failed",
  },
});
