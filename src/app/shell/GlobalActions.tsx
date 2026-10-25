"use client";

import { UpdateButton } from "@/app/components/UpdateButton";
import { DiagnosticsBell } from "@/app/components/DiagnosticsCenter";

/** Atualização pendente e central de avisos: ficam no canto de cima, à direita, em qualquer tela. */
export function GlobalActions() {
  return (
    <div className="flex items-center gap-2 shrink-0">
      <UpdateButton />
      <DiagnosticsBell />
    </div>
  );
}
