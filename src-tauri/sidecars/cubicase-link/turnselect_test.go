package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/turn/v5"
)

// startTestTURN sobe um servidor TURN de verdade em 127.0.0.1 (UDP e/ou TCP na mesma porta) e conta
// quantas ALOCAÇÕES os clientes pedem. Cada alocação é uma vaga da cota por usuário do coturn.
func startTestTURN(t *testing.T, withUDP, withTCP bool) (port int, allocs *atomic.Int32) {
	t.Helper()
	allocs = &atomic.Int32{}

	// Descobre uma porta livre em TCP e usa a mesma em UDP.
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port = l.Addr().(*net.TCPAddr).Port

	gen := &turn.RelayAddressGeneratorStatic{RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1"}
	cfg := turn.ServerConfig{
		Realm: "teste",
		AuthHandler: func(ra *turn.RequestAttributes) (string, []byte, bool) {
			return ra.Username, turn.GenerateAuthKey(ra.Username, ra.Realm, "segredo"), true
		},
		QuotaHandler: func(username, realm string, src net.Addr) bool { allocs.Add(1); return true },
	}
	if withTCP {
		cfg.ListenerConfigs = []turn.ListenerConfig{{Listener: l, RelayAddressGenerator: gen}}
	} else {
		_ = l.Close() // a porta TCP fica fechada: recusa conexão
	}
	if withUDP {
		pc, err := net.ListenPacket("udp4", "127.0.0.1:"+strconv.Itoa(port))
		if err != nil {
			t.Fatal(err)
		}
		cfg.PacketConnConfigs = []turn.PacketConnConfig{{PacketConn: pc, RelayAddressGenerator: gen}}
	}
	srv, err := turn.NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return port, allocs
}

// gatherAllocations cria uma conexão com a config dada, deixa o ICE coletar os candidatos e devolve
// quantas alocações o servidor TURN recebeu.
func gatherAllocations(t *testing.T, cfg Config, allocs *atomic.Int32) int {
	t.Helper()
	pc, err := newPeerConnection(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	if _, err := pc.CreateDataChannel("ctl", nil); err != nil {
		t.Fatal(err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	done := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("a coleta de candidatos não terminou")
	}
	return int(allocs.Load())
}

func turnCfg(port int, urls ...string) Config {
	return Config{ICE: ICEConfig{TURN: &TURNConfig{URLs: urls, Username: "u", Credential: "segredo"}}, LoopbackCandidates: true}
}

func TestUmaConexaoUsaUmaAlocacaoQuandoOUDPFunciona(t *testing.T) {
	port, allocs := startTestTURN(t, true, true)
	p := strconv.Itoa(port)
	// As mesmas 2 formas que a API entrega (UDP e TCP no mesmo servidor). Antes da correção cada
	// URL virava uma alocação própria: o limite de 6 por usuário do coturn estourava com 3 convidados.
	n := gatherAllocations(t, turnCfg(port, "turn:127.0.0.1:"+p, "turn:127.0.0.1:"+p+"?transport=tcp"), allocs)
	if n != 1 {
		t.Fatalf("esperava 1 alocação por conexão, houve %d", n)
	}
}

func TestSemUDPUsaOCaminhoPorTCP(t *testing.T) {
	port, allocs := startTestTURN(t, false, true) // UDP bloqueado: só TCP responde
	p := strconv.Itoa(port)
	n := gatherAllocations(t, turnCfg(port, "turn:127.0.0.1:"+p, "turn:127.0.0.1:"+p+"?transport=tcp"), allocs)
	if n != 1 {
		t.Fatalf("com o UDP bloqueado esperava 1 alocação (por TCP), houve %d", n)
	}
}

func TestSelectTURNURLs(t *testing.T) {
	udp, tcp, tls := "turn:r.exemplo:3478", "turn:r.exemplo:3478?transport=tcp", "turns:r.exemplo:443?transport=tcp"
	all := []string{udp, tcp, tls}
	up := func(string) bool { return true }
	down := func(string) bool { return false }

	if got := selectTURNURLs(all, up); len(got) != 1 || got[0] != udp {
		t.Errorf("UDP ok: queria só %q, veio %v", udp, got)
	}
	if got := selectTURNURLs(all, down); len(got) != 1 || got[0] != tls {
		t.Errorf("UDP bloqueado: queria o TLS (443) %q, veio %v", tls, got)
	}
	if got := selectTURNURLs([]string{udp, tcp}, down); len(got) != 1 || got[0] != tcp {
		t.Errorf("UDP bloqueado sem TLS: queria o TCP, veio %v", got)
	}
	if got := selectTURNURLs([]string{tls, tcp}, up); len(got) != 1 || got[0] != tls {
		t.Errorf("sem URL UDP: queria o TLS, veio %v", got)
	}
	if got := selectTURNURLs([]string{udp}, down); len(got) != 1 || got[0] != udp {
		t.Errorf("só há UDP: mantém, veio %v", got)
	}
	if got := selectTURNURLs(nil, up); len(got) != 0 {
		t.Errorf("sem URLs: nada, veio %v", got)
	}
	// URL desconhecida/estranha não some: vira UDP (comportamento padrão do TURN)
	if got := selectTURNURLs([]string{"turn:x:1?foo=bar"}, up); len(got) != 1 {
		t.Errorf("URL estranha deve ser mantida, veio %v", got)
	}
}

func TestTokenRecusadoPelaSalaEhErroFatalComCodigo(t *testing.T) {
	// Sala que responde 401 (token expirado): o sidecar não deve ficar reconectando para sempre.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "token inválido", http.StatusUnauthorized)
	}))
	defer srv.Close()
	dial := DialWebSocket("ws"+strings.TrimPrefix(srv.URL, "http"), "token-velho")

	if _, err := dial(context.Background()); !errors.Is(err, errTokenRejected) {
		t.Fatalf("o Dialer devia sinalizar token recusado, veio %v", err)
	}

	check := func(name string, run func() error) {
		t.Helper()
		done := make(chan error, 1)
		go func() { done <- run() }()
		select {
		case err := <-done:
			var ce *codedError
			if !errors.As(err, &ce) || ce.Code != "token_expired" {
				t.Errorf("%s: esperava o erro com código token_expired, veio %v", name, err)
			}
		case <-time.After(5 * time.Second):
			t.Errorf("%s: continuou tentando reconectar em vez de sair", name)
		}
	}
	check("host", func() error {
		return NewHost(Config{Mode: modeHost, PeerID: "h", MaxGuests: 2}, &capEmitter{}, dial).Run(context.Background())
	})
	check("convidado", func() error {
		return NewGuest(Config{Mode: modeGuest, PeerID: "g"}, &capEmitter{}, dial).Run(context.Background())
	})
}
