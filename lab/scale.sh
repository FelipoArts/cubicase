#!/bin/bash
# Fase C: escala contra uma API local (wrangler dev), com vários hosts e vários convidados ao mesmo tempo.
# Antes, em outro terminal:  cd api && npx wrangler dev --local --ip 0.0.0.0 --port 8787 --var LINK_TOKEN_SECRET:qualquer-segredo-longo
# uso (na raiz do repositório): bash lab/scale.sh [hosts] [convidados-por-host]     (padrão: 6 hosts x 10 convidados)
# Atenção: os sidecars saem todos do mesmo IP e a sala limita 120 conexões/min por IP (LINK_WS_RATE_LIMIT), então passar de
# ~60 processos ao mesmo tempo gera 429 que não aconteceria com convidados em IPs diferentes.
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
ROOT=$(pwd -W 2>/dev/null || pwd)
docker run --rm --privileged --add-host=host.docker.internal:host-gateway -v "$ROOT:/work" \
  -e API_URL=http://host.docker.internal:8787 -e HOST_NAT=cone -e GUEST_NAT=cone -e INSTANCES="${1:-6}" \
  -e ARGS="--guests ${2:-10} --relay 0 --mb 0.5 --spread-ip --phases solo,concurrent,crash,restart" \
  cubicase-lab bash /work/lab/case.sh
