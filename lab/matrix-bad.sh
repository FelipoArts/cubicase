#!/bin/bash
# Fase B: rede ruim no cabo do convidado (atraso, jitter, perda, banda baixa, quedas). Host e convidado atrás de NAT cone,
# então o caminho esperado é o direto. uso (na raiz do repositório, com o Docker rodando): bash lab/matrix-bad.sh
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
ROOT=$(pwd -W 2>/dev/null || pwd)

run() { # run <rótulo> <fases> <variáveis...>
  local label=$1 phases=$2; shift 2
  echo "=== $label"
  timeout 330 docker run --rm --privileged -v "$ROOT:/work" -e HOST_NAT=cone -e GUEST_NAT=cone "$@" \
    -e ARGS="--guests 3 --relay 0 --mb 1 --phases $phases" \
    cubicase-lab bash /work/lab/case.sh 2>&1 | grep -E "caminho=|trocas corretas|FALHOU|Nenhuma falha|FALHAS|pronto em|erro|recuper|labwire:" | cut -c1-190
  sleep 45
}

run "latência alta: 80 ms + jitter 30 ms + 3% de perda"  solo,concurrent -e WIRE="-delay 80ms -jitter 30ms -loss 0.03"
run "perda alta: 10%"                                       solo,concurrent -e WIRE="-loss 0.10"
run "banda baixa: 2 Mbit/s + 40 ms"                         solo,concurrent -e WIRE="-rate 250000 -delay 40ms"
run "queda total de 6 s no meio das trocas"                 solo,concurrent -e WIRE_BLACKOUT="20s:26s"
run "queda total de 25 s (passa do limite do ICE)"          solo,concurrent -e WIRE_BLACKOUT="20s:45s"
