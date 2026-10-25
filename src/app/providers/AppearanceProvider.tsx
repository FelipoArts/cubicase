"use client";

import { createContext, useContext } from "react";
import { useAppearance } from "@/lib/theme/appearance";

// Aplica a paleta escolhida em TODO o app (as duas interfaces) e a compartilha com a tela de Aparência.

type Appearance = ReturnType<typeof useAppearance>;
const Ctx = createContext<Appearance | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const appearance = useAppearance();
  return <Ctx.Provider value={appearance}>{children}</Ctx.Provider>;
}

export function useAppearanceContext(): Appearance {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppearanceContext fora do AppearanceProvider");
  return v;
}
