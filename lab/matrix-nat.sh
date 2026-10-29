#!/bin/bash
# Fase A: matriz de NAT. Cada caso sobe um contêiner limpo (redes novas) e roda o teste de campo.
# uso (na raiz do repositório, com o Docker rodando): bash lab/matrix-nat.sh
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
ROOT=$(pwd -W 2>/dev/null || pwd)

run() { # run <rótulo> <esperado> <variáveis...>
  local label=$1 expect=$2; shift 2
  echo "=== $label"
  timeout 280 docker run --rm --privileged -v "$ROOT:/work" "$@" \
    -e ARGS="--guests 3 --relay 0 --mb 1 --phases solo,concurrent --expect-path $expect" \
    cubicase-lab bash /work/lab/case.sh 2>&1 | grep -E "caminho=|trocas corretas|FALHOU|Nenhuma falha|FALHAS|pronto em|erro" | cut -c1-170
  sleep 45   # a API limita entradas por IP por minuto
}

run "cone <-> cone (deve furar o NAT)"                "^punched$"  -e HOST_NAT=cone -e GUEST_NAT=cone
run "simétrico (host) <-> cone (relay)"                "^relay$"    -e HOST_NAT=sym  -e GUEST_NAT=cone
run "cone <-> simétrico (convidado) (relay)"           "^relay$"    -e HOST_NAT=cone -e GUEST_NAT=sym
run "simétrico <-> simétrico (relay)"                  "^relay$"    -e HOST_NAT=sym  -e GUEST_NAT=sym
run "UDP bloqueado no convidado (relay por TCP/TLS)"   "^relay$"    -e HOST_NAT=cone -e GUEST_NAT=cone -e GUEST_UDP=blocked
run "UDP bloqueado no host (relay por TCP/TLS)"        "^relay$"    -e HOST_NAT=cone -e GUEST_NAT=cone -e HOST_UDP=blocked
