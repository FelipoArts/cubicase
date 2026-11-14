import { useId, type ReactNode } from "react";

// ============================================================
// TierCube: o cubo de cada nível do badge de tempo de assinatura do Plus
// ============================================================
// Um cubo isométrico (3 faces) por material, do mais simples ao mais raro. Desenhado em SVG, sem imagens: escala
// para qualquer tamanho e herda as cores daqui. Fica de propósito sem dependências do app (só React), para poder
// ser renderizado fora dele (ex.: uma prévia estática).
// ============================================================

export type CubeTier = "wood" | "stone" | "iron" | "gold" | "redstone" | "diamond" | "emerald" | "netherite";

// Geometria do cubo no quadro 100 x 110.
const TOP = "5,30 50,5 95,30 50,55";
const LEFT = "5,30 50,55 50,105 5,80";
const RIGHT = "50,55 95,30 95,80 50,105";
const HEX = "50,5 95,30 95,80 50,105 5,80 5,30";

function mix(hex: string, target: number, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (target - c) * amount));
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
const lighten = (hex: string, a: number) => mix(hex, 255, a);
const darken = (hex: string, a: number) => mix(hex, 0, a);

const SPARKLE = "M0,-9 L2.6,-2.6 L9,0 L2.6,2.6 L0,9 L-2.6,2.6 L-9,0 L-2.6,-2.6Z";
/** Miolo branco da faísca (metade do tamanho). */
const SPARKLE_CORE = "M0,-4.5 L1.3,-1.3 L4.5,0 L1.3,1.3 L0,4.5 L-1.3,1.3 L-4.5,0 L-1.3,-1.3Z";
const Sparkle = ({ x, y, s = 1, o = 0.9 }: { x: number; y: number; s?: number; o?: number }) => (
  <path d={SPARKLE} transform={`translate(${x} ${y}) scale(${s})`} fill="#fff" opacity={o} />
);

interface Look {
  base: string;
  /** Cor do contorno; sem ela, um tom bem escuro do material. */
  edge?: string;
  /** Desenhos por cima das três faces (já recortados pelo contorno do cubo). */
  detail: (base: string) => ReactNode;
}

const LOOKS: Record<CubeTier, Look> = {
  // Madeira: tábuas e veios
  wood: {
    base: "#b4742a",
    detail: (b) => (
      <g stroke={darken(b, 0.4)} strokeWidth="2.4" strokeLinecap="round" fill="none" opacity="0.7">
        <path d="M5,47 L50,72 M5,64 L50,89" />
        <path d="M50,72 L95,47 M50,89 L95,64" />
        <path d="M27,17 L73,43" />
        <path d="M14,53 L22,57.5 M33,75 L41,79.5 M60,79 L68,74.5 M78,56 L86,51.5" strokeWidth="1.6" opacity="0.8" />
      </g>
    ),
  },
  // Pedra: manchas e uma rachadura
  stone: {
    base: "#8e939b",
    detail: (b) => (
      <g>
        <g fill={darken(b, 0.28)}>
          <path d="M13,50 L20,48 L22,54 L15,56Z M31,78 L39,80 L38,86 L30,84Z" />
          <path d="M65,62 L73,58 L75,64 L67,67Z M81,50 L88,47 L88,53 L82,55Z" />
          <path d="M43,22 L52,20 L56,25 L47,28Z" />
        </g>
        <g fill={lighten(b, 0.3)} opacity="0.7">
          <path d="M20,66 L26,64 L27,69 L21,71Z M72,86 L78,83 L79,88 L73,90Z" />
        </g>
        <path d="M70,92 L74,81 L69,75 L73,68" stroke={darken(b, 0.5)} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    ),
  },
  // Ferro: faixa de brilho e rebites
  iron: {
    base: "#b9c4d2",
    detail: (b) => (
      <g>
        <path d="M15,55 L26,61 L26,93 L15,87Z" fill="#fff" opacity="0.4" />
        <path d="M63,61 L74,55 L74,87 L63,93Z" fill="#fff" opacity="0.22" />
        <g fill={darken(b, 0.12)} stroke={darken(b, 0.45)} strokeWidth="1">
          {[[13, 42], [13, 77], [42, 58], [42, 93], [58, 58], [58, 93], [87, 42], [87, 77]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="2.3" />)}
        </g>
      </g>
    ),
  },
  // Ouro: brilho e uma estrela
  gold: {
    base: "#f4b81c",
    detail: () => (
      <g>
        <path d="M15,55 L26,61 L26,93 L15,87Z" fill="#fff" opacity="0.45" />
        <path d="M63,61 L74,55 L74,87 L63,93Z" fill="#fff" opacity="0.22" />
        <Sparkle x={50} y={30} s={1.15} />
        <Sparkle x={79} y={44} s={0.5} o={0.8} />
      </g>
    ),
  },
  // Redstone: grãos vermelhos
  redstone: {
    base: "#d6312b",
    detail: (b) => (
      <g>
        <g fill={lighten(b, 0.5)}>
          {[[22, 52], [34, 70], [18, 74], [70, 64], [84, 56], [66, 86], [50, 28], [34, 24], [68, 36]].map(([x, y]) => <rect key={`${x}-${y}`} x={x - 2} y={y - 2} width="4" height="4" rx="0.8" />)}
        </g>
        <g fill={darken(b, 0.45)}>
          {[[28, 62], [40, 90], [76, 74], [88, 66], [58, 22], [44, 36]].map(([x, y]) => <rect key={`${x}-${y}`} x={x - 1.6} y={y - 1.6} width="3.2" height="3.2" rx="0.6" />)}
        </g>
      </g>
    ),
  },
  // Diamante: facetas e brilhos
  diamond: {
    base: "#33d6e8",
    detail: () => (
      <g>
        <g stroke="#fff" strokeWidth="1.8" opacity="0.55" fill="none" strokeLinejoin="round">
          <path d="M5,30 L50,105 M5,80 L50,55" />
          <path d="M95,30 L50,105 M95,80 L50,55" />
          <path d="M5,30 L95,30 M50,5 L50,55" strokeWidth="1.4" />
        </g>
        <Sparkle x={24} y={48} s={0.9} />
        <Sparkle x={78} y={40} s={0.6} o={0.85} />
        <Sparkle x={60} y={92} s={0.45} o={0.8} />
      </g>
    ),
  },
  // Esmeralda: lapidação (faces recortadas)
  emerald: {
    base: "#17b978",
    detail: () => (
      <g stroke="#fff" strokeWidth="1.6" fill="#fff" fillOpacity="0.1" strokeOpacity="0.55" strokeLinejoin="round">
        <path d="M13,43 L42,59 L42,93 L13,77Z" />
        <path d="M58,59 L87,43 L87,77 L58,93Z" />
        <path d="M50,13 L83,30 L50,47 L17,30Z" />
        <Sparkle x={26} y={62} s={0.5} o={0.8} />
      </g>
    ),
  },
  // Netherite: moldura cinza em relevo e um painel central escuro, com pontinhos avermelhados (como o bloco do jogo)
  netherite: {
    base: "#6c6b70", // a moldura
    edge: "#2a272c",
    detail: () => {
      // Pontinhos de cada face, já inclinados no plano dela: [x, y, tom] (0 = cinza claro, 1 = marrom-avermelhado)
      const left: [number, number, number][] = [[20, 55, 1], [31, 64, 0], [23, 71, 0], [34, 82, 1]];
      const right: [number, number, number][] = [[66, 70, 0], [75, 62, 1], [80, 52, 0], [69, 82, 1]];
      const top: [number, number, number][] = [[40, 28, 1], [56, 22, 0], [62, 32, 1], [48, 36, 0]];
      const tone = (t: number) => (t ? "#5a3b3d" : "#5b5a60");
      return (
        <g>
          {/* painéis centrais (um tom por face, como a luz do cubo) */}
          <path d="M13,43 L42,59 L42,93 L13,77Z" fill="#3d3b40" />
          <path d="M58,59 L87,43 L87,77 L58,93Z" fill="#2f2d33" />
          <path d="M50,13 L83,30 L50,47 L17,30Z" fill="#4a484e" />
          {/* a borda interna dá o relevo da moldura */}
          <g fill="none" stroke="#25222a" strokeWidth="1.4" strokeLinejoin="round" opacity="0.9">
            <path d="M13,43 L42,59 L42,93 L13,77Z" />
            <path d="M58,59 L87,43 L87,77 L58,93Z" />
            <path d="M50,13 L83,30 L50,47 L17,30Z" />
          </g>
          <g stroke="#9b9aa0" strokeWidth="1.1" fill="none" strokeLinecap="round" opacity="0.55">
            <path d="M8,34 L50,58 M50,58 L92,34" />
          </g>
          {left.map(([x, y, t]) => <path key={`l${x}-${y}`} d={`M${x},${y} L${x + 4},${y + 2.2} L${x + 4},${y + 6.2} L${x},${y + 4}Z`} fill={tone(t)} />)}
          {right.map(([x, y, t]) => <path key={`r${x}-${y}`} d={`M${x},${y} L${x + 4},${y - 2.2} L${x + 4},${y + 1.8} L${x},${y + 4}Z`} fill={tone(t)} />)}
          {top.map(([x, y, t]) => <path key={`t${x}-${y}`} d={`M${x},${y} L${x + 3},${y - 1.7} L${x + 6},${y} L${x + 3},${y + 1.7}Z`} fill={tone(t)} />)}
        </g>
      );
    },
  },
};

// ------------------------------------------------------------
// Brilho e partículas: começam no Ferro e crescem a cada nível, na cor do material
// ------------------------------------------------------------
interface Fx {
  /** Cor do brilho atrás do cubo. */
  glow: string;
  /** Cor das faíscas. */
  spark: string;
  /** Intensidade do brilho (0 a 1). */
  strength: number;
  /** Quantas faíscas (tirando das posições abaixo, na ordem). */
  sparks: number;
}

const FX: Partial<Record<CubeTier, Fx>> = {
  // As faíscas usam um tom médio da cor (visível em fundo claro e escuro) com um miolo branco.
  iron: { glow: "#cbd5e1", spark: "#94a3b8", strength: 0.22, sparks: 2 },
  gold: { glow: "#fbbf24", spark: "#f59e0b", strength: 0.32, sparks: 3 },
  redstone: { glow: "#ef4444", spark: "#ef4444", strength: 0.4, sparks: 4 },
  diamond: { glow: "#22d3ee", spark: "#06b6d4", strength: 0.5, sparks: 6 },
  emerald: { glow: "#34d399", spark: "#10b981", strength: 0.58, sparks: 8 },
  netherite: { glow: "#8b5cf6", spark: "#8b5cf6", strength: 0.66, sparks: 10 },
};

/** Posições das faíscas em volta do cubo: [x, y, escala, atraso em segundos]. */
const SPARK_SLOTS: [number, number, number, number][] = [
  [4, 10, 0.9, 0], [96, 14, 0.8, 1.1], [102, 62, 0.7, 0.5], [-4, 58, 0.75, 1.7], [50, -6, 1, 2.1],
  [24, 114, 0.7, 0.8], [82, 112, 0.8, 1.5], [-2, 30, 0.55, 2.3], [104, 36, 0.55, 0.3], [50, 116, 0.6, 1.9],
];

/** Abaixo deste tamanho (px) só há o brilho: as faíscas ficariam pontinhos soltos. */
const SPARK_MIN_SIZE = 40;

export function isCubeTier(v: string | null | undefined): v is CubeTier {
  return !!v && v in LOOKS;
}

/** Cor principal do material, para combinar o resto da interface (ex.: o contorno de um selo). */
export function cubeBaseColor(tier: CubeTier): string {
  return LOOKS[tier].base;
}

interface Props {
  tier: CubeTier;
  /** Altura em pixels (a largura acompanha). */
  size?: number;
  className?: string;
  title?: string;
  /** Brilho e faíscas dos níveis a partir do Ferro (ligado por padrão). */
  effects?: boolean;
}

export function TierCube({ tier, size = 24, className, title, effects = true }: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const { base, detail, edge: edgeColor } = LOOKS[tier];
  const edge = edgeColor ?? darken(base, 0.55);
  const fx = effects ? FX[tier] : undefined;
  const sparks = fx && size >= SPARK_MIN_SIZE ? SPARK_SLOTS.slice(0, fx.sparks) : [];
  return (
    <svg
      viewBox="0 0 100 110"
      width={(size * 100) / 110}
      height={size}
      className={className}
      style={{ overflow: "visible" }}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <defs>
        <clipPath id={`cube-${uid}`}><polygon points={HEX} /></clipPath>
        {fx && (
          <radialGradient id={`glow-${uid}`}>
            <stop offset="0%" stopColor={fx.glow} stopOpacity="1" />
            <stop offset="55%" stopColor={fx.glow} stopOpacity="0.45" />
            <stop offset="100%" stopColor={fx.glow} stopOpacity="0" />
          </radialGradient>
        )}
      </defs>
      {fx && <circle className="cube-glow" cx="50" cy="55" r="66" fill={`url(#glow-${uid})`} style={{ ["--cube-glow" as string]: fx.strength }} />}
      <polygon points={TOP} fill={lighten(base, 0.28)} />
      <polygon points={LEFT} fill={base} />
      <polygon points={RIGHT} fill={darken(base, 0.28)} />
      <g clipPath={`url(#cube-${uid})`}>{detail(base)}</g>
      <g fill="none" stroke={edge} strokeLinejoin="round" strokeLinecap="round">
        <path d="M5,30 L50,55 L95,30 M50,55 L50,105" strokeWidth="3.2" />
        <polygon points={HEX} strokeWidth="5" />
      </g>
      {fx && sparks.map(([x, y, s, delay], i) => (
        <g key={i} transform={`translate(${x} ${y}) scale(${s * 0.85})`}>
          <path className="cube-spark" d={SPARKLE} fill={fx.spark} style={{ animationDelay: `${delay}s`, animationDuration: `${2.2 + (i % 3) * 0.5}s` }} />
          <path className="cube-spark" d={SPARKLE_CORE} fill="#fff" style={{ animationDelay: `${delay}s`, animationDuration: `${2.2 + (i % 3) * 0.5}s` }} />
        </g>
      ))}
    </svg>
  );
}
