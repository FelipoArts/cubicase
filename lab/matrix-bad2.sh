#!/bin/bash
# Fase B (complemento): quedas curtas e médias DURANTE as trocas, queda com relay e perda alta com a chamada à API repetida.
# uso (na raiz do repositório, com o Docker rodando): bash lab/matrix-bad2.sh
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
ROOT=$(pwd -W 2>/dev/null || pwd)

run() { # run <rótulo> <argumentos do teste> <variáveis...>
  local label=$1 args=$2; shift 2
  echo "=== $label"
  timeout 330 docker run --rm --privileged -v "$ROOT:/work" -e HOST_NAT=cone -e GUEST_NAT=cone "$@" \
    -e ARGS="$args" cubicase-lab bash /work/lab/case.sh 2>&1 | grep -E "caminho=|voltou|NÃO VOLTOU|trocas corretas|FALHOU|Nenhuma falha|FALHAS|pronto em|erro|labwire:" | cut -c1-190
  sleep 45
}

run "queda de 6 s durante as trocas"        "--guests 3 --relay 0 --mb 1 --phases recover --recover-delay 2" -e WIRE_BLACKOUT="21s:27s"
run "queda de 12 s durante as trocas"       "--guests 3 --relay 0 --mb 1 --phases recover --recover-delay 2" -e WIRE_BLACKOUT="21s:33s"
run "queda de 12 s com os convidados no relay" "--guests 3 --relay 3 --mb 1 --phases recover --recover-delay 2" -e WIRE_BLACKOUT="21s:33s"
run "perda de 10% (chamadas à API repetidas)" "--guests 3 --relay 0 --mb 1 --phases solo,concurrent" -e WIRE="-loss 0.10"
