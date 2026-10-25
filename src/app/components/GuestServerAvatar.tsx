"use client";

import { cn } from "@/lib/utils";
import { useAppStore, type KnownServer } from "@/app/store";
import { useServerIcon } from "@/lib/serverIcon";
import { useGuestServerIcon } from "@/lib/guestServerIcon";

// Ícone de um servidor da biblioteca do Convidado: a imagem local (se for um servidor seu), a que o host enviou para a
// central, ou a inicial do nome.
const COLORS = ["from-emerald-500 to-teal-600", "from-orange-500 to-rose-600", "from-sky-500 to-indigo-600", "from-fuchsia-500 to-purple-600", "from-amber-500 to-yellow-600", "from-indigo-500 to-violet-600"];
const colorFor = (key: string) => COLORS[[...key].reduce((n, ch) => n + ch.charCodeAt(0), 0) % COLORS.length];

export function GuestServerAvatar({ server, className }: { server: KnownServer; className?: string }) {
  const guestIcon = useGuestServerIcon(server.shortCode);
  const localPath = useAppStore((st) => (server.isOwnServer ? st.localServers.find((l) => l.shortCode === server.shortCode)?.path : undefined));
  const icon = useServerIcon(localPath) ?? guestIcon;
  return (
    <span aria-hidden className={cn("shrink-0 grid place-items-center font-black text-white bg-gradient-to-br overflow-hidden w-10 h-10 text-sm rounded-xl", colorFor(server.shortCode), className)}>
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={icon} alt="" className="w-full h-full object-cover" />
      ) : (
        server.name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
