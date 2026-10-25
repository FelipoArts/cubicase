"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Terminal, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

// Gaveta do console: fixa embaixo, em qualquer aba. Fechada, mostra só a última linha; aberta, o log inteiro com o
// campo de comando. Duas abas, como no console de hoje: Minecraft e conexão com os amigos.

interface Props {
  mcLogs: string[];
  networkLogs: string[];
  serverStatus: string;
  onSendCommand: (command: string) => void;
  onClearLogs: (tab: "minecraft" | "network") => void;
}

export function Dock({ mcLogs, networkLogs, serverStatus, onSendCommand, onClearLogs }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"minecraft" | "network">("minecraft");
  const [cmd, setCmd] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lines = tab === "minecraft" ? mcLogs : networkLogs;
  const last = mcLogs[mcLogs.length - 1];
  const running = serverStatus === "online" || serverStatus === "starting";

  // Só acompanha o fim se a pessoa já estava lá (não puxa para baixo quem está lendo o começo).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines, open, tab]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = cmd.trim();
    if (!text) return;
    onSendCommand(text);
    setCmd("");
  }

  return (
    <section className={cn("shrink-0 border-t border-theme-console bg-theme-console text-slate-200 flex flex-col", open ? "h-[min(18rem,40vh)]" : "h-11")} aria-label={t("nui.console")}>
      <div className="h-11 shrink-0 flex items-center">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="h-11 flex-1 min-w-0 px-5 flex items-center gap-3 text-left cursor-pointer hover:bg-white/5">
          <Terminal className="w-4 h-4 text-indigo-400 shrink-0" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400 shrink-0">{t("nui.console")}</span>
          {!open && <span className="font-mono text-xs text-slate-400 truncate">{last ?? t("nui.console.empty")}</span>}
          <span className="ml-auto text-slate-400 shrink-0">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}</span>
        </button>
      </div>

      {open && (
        <>
          <div className="px-5 pb-2 flex items-center gap-2">
            {(["minecraft", "network"] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn("px-3 py-1 rounded-lg text-xs font-bold cursor-pointer", tab === id ? "bg-white/10 text-white" : "text-slate-400 hover:text-white")}
              >
                {id === "minecraft" ? "Minecraft" : t("nui.console.network")}
              </button>
            ))}
            <button type="button" onClick={() => onClearLogs(tab)} title={t("nui.console.clear")} aria-label={t("nui.console.clear")} className="ml-auto p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
          <div
            ref={scrollRef}
            onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8; }}
            className="flex-1 overflow-y-auto custom-scrollbar px-5 font-mono text-xs leading-relaxed space-y-0.5"
          >
            {lines.length === 0 && <p className="text-slate-500">{t("nui.console.empty")}</p>}
            {lines.map((l, i) => <div key={i} className={cn("whitespace-pre-wrap break-words", l.startsWith(">") ? "text-indigo-300" : "text-slate-300")}>{l}</div>)}
          </div>
          {tab === "minecraft" && (
            <form onSubmit={submit} className="shrink-0 border-t border-white/10 p-2.5 flex gap-2">
              <input
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                disabled={!running}
                placeholder={running ? t("nui.console.placeholder") : t("nui.console.stopped")}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-indigo-400 disabled:opacity-50"
              />
              <button type="submit" disabled={!running || !cmd.trim()} className="px-4 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">{t("nui.console.send")}</button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
