package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

// Host: recebe convidados pela sala de sinalização e, para cada DataChannel aberto por
// um convidado, encaminha para o serviço local (Minecraft ou HTTP do app).
type Host struct {
	cfg  Config
	em   Emitter
	dial Dialer

	mu     sync.Mutex
	guests map[string]*hostPeer // por guestId (atribuído pela sala)
	sig    Signal               // sinalização atual (nil entre reconexões)
	online bool
}

type hostPeer struct {
	id   string
	pc   *webrtc.PeerConnection
	game atomic.Int32
	http atomic.Int32
}

func NewHost(cfg Config, em Emitter, dial Dialer) *Host {
	return &Host{cfg: cfg, em: em, dial: dial, guests: map[string]*hostPeer{}}
}

// Run fica de pé até o contexto acabar, reconectando a sinalização com backoff. Conexões
// já estabelecidas continuam funcionando enquanto a sinalização está fora (o caminho
// de dados é direto; só novas conexões/renegociações precisam da sala).
func (h *Host) Run(ctx context.Context) error {
	backoff := time.Second
	for ctx.Err() == nil {
		sig, err := h.dial(ctx)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			if errors.Is(err, errTokenRejected) {
				h.closeAll()
				return coded("token_expired", err)
			}
			emitWarning(h.em, "signal_unreachable", describe(err))
			if !sleepCtx(ctx, backoff) {
				break
			}
			backoff = nextBackoff(backoff)
			continue
		}
		backoff = time.Second
		h.serve(ctx, sig)
		if ctx.Err() == nil {
			emitWarning(h.em, "signal_lost", "conexão com a sala de sinalização caiu; reconectando")
			sleepCtx(ctx, time.Second)
		}
	}
	h.closeAll()
	return nil
}

func (h *Host) serve(ctx context.Context, sig Signal) {
	defer sig.Close()
	h.mu.Lock()
	h.sig = sig
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if h.sig == sig {
			h.sig = nil
		}
		h.mu.Unlock()
	}()

	if err := sig.Send(ctx, Msg{T: msgHello, V: protocolVersion, Role: modeHost, PeerID: h.cfg.PeerID}); err != nil {
		return
	}
	h.mu.Lock()
	first := !h.online
	h.online = true
	h.mu.Unlock()
	if first {
		emitStatusOnline(h.em)
		emitInfo(h.em, "Host aguardando convidados")
	} else {
		emitRecovered(h.em, "signal_lost")
	}

	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-sig.Recv():
			if !ok {
				return
			}
			h.handle(ctx, sig, m)
		}
	}
}

func (h *Host) handle(ctx context.Context, sig Signal, m Msg) {
	switch m.T {
	case msgOffer:
		h.onOffer(ctx, sig, m)
	case msgICE:
		if p := h.peer(m.From); p != nil && m.Candidate != nil {
			if err := p.pc.AddICECandidate(*m.Candidate); err != nil {
				emitInfo(h.em, "candidato ICE ignorado: "+describe(err))
			}
		}
	case msgBye, msgPeerLeft:
		h.dropGuest(m.From)
	case msgError:
		emitWarning(h.em, "signal_error", m.Code+" "+m.Detail)
	}
}

func (h *Host) peer(id string) *hostPeer {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.guests[id]
}

func (h *Host) onOffer(ctx context.Context, sig Signal, m Msg) {
	if m.From == "" || m.SDP == "" {
		return
	}
	p := h.peer(m.From)
	dbg("host: oferta de %s (peer existente=%v)", m.From, p != nil)
	if p == nil { // convidado novo
		h.mu.Lock()
		full := len(h.guests) >= h.cfg.MaxGuests
		h.mu.Unlock()
		if full {
			_ = sig.Send(ctx, Msg{T: msgError, To: m.From, Code: "ROOM_FULL", Detail: "limite de convidados atingido"})
			return
		}
		var err error
		if p, err = h.newPeer(ctx, m.From); err != nil {
			emitWarning(h.em, "peer_failed", describe(err))
			return
		}
	}
	// Oferta nova OU renegociação (ICE restart) de um convidado existente.
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: m.SDP}); err != nil {
		emitWarning(h.em, "peer_failed", describe(err))
		h.dropGuest(m.From)
		return
	}
	answer, err := p.pc.CreateAnswer(nil)
	if err == nil {
		err = p.pc.SetLocalDescription(answer)
	}
	if err != nil {
		emitWarning(h.em, "peer_failed", describe(err))
		h.dropGuest(m.From)
		return
	}
	_ = sig.Send(ctx, Msg{T: msgAnswer, To: m.From, SDP: answer.SDP})
	dbg("host: resposta enviada para %s", m.From)
}

func (h *Host) newPeer(ctx context.Context, id string) (*hostPeer, error) {
	pc, err := newPeerConnection(h.cfg)
	if err != nil {
		return nil, err
	}
	p := &hostPeer{id: id, pc: pc}
	h.mu.Lock()
	h.guests[id] = p
	h.mu.Unlock()

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		h.mu.Lock()
		sig := h.sig
		h.mu.Unlock()
		if sig != nil {
			_ = sig.Send(ctx, Msg{T: msgICE, To: id, Candidate: &init})
		}
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		dbg("host: convidado %s estado=%s", id, s)
		switch s {
		case webrtc.PeerConnectionStateConnected:
			if path := classifyPath(pc); path != "" {
				emitPath(h.em, path, -1)
			}
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			h.dropPeerIfSame(id, p)
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) { h.onChannel(p, dc) })
	return p, nil
}

func (h *Host) onChannel(p *hostPeer, dc *webrtc.DataChannel) {
	kind := channelKind(dc.Label())
	dc.OnOpen(func() {
		rwc, err := dc.Detach()
		if err != nil {
			return
		}
		switch kind {
		case labelGame:
			if p.game.Add(1) > maxGameChannels {
				p.game.Add(-1)
				_ = rwc.Close()
				return
			}
			go func() {
				defer p.game.Add(-1)
				h.forward(rwc, h.cfg.LocalPort)
			}()
		case labelHTTP:
			if p.http.Add(1) > maxHTTPChannels {
				p.http.Add(-1)
				_ = rwc.Close()
				return
			}
			go func() {
				defer p.http.Add(-1)
				h.forward(rwc, h.cfg.RegistryPort)
			}()
		case labelCtl:
			go serveCtl(rwc)
		default:
			_ = rwc.Close() // rótulo desconhecido: não encaminha nada
		}
	})
}

// forward liga o canal ao serviço local na porta dada.
func (h *Host) forward(rwc io.ReadWriteCloser, port int) {
	conn, err := dialLocal(port)
	if err != nil {
		_ = rwc.Close()
		return
	}
	pipe(conn, rwc)
}

// serveCtl responde aos pings do convidado (medição de latência).
func serveCtl(rwc io.ReadWriteCloser) {
	defer rwc.Close()
	buf := make([]byte, dcReadBuf)
	for {
		n, err := rwc.Read(buf)
		if err != nil {
			return
		}
		var m struct {
			T  string `json:"t"`
			TS int64  `json:"ts"`
		}
		if json.Unmarshal(buf[:n], &m) == nil && m.T == "ping" {
			b, _ := json.Marshal(map[string]any{"t": "pong", "ts": m.TS})
			if _, err := rwc.Write(b); err != nil {
				return
			}
		}
	}
}

func (h *Host) dropGuest(id string) {
	h.mu.Lock()
	p := h.guests[id]
	delete(h.guests, id)
	h.mu.Unlock()
	if p != nil {
		_ = p.pc.Close()
	}
}

func (h *Host) dropPeerIfSame(id string, p *hostPeer) {
	h.mu.Lock()
	if h.guests[id] == p {
		delete(h.guests, id)
	}
	h.mu.Unlock()
	_ = p.pc.Close()
}

func (h *Host) closeAll() {
	h.mu.Lock()
	all := h.guests
	h.guests = map[string]*hostPeer{}
	h.mu.Unlock()
	for _, p := range all {
		_ = p.pc.Close()
	}
}

// GuestCount: usado nos testes.
func (h *Host) GuestCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.guests)
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func nextBackoff(d time.Duration) time.Duration {
	d *= 2
	if d > 30*time.Second {
		d = 30 * time.Second
	}
	return d
}
