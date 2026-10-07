# link-spike — Fase 0 do plano P2P

Valida o transporte (pion/webrtc: ICE + DTLS + SCTP) antes de construir o sidecar. Veja
`plans/p2p-link-transport-plan.md`.

## 1. Teste local (já passou na máquina de desenvolvimento)
    go run . loopback          # vazão, latência, 40 canais, ponte TCP

## 2. Teste em rede real (precisa de DOIS computadores)
Sinalização por copiar/colar (sem servidor). Rode `link-spike.exe` nos dois PCs:

1. No **convidado**:  `link-spike.exe guest`   → imprime uma linha longa (OFERTA).
2. No **host**:       `link-spike.exe host`    → cole a oferta; imprime outra linha (RESPOSTA).
3. No **convidado**: cole a resposta. Os testes rodam e imprimem o **caminho ICE** (host/srflx/relay),
   vazão nos dois sentidos e latência.

Combinações a testar (anote o resultado de cada uma):

| # | Host | Convidado | O que se espera |
|---|---|---|---|
| 1 | casa A (Wi‑Fi/cabo) | casa B (outra operadora) | `srflx` ou `host` (IPv6) |
| 2 | casa A | celular (4G/5G, hotspot) | provável `srflx`; pode exigir relay (CGNAT) |
| 3 | mesma rede | mesma rede | `host` |
| 4 | casa A | convidado forçando relay: `guest -relay -turn ...` | `relay` (só depois do coturn na Fase 3) |
| 5 | rede de empresa/escola (UDP bloqueado) | casa | relay TCP/TLS (Fase 3) |

Flags: `-stun stun:...`, `-turn turn:host:3478,usuario,senha`, `-relay`, `-mb 200`.
Sem argumentos o STUN do Google é usado. Se aparecer "timeout ... não conectou", o caminho direto
falhou (NAT simétrico/CGNAT/firewall) — esse é justamente o dado que queremos.

## 3. Medir a banda real do Minecraft
No PC do host, com o servidor aberto e N convidados jogando (explorando, não parados):

    powershell -ExecutionPolicy Bypass -File .\measure-bandwidth.ps1 -Guests 2 -Seconds 300

Troque o número de convidados por quantos estiverem de fato jogando. Também vale cronometrar quanto
demora para **entrar** no servidor (a tela de carregamento) — define o teto do relay (plano: 300 KB/s).
