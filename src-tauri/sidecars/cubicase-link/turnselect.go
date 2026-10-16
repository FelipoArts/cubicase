package main

import (
	"crypto/rand"
	"encoding/binary"
	"net"
	"strings"
	"sync"
	"time"
)

// Escolha da URL do relay (TURN) a usar.
//
// A API entrega o mesmo relay por 3 caminhos: UDP 3478, TCP 3478 e TLS 443 (este último atravessa
// redes que só deixam passar HTTPS). A biblioteca ICE, porém, abre UMA ALOCAÇÃO no servidor para
// CADA URL da lista — 3 por conexão. O coturn limita as alocações por usuário (user-quota), e o
// host tem uma conexão por convidado: com 3 convidados o limite estourava e os últimos ficavam
// sem relay. Como os três caminhos levam ao MESMO servidor, basta usar o melhor que funciona:
//   - UDP, se o servidor responde por UDP (rápido e o caso comum);
//   - senão TLS 443 (passa por quase tudo), e por último TCP 3478.
// Resultado: uma alocação por conexão.

type turnKind int

const (
	turnUDP turnKind = iota
	turnTCP
	turnTLS
)

func classifyTURN(u string) turnKind {
	l := strings.ToLower(u)
	switch {
	case strings.HasPrefix(l, "turns:"):
		return turnTLS
	case strings.Contains(l, "transport=tcp"):
		return turnTCP
	}
	return turnUDP
}

// turnHostPort extrai "host:porta" de "turn:host:3478?transport=tcp".
func turnHostPort(u string) string {
	if i := strings.IndexByte(u, ':'); i >= 0 {
		u = u[i+1:]
	}
	if i := strings.IndexByte(u, '?'); i >= 0 {
		u = u[:i]
	}
	return u
}

// selectTURNURLs reduz a lista a UMA url. `udpWorks` diz se o servidor responde por UDP.
func selectTURNURLs(urls []string, udpWorks func(hostport string) bool) []string {
	var udp, tcp, tls []string
	for _, u := range urls {
		switch classifyTURN(u) {
		case turnTLS:
			tls = append(tls, u)
		case turnTCP:
			tcp = append(tcp, u)
		default:
			udp = append(udp, u)
		}
	}
	if len(udp) > 0 && udpWorks(turnHostPort(udp[0])) {
		return udp[:1]
	}
	switch {
	case len(tls) > 0:
		return tls[:1]
	case len(tcp) > 0:
		return tcp[:1]
	case len(udp) > 0:
		return udp[:1] // só havia UDP: tenta mesmo assim (a sondagem pode ter falhado à toa)
	}
	return nil
}

// ---------------- sondagem do caminho UDP ----------------

const (
	udpProbeTimeout = 1200 * time.Millisecond
	udpProbeTTL     = time.Minute
)

type probeResult struct {
	ok bool
	at time.Time
}

var (
	probeMu    sync.Mutex
	probeCache = map[string]probeResult{}
)

// probeTURNUDP manda um STUN Binding Request ao servidor por UDP e espera a resposta. O coturn
// responde sem exigir credenciais. O resultado fica em cache por 1 min: o host cria uma conexão
// por convidado e não deve pagar a espera de cada vez.
func probeTURNUDP(hostport string) bool {
	probeMu.Lock()
	if r, ok := probeCache[hostport]; ok && time.Since(r.at) < udpProbeTTL {
		probeMu.Unlock()
		return r.ok
	}
	probeMu.Unlock()

	ok := stunBindingOverUDP(hostport, udpProbeTimeout)

	probeMu.Lock()
	probeCache[hostport] = probeResult{ok: ok, at: time.Now()}
	probeMu.Unlock()
	return ok
}

func stunBindingOverUDP(hostport string, timeout time.Duration) bool {
	addr, err := net.ResolveUDPAddr("udp4", hostport)
	if err != nil {
		return false
	}
	conn, err := net.DialUDP("udp4", nil, addr)
	if err != nil {
		return false
	}
	defer conn.Close()

	// Cabeçalho STUN de 20 bytes: tipo 0x0001 (Binding Request), tamanho 0, cookie, id da transação.
	req := make([]byte, 20)
	binary.BigEndian.PutUint16(req[0:2], 0x0001)
	binary.BigEndian.PutUint32(req[4:8], 0x2112A442)
	if _, err := rand.Read(req[8:20]); err != nil {
		return false
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if _, err := conn.Write(req); err != nil {
		return false
	}
	buf := make([]byte, 1500)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			return false
		}
		// Resposta de sucesso (0x0101) da MESMA transação.
		if n >= 20 && binary.BigEndian.Uint16(buf[0:2]) == 0x0101 && string(buf[8:20]) == string(req[8:20]) {
			return true
		}
	}
}
