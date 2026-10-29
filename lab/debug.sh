#!/bin/bash
# Diagnóstico da topologia: monta as redes (sem rodar o teste) e testa cada salto.
set -u
sed -n '/^for n in hostlan/,/^sleep 1/p' /work/lab/case.sh > /tmp/topo.sh
export BIN=/work/lab/bin HOST_NAT=cone GUEST_NAT=cone HOST_UDP=open GUEST_UDP=open WIRE=
log() { echo "[lab] $*"; }
ns() { ip netns exec "$@"; }
source /tmp/topo.sh
echo "--- ping guestlan -> rg"; ns guestlan ping -c1 -W2 192.168.20.1 | tail -2
echo "--- ping rg -> wire side (100.64.2.1)"; ns rg ping -c1 -W2 100.64.2.1 | tail -2
echo "--- ping inet -> 172.31.0.1"; ns inet ping -c1 -W2 172.31.0.1 | tail -2
echo "--- ping inet -> 8.8.8.8"; ns inet ping -c1 -W2 8.8.8.8 | tail -2
echo "--- guestlan -> 1.1.1.1"; ns guestlan ping -c1 -W2 1.1.1.1 | tail -2
echo "--- labwire log"; cat /tmp/labwire.log
ns wire ip -s link | head -20
echo "--- DNS"; ns guestlan nslookup cubeforge-api.cubeforge.workers.dev 1.1.1.1 | tail -3
echo "--- curl -v"; ns guestlan curl -sv -m 8 -o /dev/null https://cubeforge-api.cubeforge.workers.dev/health 2>&1 | tail -8
echo "--- ethtool offload"; ns wire ip -d link show wA | head -3; ns rg ip -d link show rgup | grep -o 'gso_max_size [0-9]*'
echo "--- furo de NAT manual (cone <-> cone)"
ns hostlan node /work/lab/punch.mjs 5000 100.64.2.2 6000 &
ns guestlan node /work/lab/punch.mjs 6000 100.64.1.2 5000
wait
