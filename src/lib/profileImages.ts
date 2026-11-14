// ============================================================
// Foto e banner do perfil (só Cubicase Plus): ajuste no app e envio ao Worker
// ============================================================
// A pessoa escolhe uma imagem e a ajusta numa janela (arrastar, zoom, girar). O app recorta o trecho escolhido para a
// proporção certa, reduz para o tamanho exato e recodifica em WebP. Recodificar também apaga os dados escondidos da foto
// original (localização, câmera...). O Worker confere tudo de novo (formato, bytes e dimensões) e guarda no R2 pelo hash
// do conteúdo (ver api/src/profile-images.ts).
// ============================================================

import { useAppStore } from "@/app/store";
import { authedBinary, authedFetch } from "@/lib/authedApi";
import { API_BASE } from "@/lib/apiBase";
import type { UserProfile } from "@/lib/profileCatalog";

export type ImageKind = "avatar" | "banner";

/** Mesmas medidas do Worker (IMAGE_SPECS em api/src/profile-images.ts): o servidor recusa qualquer outra. */
export const IMAGE_SPECS: Record<ImageKind, { width: number; height: number; maxBytes: number }> = {
  avatar: { width: 256, height: 256, maxBytes: 120 * 1024 },
  banner: { width: 960, height: 320, maxBytes: 300 * 1024 },
};

/** Arquivos maiores que isto nem são lidos (evita travar o app com uma foto gigante). */
export const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

/** Zoom máximo da janela de ajuste (1 = a imagem inteira cobrindo o quadro). */
export const MAX_ZOOM = 4;

export interface CropRect { sx: number; sy: number; sw: number; sh: number }

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * O trecho da imagem de origem que preenche o destino, para um dado zoom e centro (em pixels da origem). Com zoom 1 é o
 * maior trecho que cabe sem distorcer (o "cover" clássico); com mais zoom o trecho encolhe em volta do centro. O trecho
 * nunca sai da imagem: um centro fora dos limites é empurrado para dentro.
 */
export function cropRect(srcW: number, srcH: number, dstW: number, dstH: number, zoom = 1, cx = srcW / 2, cy = srcH / 2): CropRect {
  const dstRatio = dstW / dstH;
  const baseW = srcW / srcH > dstRatio ? srcH * dstRatio : srcW;
  const baseH = baseW / dstRatio;
  const z = clamp(Number.isFinite(zoom) ? zoom : 1, 1, MAX_ZOOM);
  const sw = baseW / z;
  const sh = baseH / z;
  return { sx: clamp(cx - sw / 2, 0, srcW - sw), sy: clamp(cy - sh / 2, 0, srcH - sh), sw, sh };
}

/** O centro (em pixels da origem) do trecho. */
export const cropCenter = (r: CropRect) => ({ x: r.sx + r.sw / 2, y: r.sy + r.sh / 2 });

/** Arrastar `dx`/`dy` pixels do quadro de prévia (de largura `viewW`) move o trecho no sentido contrário, em pixels da origem. */
export function panCenter(r: CropRect, dx: number, dy: number, viewW: number): { x: number; y: number } {
  const k = r.sw / viewW; // pixels da origem por pixel da prévia
  const c = cropCenter(r);
  return { x: c.x - dx * k, y: c.y - dy * k };
}

/** O endereço da imagem de um hash (o Worker serve pública, com cache longo). */
export function profileImageUrl(hash: string): string {
  return `${API_BASE}/api/v1/profile-image/${encodeURIComponent(hash)}`;
}

export class ImageError extends Error {
  constructor(readonly reason: "type" | "tooBig" | "decode" | "encode") {
    super(reason);
    this.name = "ImageError";
  }
}

/** Confere o arquivo escolhido antes de abrir a janela de ajuste. Lança ImageError se não serve. */
export function checkImageFile(file: File): void {
  if (!file.type.startsWith("image/")) throw new ImageError("type");
  if (file.size > MAX_SOURCE_BYTES) throw new ImageError("tooBig");
}

export interface ImageSource {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/** Lê o arquivo (respeitando a orientação da foto) para um canvas, que serve de origem para o recorte e para girar. */
export async function loadImageSource(file: File): Promise<ImageSource> {
  checkImageFile(file);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ImageError("decode");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImageError("decode");
    ctx.drawImage(bitmap, 0, 0);
    return { canvas, width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

/** Gira a origem 90 graus no sentido horário. */
export function rotateSource(src: ImageSource): ImageSource {
  const canvas = document.createElement("canvas");
  canvas.width = src.height;
  canvas.height = src.width;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageError("encode");
  ctx.translate(canvas.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src.canvas, 0, 0);
  return { canvas, width: canvas.width, height: canvas.height };
}

/** Desenha o trecho escolhido, esticado para o destino. A prévia e o arquivo enviado usam esta mesma função. */
export function drawCrop(ctx: CanvasRenderingContext2D, src: ImageSource, rect: CropRect, dstW: number, dstH: number): void {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, dstW, dstH);
  ctx.drawImage(src.canvas, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, dstW, dstH);
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
}

/** Gera o WebP final do trecho escolhido, no tamanho exato do tipo, baixando a qualidade até caber no teto de bytes. */
export async function renderCrop(src: ImageSource, rect: CropRect, kind: ImageKind): Promise<Blob> {
  const spec = IMAGE_SPECS[kind];
  const canvas = document.createElement("canvas");
  canvas.width = spec.width;
  canvas.height = spec.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageError("encode");
  drawCrop(ctx, src, rect, spec.width, spec.height);
  for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
    const blob = await toBlob(canvas, quality);
    if (!blob || blob.type !== "image/webp") throw new ImageError("encode");
    if (blob.size <= spec.maxBytes) return blob;
  }
  throw new ImageError("tooBig");
}

/** Envia a imagem já recortada e guarda o perfil devolvido na store. Exige Plus (o Worker confere). */
export async function uploadProfileImage(kind: ImageKind, blob: Blob): Promise<UserProfile> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const data = await authedBinary<{ profile: UserProfile }>("PUT", `/api/v1/profile/me/${kind}`, bytes, "image/webp");
  useAppStore.getState().setProfile(data.profile);
  return data.profile;
}

export async function removeProfileImage(kind: ImageKind): Promise<UserProfile> {
  const data = await authedFetch<{ profile: UserProfile }>("DELETE", `/api/v1/profile/me/${kind}`);
  useAppStore.getState().setProfile(data.profile);
  return data.profile;
}
