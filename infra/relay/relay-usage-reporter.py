#!/usr/bin/env python3
"""Medidor de consumo do relay: lê o log do coturn e reporta ao Worker quanto cada sessão gastou.

O custo do relay é o tráfego que SAI da VM. O coturn (com `verbose`) registra, quando uma alocação
termina, duas linhas:

    session <id>: usage: realm=<...>, username=<EXPIRACAO:PEERID>, rp=.., rb=.., sp=.., sb=..
    session <id>: peer usage: realm=<...>, username=<EXPIRACAO:PEERID>, rp=.., rb=.., sp=.., sb=..

`sb` da primeira = bytes enviados da VM para o cliente; `sb` da segunda = bytes enviados da VM para o
outro lado. A soma dos dois é o que saiu da VM por causa dessa alocação. O PEERID é o id da sessão
na API, por isso o Worker consegue atribuir o consumo ao servidor (e aplicar a cota mensal).

Os totais vão em lote, a cada minuto, para POST /api/v1/internal/relay-usage, assinados com
HMAC-SHA256(TURN_SECRET) do corpo. Falha de rede não perde nada: o lote fica na fila até passar.

Uso (systemd):  relay-usage-reporter.py            (segue o journal do coturn)
Teste:          relay-usage-reporter.py --stdin    (lê linhas da entrada padrão e envia ao final)
"""
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

API_URL = os.environ.get("RELAY_USAGE_URL", "https://cubeforge-api.cubeforge.workers.dev/api/v1/internal/relay-usage")
CONF = os.environ.get("TURNSERVER_CONF", "/etc/turnserver.conf")
FLUSH_EVERY_S = 60
MAX_QUEUE = 5000      # entradas retidas se a API ficar fora do ar por muito tempo
MAX_BATCH = 400       # o Worker aceita até 500 por lote

LINE = re.compile(
    r"session (?P<sid>\d+): (?P<kind>peer usage|usage): realm=<[^>]*>, "
    r"username=<(?P<user>[^>]*)>, rp=(?P<rp>\d+), rb=(?P<rb>\d+), sp=(?P<sp>\d+), sb=(?P<sb>\d+)"
)


def read_secret(path=CONF):
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("static-auth-secret="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("static-auth-secret não encontrado em " + path)


class Collector:
    """Junta as duas linhas de cada alocação e produz (peerId, bytes que saíram da VM)."""

    def __init__(self):
        self.pending = {}  # session id -> bytes da linha "usage"

    def feed(self, line):
        m = LINE.search(line)
        if not m:
            return None
        sid, sb = m.group("sid"), int(m.group("sb"))
        if m.group("kind") == "usage":
            self.pending[sid] = sb
            return None
        first = self.pending.pop(sid, None)
        if first is None:
            return None  # "peer usage" sem a linha anterior (log cortado): melhor ignorar que chutar
        # username = EXPIRACAO:PEERID (credenciais REST do coturn). Sem o ":" não é nosso.
        _, sep, peer = m.group("user").partition(":")
        total = first + sb
        if not sep or not peer or total <= 0:
            return None
        return {"peerId": peer, "bytes": total}


def sign(secret, raw):
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def post(secret, entries, url=API_URL, now_ms=None):
    raw = json.dumps({"ts": int(now_ms if now_ms is not None else time.time() * 1000), "entries": entries}).encode()
    req = urllib.request.Request(
        url, data=raw, method="POST",
        headers={"Content-Type": "application/json", "X-Relay-Signature": sign(secret, raw), "User-Agent": "cubicase-relay-usage/1"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status


def flush(secret, queue):
    """Envia a fila em lotes; devolve o que sobrou (nada, se tudo passou)."""
    while queue:
        batch = queue[:MAX_BATCH]
        try:
            post(secret, batch)
        except Exception as e:  # rede, 5xx, relógio fora da janela...: tenta de novo no próximo ciclo
            print("falha ao reportar (%d entradas na fila): %s" % (len(queue), e), file=sys.stderr, flush=True)
            return queue
        del queue[: len(batch)]
        print("reportadas %d entradas" % len(batch), flush=True)
    return queue


def main():
    secret = read_secret()
    collector, queue = Collector(), []
    if "--stdin" in sys.argv:
        for line in sys.stdin:
            entry = collector.feed(line)
            if entry:
                queue.append(entry)
        flush(secret, queue)
        return

    proc = subprocess.Popen(
        ["journalctl", "-u", "coturn", "-f", "-n", "0", "-o", "cat"],
        stdout=subprocess.PIPE, text=True, bufsize=1,
    )
    import selectors
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    last = time.time()
    while True:
        for _key, _ in sel.select(timeout=5):
            line = proc.stdout.readline()
            if not line:
                raise SystemExit("journalctl terminou")
            entry = collector.feed(line)
            if entry:
                queue.append(entry)
                del queue[:-MAX_QUEUE]
        if time.time() - last >= FLUSH_EVERY_S:
            last = time.time()
            queue = flush(secret, queue)


if __name__ == "__main__":
    main()
