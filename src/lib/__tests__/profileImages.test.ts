import { describe, expect, it } from "vitest";
import { IMAGE_SPECS, MAX_ZOOM, cropCenter, cropRect, panCenter, profileImageUrl } from "../profileImages";
import { ownProfileView, type UserProfile } from "../profileCatalog";

describe("cropRect com zoom 1 (o recorte do centro)", () => {
  it("origem mais larga: corta dos lados, mantendo a altura toda", () => {
    expect(cropRect(2000, 1000, 256, 256)).toEqual({ sx: 500, sy: 0, sw: 1000, sh: 1000 });
  });

  it("origem mais alta: corta em cima e embaixo", () => {
    expect(cropRect(1000, 2000, 256, 256)).toEqual({ sx: 0, sy: 500, sw: 1000, sh: 1000 });
  });

  it("mesma proporção: usa a imagem inteira", () => {
    expect(cropRect(1920, 640, 960, 320)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 640 });
  });
});

describe("cropRect com zoom e posição", () => {
  it("mais zoom encolhe o trecho em volta do centro, mantendo a proporção", () => {
    const r = cropRect(1000, 1000, 256, 256, 2);
    expect(r).toEqual({ sx: 250, sy: 250, sw: 500, sh: 500 });
    const b = cropRect(3000, 2000, 960, 320, 2);
    expect(b.sw / b.sh).toBeCloseTo(3, 5);
  });

  it("o centro escolhido manda no trecho", () => {
    const r = cropRect(1000, 1000, 256, 256, 2, 300, 700);
    expect(cropCenter(r)).toEqual({ x: 300, y: 700 });
  });

  it("o trecho nunca sai da imagem: um centro fora dos limites é empurrado para dentro", () => {
    const r = cropRect(1000, 1000, 256, 256, 2, -5000, 99999);
    expect(r.sx).toBe(0);
    expect(r.sy + r.sh).toBe(1000);
    const r2 = cropRect(1000, 1000, 256, 256, 2, 99999, -5000);
    expect(r2.sx + r2.sw).toBe(1000);
    expect(r2.sy).toBe(0);
  });

  it("o zoom é limitado entre 1 e o máximo, e valores inválidos viram 1", () => {
    expect(cropRect(1000, 1000, 256, 256, 0.2).sw).toBe(1000);
    expect(cropRect(1000, 1000, 256, 256, 99).sw).toBe(1000 / MAX_ZOOM);
    expect(cropRect(1000, 1000, 256, 256, Number.NaN).sw).toBe(1000);
  });

  it("para qualquer origem, zoom e centro: proporção do destino e dentro da imagem", () => {
    for (const [w, h] of [[4000, 3000], [3000, 4000], [500, 500], [1200, 300], [300, 1200]]) {
      for (const kind of ["avatar", "banner"] as const) {
        for (const zoom of [1, 1.5, 3, MAX_ZOOM]) {
          const { width, height } = IMAGE_SPECS[kind];
          const r = cropRect(w, h, width, height, zoom, w * 0.9, h * 0.1);
          expect(r.sw / r.sh).toBeCloseTo(width / height, 5);
          expect(r.sx).toBeGreaterThanOrEqual(0);
          expect(r.sy).toBeGreaterThanOrEqual(0);
          expect(r.sx + r.sw).toBeLessThanOrEqual(w + 1e-6);
          expect(r.sy + r.sh).toBeLessThanOrEqual(h + 1e-6);
        }
      }
    }
  });
});

describe("panCenter (arrastar a prévia)", () => {
  it("arrastar para a direita mostra o que está à esquerda: o centro vai para a esquerda", () => {
    const r = cropRect(1000, 1000, 256, 256, 2, 500, 500); // trecho de 500 px mostrado em 250 px de prévia
    const c = panCenter(r, 50, 0, 250); // 50 px da prévia = 100 px da origem
    expect(c.x).toBe(400);
    expect(c.y).toBe(500);
  });

  it("arrastar para baixo move o centro para cima, e sem arrastar nada o centro não muda", () => {
    const r = cropRect(1000, 1000, 256, 256, 2, 500, 500);
    expect(panCenter(r, 0, 25, 250).y).toBe(450);
    expect(panCenter(r, 0, 0, 250)).toEqual(cropCenter(r));
  });

  it("com mais zoom o mesmo arrasto anda menos na imagem", () => {
    const dx = 40;
    const small = panCenter(cropRect(2000, 2000, 256, 256, 1, 1000, 1000), dx, 0, 250);
    const big = panCenter(cropRect(2000, 2000, 256, 256, 4, 1000, 1000), dx, 0, 250);
    expect(1000 - big.x).toBeLessThan(1000 - small.x);
  });
});

describe("medidas e endereço", () => {
  it("batem com as do Worker (256x256 e 960x320)", () => {
    expect(IMAGE_SPECS.avatar).toMatchObject({ width: 256, height: 256, maxBytes: 120 * 1024 });
    expect(IMAGE_SPECS.banner).toMatchObject({ width: 960, height: 320, maxBytes: 300 * 1024 });
  });

  it("o endereço da imagem usa só o hash", () => {
    expect(profileImageUrl("a".repeat(32))).toMatch(/\/api\/v1\/profile-image\/a{32}$/);
    expect(profileImageUrl("../x")).not.toContain("../");
  });
});

describe("ownProfileView", () => {
  const profile: UserProfile = { displayName: "Felipo", avatarId: "cube", nameColor: null, bio: null, avatarHash: "a".repeat(32), bannerHash: "b".repeat(32) };

  it("com Plus ativo mantém as imagens", () => {
    expect(ownProfileView(profile, true)).toBe(profile);
  });

  it("sem Plus esconde as imagens, sem apagar o resto, e não altera o original", () => {
    const view = ownProfileView(profile, false);
    expect(view).toMatchObject({ displayName: "Felipo", avatarHash: null, bannerHash: null });
    expect(profile.avatarHash).toBe("a".repeat(32));
  });
});
