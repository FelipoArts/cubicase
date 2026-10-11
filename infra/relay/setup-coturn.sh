#!/usr/bin/env bash
# Instala e configura o relay TURN (coturn) do Cubicase numa VM Ubuntu 22.04/24.04 (Oracle Cloud).
#
#   sudo bash setup-coturn.sh seu-email@exemplo.com
#
# Idempotente: pode rodar de novo (por exemplo, depois de o DNS propagar, para ativar o TLS).
# O que faz: swap, firewall da VM (iptables), coturn, certificado Let's Encrypt (se o DNS já
# aponta para esta VM), configuração endurecida e freios de custo. No fim imprime os valores
# que vão no Worker (TURN_SECRET). Plano: plans/p2p-link-transport-plan.md (§7.5, §9.1).
set -euo pipefail

DOMAIN="${DOMAIN:-turn.cubicase.net}"
EMAIL="${1:-${EMAIL:-}}"
MIN_PORT="${MIN_PORT:-49152}"
MAX_PORT="${MAX_PORT:-50151}"          # ~1000 portas de relay (uma por alocação ativa)
SECRET_FILE=/etc/coturn-cubicase.secret
CONF=/etc/turnserver.conf
CERT_DIR=/etc/coturn/certs

if [[ $EUID -ne 0 ]]; then echo "Rode com sudo."; exit 1; fi
if [[ -z "$EMAIL" ]]; then echo "Uso: sudo bash setup-coturn.sh seu-email@exemplo.com"; exit 1; fi

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

say "1/7 Pacotes"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y coturn certbot iptables-persistent curl dnsutils openssl

say "2/7 Swap de 2 GB (a VM AMD gratuita tem só 1 GB de RAM)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "swap já existe"
fi

say "3/7 Firewall da VM (a imagem Oracle vem com iptables fechado; falta o da rede, no painel)"
open_port() { # proto porta|faixa
  local proto=$1 port=$2
  iptables -C INPUT -p "$proto" --dport "$port" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p "$proto" --dport "$port" -j ACCEPT
}
open_port tcp 80          # validação do certificado (Let's Encrypt) e renovação
open_port tcp 443         # TURN sobre TLS (passa por firewalls que bloqueiam UDP)
open_port tcp 3478
open_port udp 3478
open_port udp "${MIN_PORT}:${MAX_PORT}"
netfilter-persistent save

say "4/7 Segredo compartilhado com o Worker"
if [[ ! -s $SECRET_FILE ]]; then
  umask 077; openssl rand -hex 32 > "$SECRET_FILE"
fi
SECRET="$(cat "$SECRET_FILE")"

say "5/7 Endereços desta VM"
PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://ifconfig.me || true)"
PRIVATE_IP="$(hostname -I | awk '{print $1}')"
echo "IP público visto de fora: ${PUBLIC_IP:-?}   IP privado: $PRIVATE_IP"
DNS_IP="$(dig +short A "$DOMAIN" @1.1.1.1 | tail -n1 || true)"
echo "DNS de $DOMAIN aponta para: ${DNS_IP:-<nada>}"

say "6/7 Certificado TLS (opcional, mas recomendado)"
TLS=0
if [[ -n "$PUBLIC_IP" && "$DNS_IP" == "$PUBLIC_IP" ]]; then
  if [[ ! -d /etc/letsencrypt/live/$DOMAIN ]]; then
    systemctl stop coturn 2>/dev/null || true
    certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" || echo "AVISO: certbot falhou (porta 80 aberta no painel da Oracle?)"
  fi
  if [[ -d /etc/letsencrypt/live/$DOMAIN ]]; then
    mkdir -p "$CERT_DIR" /etc/letsencrypt/renewal-hooks/deploy
    chmod 711 "$(dirname "$CERT_DIR")"   # o usuário turnserver precisa atravessar /etc/coturn para ler os certificados
    cat > /etc/letsencrypt/renewal-hooks/deploy/coturn.sh <<HOOK
#!/usr/bin/env bash
install -d -o turnserver -g turnserver -m 750 $CERT_DIR
install -o turnserver -g turnserver -m 640 /etc/letsencrypt/live/$DOMAIN/fullchain.pem $CERT_DIR/fullchain.pem
install -o turnserver -g turnserver -m 640 /etc/letsencrypt/live/$DOMAIN/privkey.pem $CERT_DIR/privkey.pem
systemctl restart coturn
HOOK
    chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
    RENEWED_LINEAGE=/etc/letsencrypt/live/$DOMAIN bash /etc/letsencrypt/renewal-hooks/deploy/coturn.sh || true
    TLS=1
  fi
else
  echo "O DNS ainda não aponta para esta VM — pulando o TLS. Crie o registro A e rode o script de novo."
fi

say "7/7 Configuração do coturn"
{
cat <<CONF
# Gerado por infra/relay/setup-coturn.sh — não edite à mão (rode o script de novo).
listening-port=3478
listening-ip=0.0.0.0
relay-ip=${PRIVATE_IP}
${PUBLIC_IP:+external-ip=${PUBLIC_IP}/${PRIVATE_IP}}
min-port=${MIN_PORT}
max-port=${MAX_PORT}
realm=${DOMAIN}
server-name=${DOMAIN}
fingerprint

# Credenciais efêmeras emitidas pelo Worker (esquema REST: usuário = expiração:id).
use-auth-secret
static-auth-secret=${SECRET}

# --- Freios de custo (plano §9.1): banda por sessão e total, e número de alocações ---
max-bps=300000          # bytes/s por sessão (~2,4 Mbps): entrar no servidor em ~30 s
bps-capacity=45000000   # bytes/s no total (~360 Mbps de uma placa de 480 Mbps)
total-quota=400         # alocações simultâneas no servidor inteiro
user-quota=6            # alocações por usuário temporário
stale-nonce=600

# --- Endurecimento: o relay não pode servir de ponte para redes internas ---
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1
no-software-attribute
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=240.0.0.0-255.255.255.255
# a própria VM (para o relay entre dois clientes na mesma máquina) é liberada explicitamente:
${PRIVATE_IP:+allowed-peer-ip=${PRIVATE_IP}}
${PUBLIC_IP:+allowed-peer-ip=${PUBLIC_IP}}

syslog
CONF
if [[ $TLS -eq 1 ]]; then
cat <<CONF
# TLS na 443 (TURN sobre TCP/TLS)
tls-listening-port=443
cert=${CERT_DIR}/fullchain.pem
pkey=${CERT_DIR}/privkey.pem
CONF
fi
} > "$CONF"
chmod 640 "$CONF"; chown root:turnserver "$CONF" 2>/dev/null || true

# Pacotes mais antigos exigem habilitar no /etc/default/coturn.
if [[ -f /etc/default/coturn ]]; then sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn; fi
# Permite o bind na 443 sem ser root.
mkdir -p /etc/systemd/system/coturn.service.d
cat > /etc/systemd/system/coturn.service.d/override.conf <<UNIT
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=3
UNIT
systemctl daemon-reload
systemctl enable coturn
systemctl restart coturn
sleep 2
systemctl --no-pager --lines=8 status coturn || true

say "PRONTO"
cat <<DONE

Relay: ${DOMAIN}  (IP público ${PUBLIC_IP:-?})   TLS: $([[ $TLS -eq 1 ]] && echo ativo || echo "NÃO (veja o aviso acima)")

No seu computador, dentro da pasta api/ do projeto:

  1) Guarde o segredo no Worker (cole este valor quando o comando pedir):
       npx wrangler secret put TURN_SECRET
     VALOR: ${SECRET}

  2) Publique de novo:
       npx wrangler deploy
     (as URLs do relay já estão em api/wrangler.toml, variável TURN_URLS)

Para cortar o relay na hora, sem deploy:  npx wrangler secret put TURN_DISABLED  (valor: 1)
DONE
