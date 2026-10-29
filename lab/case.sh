#!/bin/bash
# Monta as redes simuladas dentro do contêiner e roda o teste de campo (scripts/e2e-link.mjs) com o HOST numa rede e os
# CONVIDADOS em outra, cada uma atrás do seu NAT, com a "internet" no meio:
#
#   [hostlan] -- rh(NAT) --\
#                           inet -- (internet de verdade, por NAT do contêiner)
#   [guestlan] - rg(NAT) -- wire --/        <- labwire aplica atraso/perda/banda no cabo do convidado
#
# Variáveis (todas opcionais):
#   HOST_NAT / GUEST_NAT   cone (padrão) | sym   — cone permite furar o NAT; sym (porta aleatória por destino) não
#   HOST_UDP / GUEST_UDP   open (padrão) | blocked — blocked corta todo UDP de saída, exceto DNS
#   WIRE                   flags do labwire no cabo do convidado, ex.: "-delay 80ms -jitter 30ms -loss 0.03"
#   WIRE_BLACKOUT          ex.: "40s:50s" — queda total de rede do convidado entre esses instantes
#   ARGS                   argumentos do e2e-link.mjs (convidados, relay, fases...)
set -u
HOST_NAT=${HOST_NAT:-cone}; GUEST_NAT=${GUEST_NAT:-cone}
HOST_UDP=${HOST_UDP:-open}; GUEST_UDP=${GUEST_UDP:-open}
WIRE=${WIRE:-}; ARGS=${ARGS:-"--guests 3 --relay 0 --mb 1"}
BIN=/work/lab/bin

log() { echo "[lab] $*"; }
ns() { ip netns exec "$@"; }

for n in hostlan rh guestlan rg wire inet; do ip netns add $n; ns $n ip link set lo up; ns $n sysctl -qw net.ipv4.ip_forward=1; done
mkdir -p /etc/netns/hostlan /etc/netns/guestlan
echo "nameserver 1.1.1.1" | tee /etc/netns/hostlan/resolv.conf >/etc/netns/guestlan/resolv.conf

link() { # link <nsA> <ifA> <ipA/len> <nsB> <ifB> <ipB/len>
  ip link add "$2" type veth peer name "$5"
  ip link set "$2" netns "$1"; ip link set "$5" netns "$4"
  [ -n "$3" ] && ns "$1" ip addr add "$3" dev "$2"; [ -n "$6" ] && ns "$4" ip addr add "$6" dev "$5"
  ns "$1" ip link set "$2" up; ns "$4" ip link set "$5" up
}

# LANs
link hostlan hl0 192.168.10.2/24 rh rhlan 192.168.10.1/24
link guestlan gl0 192.168.20.2/24 rg rglan 192.168.20.1/24
ns hostlan ip route add default via 192.168.10.1
ns guestlan ip route add default via 192.168.20.1
# uplinks
link rh rhup 100.64.1.2/24 inet iuH 100.64.1.1/24
link rg rgup 100.64.2.2/24 wire wA ""
link wire wB "" inet iuG 100.64.2.1/24
ns wire ip link set wA promisc on; ns wire ip link set wB promisc on
# O cabo do convidado passa por AF_PACKET: sem offload, os pacotes chegam com checksum completo (senão TCP/UDP seriam descartados)
for d in "rg rgup" "wire wA" "wire wB" "inet iuG"; do set -- $d; ns "$1" ethtool -K "$2" tx off rx off gso off tso off gro off >/dev/null 2>&1; done
ns rh ip route add default via 100.64.1.1
ns rg ip route add default via 100.64.2.1
# saída da "internet" para a internet de verdade (NAT do contêiner)
ip link add inet1 type veth peer name inet0; ip link set inet0 netns inet
ip addr add 172.31.0.1/24 dev inet1; ip link set inet1 up
ns inet ip addr add 172.31.0.2/24 dev inet0; ns inet ip link set inet0 up
ns inet ip route add default via 172.31.0.1
sysctl -qw net.ipv4.ip_forward=1
iptables -t nat -A POSTROUTING -s 172.31.0.0/24 -j MASQUERADE
ns inet iptables -t nat -A POSTROUTING -o inet0 -j MASQUERADE

# NAT + firewall de "roteador doméstico" (só deixa entrar o que foi pedido de dentro)
nat() { # nat <ns> <lan-if> <up-if> <cone|sym> <open|blocked>
  local n=$1 lan=$2 up=$3 kind=$4 udp=$5 rand=""
  [ "$kind" = sym ] && rand="--random"
  ns "$n" iptables -t nat -A POSTROUTING -o "$up" -j MASQUERADE $rand
  # Pacote novo vindo de fora e destinado ao próprio roteador seria "confirmado" no conntrack e tomaria a porta que o
  # furo de NAT precisa (a saída seguinte ganharia outra porta). Roteador doméstico real o descarta antes disso.
  ns "$n" iptables -A INPUT -i "$up" -m conntrack --ctstate NEW -j DROP
  ns "$n" iptables -P FORWARD DROP
  ns "$n" iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  if [ "$udp" = blocked ]; then
    ns "$n" iptables -A FORWARD -i "$lan" -p udp --dport 53 -j ACCEPT
    ns "$n" iptables -A FORWARD -i "$lan" -p udp -j DROP
  fi
  ns "$n" iptables -A FORWARD -i "$lan" -j ACCEPT
}
nat rh rhlan rhup "$HOST_NAT" "$HOST_UDP"
nat rg rglan rgup "$GUEST_NAT" "$GUEST_UDP"
log "redes montadas: host=$HOST_NAT/$HOST_UDP convidado=$GUEST_NAT/$GUEST_UDP cabo do convidado: ${WIRE:-sem alteração}"

# serviços do laboratório: STUN local (para o NAT simulado aparecer como endereço público) e o cabo
ns inet "$BIN/labstun" -listen :3478 >/tmp/labstun.log 2>&1 &
ns wire "$BIN/labwire" -a wA -b wB $WIRE ${WIRE_BLACKOUT:+-blackout $WIRE_BLACKOUT} >/tmp/labwire.log 2>&1 &
sleep 1
# conferências rápidas: o convidado enxerga a internet e o STUN?
ns guestlan curl -s -m 8 -o /dev/null -w "[lab] convidado -> API: HTTP %{http_code} em %{time_total}s\n" https://cubeforge-api.cubeforge.workers.dev/health
ns hostlan curl -s -m 8 -o /dev/null -w "[lab] host -> API: HTTP %{http_code} em %{time_total}s\n" https://cubeforge-api.cubeforge.workers.dev/health

# o teste roda DENTRO da rede do convidado; o host (e o "Minecraft" falso) sobem na rede do host
cd /work
ns guestlan node scripts/e2e-link.mjs --bin "$BIN/cubicase-link" --host-prefix "ip netns exec hostlan" \
  --stun-host "100.64.1.1:3478" --stun-guest "100.64.2.1:3478" $ARGS
code=$?
if [ -n "${DUMP:-}" ]; then
  for n in rh rg; do echo "[lab] conntrack UDP em $n:"; ns $n grep -E "udp" /proc/net/nf_conntrack 2>/dev/null | cut -c1-230; done
  echo "[lab] labstun:"; tail -8 /tmp/labstun.log
fi
log "labwire: $(tail -2 /tmp/labwire.log | tr '\n' ' ')"
exit $code
