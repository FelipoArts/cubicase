"""Gera as imagens do instalador (NSIS) a partir das logos do site.

Saída em src-tauri/installer/:
  - sidebar.bmp  (164x314) telas de boas-vindas e de conclusão
  - header.bmp   (150x57)  cabeçalho das telas internas (fundo claro, como o do NSIS)

O NSIS só aceita BMP sem transparência, então tudo é composto sobre um fundo sólido.
Desenha em 4x e reduz, para as bordas ficarem suaves.

Uso: python scripts/build-installer-images.py   (precisa do Pillow)
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "installer"
SS = 4  # fator de supersampling

BG_TOP = (10, 10, 12)
BG_BOTTOM = (23, 23, 27)
ACCENT = (255, 68, 51)


def fit_width(img: Image.Image, width: int) -> Image.Image:
    ratio = width / img.width
    return img.resize((width, max(1, round(img.height * ratio))), Image.LANCZOS)


def paste_center(base: Image.Image, overlay: Image.Image, y: int) -> None:
    base.alpha_composite(overlay, ((base.width - overlay.width) // 2, y))


def sidebar() -> Image.Image:
    w, h = 164 * SS, 314 * SS
    img = Image.new("RGBA", (w, h), BG_TOP + (255,))
    px = ImageDraw.Draw(img)
    for y in range(h):  # gradiente vertical escuro
        t = y / (h - 1)
        px.line([(0, y), (w, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)) + (255,))

    # brilho vermelho suave no canto inferior
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([-w * 0.3, h * 0.72, w * 1.3, h * 1.35], fill=ACCENT + (95,))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(40 * SS)))

    # a logo já inclui o ícone "Cc": só ela, grande, um pouco acima do centro
    word = fit_width(Image.open(ROOT / "docs/assets/logo-dark.png").convert("RGBA"), 136 * SS)
    paste_center(img, word, (h - word.height) // 2 - 28 * SS)

    # fio de destaque na base
    ImageDraw.Draw(img).rectangle([0, h - 3 * SS, w, h], fill=ACCENT + (255,))
    return img.resize((164, 314), Image.LANCZOS).convert("RGB")


def header() -> Image.Image:
    w, h = 150 * SS, 57 * SS
    img = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    word = Image.open(ROOT / "docs/assets/logo.png").convert("RGBA")
    word = fit_width(word, 104 * SS)
    img.alpha_composite(word, ((w - word.width) // 2, (h - word.height) // 2))
    return img.resize((150, 57), Image.LANCZOS).convert("RGB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    sidebar().save(OUT / "sidebar.bmp", format="BMP")
    header().save(OUT / "header.bmp", format="BMP")
    print("Gerado em", OUT)


if __name__ == "__main__":
    main()
