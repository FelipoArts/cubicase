package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- Emitter que guarda os eventos ----

type capEmitter struct {
	mu  sync.Mutex
	evs []map[string]any
}

func (c *capEmitter) Emit(e map[string]any) {
	c.mu.Lock()
	c.evs = append(c.evs, e)
	c.mu.Unlock()
}

func (c *capEmitter) find(pred func(map[string]any) bool) map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.evs {
		if pred(e) {
			return e
		}
	}
	return nil
}

func (c *capEmitter) wait(t *testing.T, what string, d time.Duration, pred func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if e := c.find(pred); e != nil {
			return e
		}
		time.Sleep(20 * time.Millisecond)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	t.Fatalf("evento %q não apareceu em %v; eventos: %v", what, d, c.evs)
	return nil
}

func has(key, val string) func(map[string]any) bool {
	return func(e map[string]any) bool { v, ok := e[key]; return ok && (val == "" || v == val) }
}

// ---- Sala de sinalização em memória (mesma semântica da sala do Worker) ----

type memHub struct {
	mu     sync.Mutex
	host   *memSig
	guests map[string]*memSig
	next   int
	dials  int
	// dropAnswers: quantas respostas do host a convidados a sala "perde" (simula mensagem descartada no caminho).
	dropAnswers int
}

func newHub() *memHub { return &memHub{guests: map[string]*memSig{}} }

type memSig struct {
	hub    *memHub
	role   string
	id     string
	recv   chan Msg
	closed bool
	peerID string
}

func (h *memHub) Dialer(role string) Dialer {
	return func(ctx context.Context) (Signal, error) {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.dials++
		s := &memSig{hub: h, role: role, recv: make(chan Msg, 256)}
		if role == modeGuest {
			h.next++
			s.id = "g" + strconv.Itoa(h.next)
		}
		return s, nil
	}
}

func (h *memHub) Dials() int { h.mu.Lock(); defer h.mu.Unlock(); return h.dials }

func (s *memSig) deliver(m Msg) {
	if s == nil {
		return
	}
	select {
	case s.recv <- m:
	default:
	}
}

func (s *memSig) Send(ctx context.Context, m Msg) error {
	h := s.hub
	h.mu.Lock()
	defer h.mu.Unlock()
	if s.closed {
		return io.ErrClosedPipe
	}
	switch s.role {
	case modeHost:
		switch m.T {
		case msgHello:
			s.peerID = m.PeerID
			h.host = s
			for _, g := range h.guests {
				g.deliver(Msg{T: msgHostOnline, PeerID: m.PeerID})
			}
		case msgAnswer, msgICE, msgError:
			if m.T == msgAnswer && h.dropAnswers > 0 {
				h.dropAnswers--
				return nil
			}
			h.guests[m.To].deliver(m)
		}
	case modeGuest:
		switch m.T {
		case msgHello:
			h.guests[s.id] = s
			if h.host != nil {
				s.deliver(Msg{T: msgHostOnline, PeerID: h.host.peerID})
			} else {
				s.deliver(Msg{T: msgHostLeft})
			}
		case msgOffer, msgICE, msgBye:
			m.From = s.id
			h.host.deliver(m)
		}
	}
	return nil
}

func (s *memSig) Recv() <-chan Msg { return s.recv }

func (s *memSig) Close() {
	h := s.hub
	h.mu.Lock()
	defer h.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	close(s.recv)
	switch s.role {
	case modeHost:
		if h.host == s {
			h.host = nil
			for _, g := range h.guests {
				g.deliver(Msg{T: msgHostLeft})
			}
		}
	case modeGuest:
		delete(h.guests, s.id)
		h.host.deliver(Msg{T: msgPeerLeft, From: s.id})
	}
}

// killHost derruba a sinalização do host (simula o WebSocket caindo).
func (h *memHub) killHost() {
	h.mu.Lock()
	s := h.host
	h.mu.Unlock()
	if s != nil {
		s.Close()
	}
}

// ---- Serviços locais falsos ----

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// startEcho: "Minecraft" falso que devolve tudo que recebe.
func startEcho(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// startRegistry: servidor HTTP local do app (lista de mods) falso.
func startRegistry(t *testing.T, body string) int {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, body+" path="+r.URL.Path)
	}))
	t.Cleanup(srv.Close)
	u := srv.Listener.Addr().(*net.TCPAddr)
	return u.Port
}

func testConfig(t *testing.T, mode string, localPort int) Config {
	t.Helper()
	cfg := Config{
		Mode: mode, PeerID: "sess-" + mode, SignalURL: "wss://exemplo.invalid/ws", SignalToken: "tok",
		LocalPort: localPort, LoopbackCandidates: true,
	}
	if err := cfg.normalize(); err != nil {
		t.Fatal(err)
	}
	return cfg
}

// runner executa host/guest em goroutines e encerra no fim do teste.
type runner struct {
	cancel context.CancelFunc
	done   chan error
}

func (r *runner) stop() error {
	r.cancel()
	select {
	case err := <-r.done:
		return err
	case <-time.After(10 * time.Second):
		return context.DeadlineExceeded
	}
}

func startHost(t *testing.T, cfg Config, em Emitter, hub *memHub) (*Host, *runner) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	h := NewHost(cfg, em, hub.Dialer(modeHost))
	r := &runner{cancel: cancel, done: make(chan error, 1)}
	go func() { r.done <- h.Run(ctx) }()
	t.Cleanup(func() { _ = r.stop() })
	return h, r
}

func startGuest(t *testing.T, cfg Config, em Emitter, hub *memHub) (*Guest, *runner) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	g := NewGuest(cfg, em, hub.Dialer(modeGuest))
	r := &runner{cancel: cancel, done: make(chan error, 1)}
	go func() { r.done <- g.Run(ctx) }()
	t.Cleanup(func() { _ = r.stop() })
	// Só devolve com os listeners locais abertos (o status online sai depois do listen).
	if ce, ok := em.(*capEmitter); ok {
		select {
		case <-time.After(10 * time.Second):
			t.Fatal("convidado não ficou online")
		case err := <-r.done:
			r.done <- err // devolve para quem quiser inspecionar (ex.: erro fatal esperado)
			return g, r
		default:
			ce.wait(t, "convidado online", 10*time.Second, func(e map[string]any) bool { return e["status"] == "online" || e["warning"] != nil })
		}
	}
	return g, r
}

func guestConfig(t *testing.T) (Config, int, int) {
	cfg := testConfig(t, modeGuest, freePort(t))
	cfg.ModsPort = freePort(t)
	return cfg, cfg.LocalPort, cfg.ModsPort
}

func httpGet(t *testing.T, port int, path string) string {
	t.Helper()
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + strconv.Itoa(port) + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return strings.TrimSpace(string(b))
}
