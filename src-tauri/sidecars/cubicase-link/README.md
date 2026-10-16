# cubicase-link

Transporte P2P do Cubicase (WebRTC: ICE + DTLS + SCTP via `pion`).
Plano completo: `plans/p2p-link-transport-plan.md`. **Fase 1** (este diretório): sidecar autônomo, ainda
não ligado ao app (a integração é a Fase 4).

## Como funciona

- **Host**: conecta na sala de sinalização do servidor, recebe ofertas dos convidados e, para cada
  DataChannel aberto, encaminha para o serviço local: `game#N` → Minecraft (`localPort`), `http#N` → servidor
  HTTP do app (`registryPort`, lista/arquivos de mods), `ctl` → ping/pong de latência.
- **Convidado**: escuta em `127.0.0.1:localPort` (Minecraft) e `127.0.0.1:modsPort` (mods); cada conexão TCP vira um
  DataChannel. Negocia com o host assim que a sala anuncia `host_online`.
- Caminho: ICE tenta direto (IPv6/IPv4/furo de NAT) e cai no relay TURN só se necessário.
- A conexão ativa **sobrevive** à queda da sinalização; o ICE reinicia sozinho em oscilações de rede.

## Contrato com o app

Configuração por `--config <arquivo>` ou `--stdin` (primeira linha JSON); morre quando o stdin do pai fecha.

```json
{
  "mode": "host",
  "peerId": "<sessão>",
  "signalUrl": "wss://.../link/<código>",
  "signalToken": "<jwt da sessão>",
  "ice": { "stunUrls": ["stun:stun.l.google.com:19302"],
           "turn": { "urls": ["turn:turn.cubicase.net:3478"], "username": "...", "credential": "..." } },
  "relayOnly": false,
  "localPort": 25565, "registryPort": 25567, "modsPort": 25568, "maxGuests": 20
}
```

Eventos no stdout (uma linha JSON cada): `{"status":"online","ip":"p2p"}`, `{"info":...}`,
`{"warning":"host_unreachable|signal_lost|signal_unreachable|connection_lost|peer_failed|mods_proxy_unavailable",...}`,
`{"recovered":...}`, `{"path":"direct-v4|direct-v6|punched|relay","rttMs":N}` e, fatal,
`{"error":"config_decode_failed|config_missing|config_read_failed|listen_local_failed|room_full|internal_error","detail":...}`.

## Sinalização (JSON por mensagem WebSocket)

`hello`, `offer`, `answer`, `ice`, `bye` (peers) e `peer_joined|peer_left|host_online|host_left|error` (sala).
O campo `from` é sempre preenchido pela sala. O keepalive é o texto `ping` → `pong`.

## Testes

```bash
go test ./... -count=1
```

Usam conexões WebRTC reais em loopback (host + vários convidados, Minecraft falso, HTTP de mods, queda e volta
do host, queda da sinalização, sala cheia, WebSocket real). Não cobrem NAT de verdade — isso é a Fase 0 pendente
(testes em rede real com o `spikes/link-spike`).
