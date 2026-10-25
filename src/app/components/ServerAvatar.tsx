"use client";

import { cn } from "@/lib/utils";
import { useServerIcon } from "@/lib/serverIcon";

// Ícone do servidor: a imagem definida nas configurações (server-icon.png) ou, sem imagem, a inicial do nome.

const COLORS = ["from-emerald-500 to-teal-600", "from-orange-500 to-rose-600", "from-sky-500 to-indigo-600", "from-fuchsia-500 to-purple-600", "from-amber-500 to-yellow-600", "from-indigo-500 to-violet-600"];
const colorFor = (key: string) => COLORS[[...key].reduce((n, ch) => n + ch.charCodeAt(0), 0) % COLORS.length];

const SIZES = { xs: "w-8 h-8 text-xs rounded-lg", sm: "w-10 h-10 text-sm rounded-xl", lg: "w-16 h-16 text-2xl rounded-2xl" } as const;

export function ServerAvatar({ path, name, size = "sm", className }: { path?: string | null; name: string; size?: keyof typeof SIZES; className?: string }) {
  const icon = useServerIcon(path);
  return (
    <span aria-hidden className={cn("relative shrink-0 grid place-items-center font-black text-white overflow-hidden bg-gradient-to-br", colorFor(name), SIZES[size], className)}>
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={icon} alt="" className="w-full h-full object-cover [image-rendering:auto]" />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
