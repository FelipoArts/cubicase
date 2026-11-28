"use client";

import { useEffect, type ReactNode } from "react";
import { motion } from "framer-motion";
import { useTheme } from "next-themes";
import { useUpdaterStore } from "@/app/updater";
import { useT } from "@/i18n";

// ============================================================
// StartupUpdateGate
// ============================================================
// Atualiza antes de abrir, como a Steam: ao iniciar, o app checa a versão e, havendo uma nova, baixa, instala e
// reinicia ANTES de mostrar qualquer tela. Assim todo mundo usa a versão mais recente.
// Nunca tranca ninguém do lado de fora: sem internet, rede lenta (limite em updater.ts) ou erro na instalação, o app
// abre normalmente na versão atual e o botão "Tentar de novo" continua disponível no topo.
// Com o app já aberto (principalmente o host, que fica horas ligado), nada reinicia sozinho: vale só o aviso do topo.
// ============================================================

export function StartupUpdateGate({ children }: { children: ReactNode }) {
  const startup = useUpdaterStore((s) => s.startup);
  const version = useUpdaterStore((s) => s.version);
  const progress = useUpdaterStore((s) => s.progress);
  const phase = useUpdaterStore((s) => s.phase);
  const { resolvedTheme } = useTheme();
  const { t } = useT();

  useEffect(() => {
    void useUpdaterStore.getState().runStartupUpdate();
  }, []);

  if (startup === "open") return <>{children}</>;

  const updating = startup === "updating";
  const restarting = phase === "ready";

  return (
    <div className="min-h-screen bg-theme-bg flex items-center justify-center p-6">
      <div className="w-full max-w-xs text-center space-y-6">
        <img src={resolvedTheme === "dark" ? "/icon-dark.png" : "/icon.png"} alt="Cubicase" className="h-10 mx-auto" />
        <div className="space-y-2">
          <p className="text-sm font-semibold text-theme-primary">
            {updating
              ? restarting
                ? t("update.restarting")
                : t("update.startup.updating", { version: version ? ` (v${version})` : "" })
              : t("update.startup.checking")}
          </p>
          {updating && <p className="text-xs text-theme-secondary">{t("update.startup.hint")}</p>}
        </div>
        {updating && (
          <div className="space-y-1.5" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="w-full h-2 bg-theme-muted rounded-full overflow-hidden">
              <motion.div className="h-full bg-indigo-600 rounded-full" initial={{ width: 0 }} animate={{ width: `${restarting ? 100 : progress}%` }} />
            </div>
            <div className="text-right text-[10px] font-bold text-theme-secondary">{restarting ? "100%" : `${progress}%`}</div>
          </div>
        )}
      </div>
    </div>
  );
}
