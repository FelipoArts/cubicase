# Relay TURN do Cubicase (coturn na Oracle Cloud)

O relay só entra quando a conexão direta entre host e convidado não é possível. Ele repassa pacotes **já
cifrados** (DTLS); não vê o conteúdo. Plano: `plans/p2p-link-transport-plan.md`.

Roteiro, na ordem. Os passos 1–4 são no painel da Oracle e no DNS; do 5 em diante, no terminal.

## 1. IP público reservado (não muda se a VM reiniciar)
Painel da Oracle → **Networking → IP management → Reserved public IPs → Reserve public IP address**
(nome `relay-sp1-ip`). Depois associe à VM: **Compute → Instances → sua VM → Attached VNICs →** a VNIC primária
**→ IPv4 addresses →** os três pontinhos do IP privado **→ Edit → Reserved public IP →** escolha `relay-sp1-ip`.
(Os nomes dos menus podem variar um pouco; a ideia é "associar o IP reservado ao IP privado da VM".)

Anote o endereço (ex.: `152.x.x.x`).

## 2. Portas na rede da Oracle (Security List)
**Networking → Virtual cloud networks →** sua VCN **→ Subnets →** a sub-rede **→ Security Lists →**
*Default Security List* **→ Add Ingress Rules**. Origem `0.0.0.0/0` em todas, exceto onde indicado:

| Protocolo | Porta(s) | Para quê |
|---|---|---|
| TCP | 22 | SSH — **troque a origem pelo seu IP público** (`SEU.IP/32`) se puder |
| TCP | 80 | validação e renovação do certificado |
| TCP | 443 | TURN sobre TLS |
| TCP | 3478 | TURN sobre TCP |
| UDP | 3478 | TURN (o principal) |
| UDP | 49152–50151 | portas de relay (uma por conexão em relay) |

## 3. DNS
No painel do HostGator (zona `cubicase.net`): registro **A** `turn` → o IP reservado. Sem proxy.
Confira (pode levar alguns minutos): `nslookup turn.cubicase.net`.

## 4. Chave SSH no Windows
A chave privada que você baixou precisa de permissão restrita, senão o SSH recusa. No PowerShell:
```powershell
$k = "$env:USERPROFILE\.ssh\relay-sp1.key"      # onde você guardou a chave
icacls $k /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

## 5. Copiar o script e entrar na VM
```powershell
scp -i $k C:\Projetos\Cubicase\infra\relay\setup-coturn.sh ubuntu@SEU_IP:~
ssh -i $k ubuntu@SEU_IP
```
(Se o script reclamar de `\r`: `sed -i 's/\r$//' setup-coturn.sh`.)

## 6. Instalar
Dentro da VM:
```bash
sudo bash setup-coturn.sh seu-email@exemplo.com
```
Se o DNS ainda não tiver propagado, ele instala tudo menos o TLS e avisa; é só rodar de novo depois.
No fim ele imprime o `TURN_SECRET` e os dois comandos do passo 7.

## 7. Ligar o relay no Worker
No seu computador, na pasta `api/`:
```bash
npx wrangler secret put TURN_SECRET     # cole o valor que o script mostrou
npx wrangler deploy
```
As URLs (`TURN_URLS`) já estão em `api/wrangler.toml`.

## 8. Testar o relay de verdade
Gera credenciais temporárias (no seu computador, usando o mesmo segredo):
```bash
node infra/relay/make-turn-creds.mjs <TURN_SECRET>
```
Copie a linha `-relay -turn "..."` que ele imprime e rode o spike nos dois lados (pode ser no mesmo PC,
em dois terminais; veja `spikes/link-spike/README.md`):
```bash
cd spikes/link-spike
.\link-spike.exe guest -relay -turn "turn:turn.cubicase.net:3478,USUARIO,SENHA"
.\link-spike.exe host  -relay -turn "turn:turn.cubicase.net:3478,USUARIO,SENHA"
```
O bloco final deve mostrar `relay` no caminho ICE. Isso prova o relay, o firewall e as credenciais.

## Cota mensal e medidor de consumo
Servidores **sem Cubicase Plus** têm uma cota mensal de relay (padrão **5 GiB** de saída da VM; mude com a
variável `RELAY_FREE_MONTHLY_BYTES` no `api/wrangler.toml`). Passou disso, o Worker deixa de emitir credenciais
do relay para aquele servidor até o mês virar: a conexão direta segue livre e o app mostra o plano B (Radmin VPN).
Hosts logados com Plus marcam o servidor como Plus (`linkplus:<código>`, 25 h) e ficam sem cota.

Quem mede é o próprio coturn: com `verbose` ele registra o total de cada alocação ao terminar, e o serviço
`relay-usage-reporter` (neste diretório; instalado pelo `setup-coturn.sh` se o `.py` estiver ao lado) lê o
journal e envia lotes assinados (HMAC-SHA256 com o `TURN_SECRET`) para `POST /api/v1/internal/relay-usage`.
- Ver o medidor: `sudo systemctl status relay-usage-reporter` e `sudo journalctl -u relay-usage-reporter -n 30`.
- Falha de rede não perde dados: o lote fica na fila e é reenviado. Linhas `falha ao reportar` repetidas = o Worker
  não está publicado com o endpoint novo, ou o `TURN_SECRET` do Worker difere do da VM.
- O consumo só é gravado quando a alocação termina (o cliente fecha ou a alocação expira, em até 10 min).
- Testes do medidor: `python3 -m unittest test_relay_usage_reporter` (na pasta `infra/relay`).
- Zerar a cota de um servidor (suporte): apague a chave `relayuse:<CÓDIGO>:<AAAA-MM>` do KV.

## Operação
- **Cortar o relay na hora (custo):** `npx wrangler secret put TURN_DISABLED` com o valor `1`; apague o segredo
  (`wrangler secret delete TURN_DISABLED`) para voltar.
- **Ver o que está acontecendo:** `sudo journalctl -u coturn -n 100 --no-pager` e `sudo systemctl status coturn`.
- **Banda:** painel da Oracle → sua VM → *Metrics* (bytes de saída). A franquia é 10 TB/mês.
- **Atualizações de segurança:** o Ubuntu aplica sozinho (`unattended-upgrades`).
- **Segunda máquina (reserva):** repita o roteiro; coloque as duas URLs no `TURN_URLS`.
