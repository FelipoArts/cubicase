"""Gera resource_windows_amd64.syso (nome/descrição "Cubicase" embutidos no cubicase-link.exe).

Por quê: sem isso o Windows mostra o nome do arquivo ("cubicase-link") na pergunta do Firewall e nas
propriedades do executável. Com a versão embutida, ele mostra "Cubicase".

Como: compila versioninfo.rc com o rc.exe do Windows SDK (gera um .res) e empacota o recurso num objeto COFF
que o linker do Go aceita (o cvtres.exe da Microsoft gera um objeto que o Go recusa). O .syso gerado fica no
repositório: só precisa rodar de novo se o versioninfo.rc mudar.

Uso (no PowerShell do Windows, com o rc.exe no PATH — por exemplo, em um "Developer PowerShell"):
    python gen-resource.py
"""
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RC = HERE / "versioninfo.rc"
OUT = HERE / "resource_windows_amd64.syso"

RT_VERSION = 16
LANG_EN_US = 0x0409


def compile_rc(tmp: Path) -> bytes:
    res = tmp / "versioninfo.res"
    subprocess.run(["rc.exe", "/nologo", "/fo", str(res), str(RC)], check=True)
    return res.read_bytes()


def version_resource_data(res: bytes) -> bytes:
    """Extrai os bytes do recurso VERSION (tipo 16) de um arquivo .res."""
    pos = 0
    while pos < len(res):
        data_size, header_size = struct.unpack_from("<II", res, pos)
        body = pos + header_size
        # TYPE: ordinal (0xFFFF, id) ou texto; só o ordinal 16 nos interessa
        type_marker, type_id = struct.unpack_from("<HH", res, pos + 8)
        if data_size and type_marker == 0xFFFF and type_id == RT_VERSION:
            return res[body : body + data_size]
        pos = (body + data_size + 3) & ~3
    raise SystemExit("recurso VERSION não encontrado no .res")


def build_coff(data: bytes) -> bytes:
    """Objeto COFF x64 com uma seção .rsrc (árvore de recursos + dados) e uma relocação de RVA."""
    # árvore: raiz (tipo) -> nível 2 (nome) -> nível 3 (idioma) -> entrada de dados
    root = struct.pack("<IIHHHH", 0, 0, 0, 0, 0, 1) + struct.pack("<II", RT_VERSION, 0x80000000 | 24)
    lvl2 = struct.pack("<IIHHHH", 0, 0, 0, 0, 0, 1) + struct.pack("<II", 1, 0x80000000 | 48)
    lvl3 = struct.pack("<IIHHHH", 0, 0, 0, 0, 0, 1) + struct.pack("<II", LANG_EN_US, 72)
    data_offset = 88
    entry = struct.pack("<IIII", data_offset, len(data), 0, 0)  # OffsetToData é somado ao RVA da seção pela relocação
    section = root + lvl2 + lvl3 + entry + data
    section += b"\0" * (-len(section) % 4)
    assert len(root) + len(lvl2) + len(lvl3) == 72 and len(section) >= 88

    section_raw_offset = 20 + 40
    reloc_offset = section_raw_offset + len(section)
    symtab_offset = reloc_offset + 10
    file_header = struct.pack("<HHIIIHH", 0x8664, 1, 0, symtab_offset, 1, 0, 0)
    section_header = (
        b".rsrc\0\0\0"
        + struct.pack("<IIIIIIHHI", 0, 0, len(section), section_raw_offset, reloc_offset, 0, 1, 0, 0x40000040)
    )
    reloc = struct.pack("<IIH", 72, 0, 3)  # IMAGE_REL_AMD64_ADDR32NB sobre o campo OffsetToData
    symbol = b".rsrc\0\0\0" + struct.pack("<IhHBB", 0, 1, 0, 3, 0)
    string_table = struct.pack("<I", 4)
    return file_header + section_header + section + reloc + symbol + string_table


def main() -> None:
    with tempfile.TemporaryDirectory() as t:
        data = version_resource_data(compile_rc(Path(t)))
    OUT.write_bytes(build_coff(data))
    print("Gerado", OUT)


if __name__ == "__main__":
    sys.exit(main())
