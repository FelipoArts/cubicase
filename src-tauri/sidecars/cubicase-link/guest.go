package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	openChannelTimeout = 10 * time.Second
	waitPeerTimeout    = 15 * time.Second
	disconnectGrace    = 6 * time.Second
	pingEvery          = 10 * time.Second
	upgradeAfter       = 20 * time.Second
)

// Guest: escuta em 127.0.0.1 (Minecraft e proxy de mods) e leva cada conexão TCP ao host
// por um DataChannel. A conexão com o host é negociada assim que a sala avisa que ele
// está online, para a primeira conexão do jogo já encontrar o caminho pronto.
type Guest struct {
	cfg  Config
	em   Emitter
	dial Dialer

	mu       sync.Mutex
	sig      Signal
	peer     *guestPeer
	hostSess string // sessão (peerId) do host com quem o peer atual foi negociado
	hostUp   bool
	warned   bool
	online   bool
	seq      atomic.Int64
	fatalCh  chan error
}

type guestPeer struct {
	pc        *webrtc.PeerConnection
	ready     chan struct{} // fechado quando o canal ctl abre (caminho utilizável)
	readyOnce sync.Once
	lastPath  string
	pathMu    sync.Mutex
	upgrading bool         // já tentou subir de relay para direto
	rtt       atomic.Int64 // ms, -1 = desconhecido
}

func NewGuest(cfg Config, em Emitter, dial Dialer) *Guest {
	return &Guest{cfg: cfg, em: em, dial: dial, fatalCh: make(chan error, 1)}
}

// Run abre os listeners locais e mantém a sinalização. Retorna erro com código para
// falhas fatais (porta local ocupada, sala cheia); nil quando o contexto termina.
func (g *Guest) Run(ctx context.Context) error {
	gameLn, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(g.cfg.LocalPort)))
	if err != nil {
		return coded("listen_local_failed", err)
	}
	defer gameLn.Close()
	go g.acceptLoop(ctx, gameLn, labelGame)

	if modsLn, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(g.cfg.ModsPort))); err != nil {
		// Não-fatal: sem o proxy só a sincronização de mods fica indisponível.
		emitWarning(g.em, "mods_proxy_unavailable", describe(err))
	} else {
		defer modsLn.Close()
		go g.acceptLoop(ctx, modsLn, labelHTTP)
	}

	go func() { <-ctx.Done(); _ = gameLn.Close() }()

	backoff := time.Second
	for ctx.Err() == nil {
		sig, err := g.dial(ctx)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			if errors.Is(err, errTokenRejected) {
				g.closePeer()
				return coded("token_expired", err)
			}
			emitWarning(g.em, "signal_unreachable", describe(err))
			if !sleepCtx(ctx, backoff) {
				break
			}
			backoff = nextBackoff(backoff)
			continue
		}
		backoff = time.Second
		g.serve(ctx, sig)
		select {
		case e := <-g.fatalCh:
			g.closePeer()
			return e
		default:
		}
		if ctx.Err() == nil {
			sleepCtx(ctx, time.Second)
		}
	}
	g.closePeer()
	return nil
}

func (g *Guest) serve(ctx context.Context, sig Signal) {
	defer sig.Close()
	g.mu.Lock()
	g.sig = sig
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		if g.sig == sig {
			g.sig = nil
		}
		g.mu.Unlock()
	}()

	if err := sig.Send(ctx, Msg{T: msgHello, V: protocolVersion, Role: modeGuest, PeerID: g.cfg.PeerID}); err != nil {
		return
	}
	g.mu.Lock()
	first := !g.online
	g.online = true
	g.mu.Unlock()
	if first {
		emitStatusOnline(g.em)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-sig.Recv():
			if !ok {
				return
			}
			if !g.handle(ctx, sig, m) {
				return
			}
		}
	}
}

// handle devolve false para encerrar esta sessão de sinalização.
func (g *Guest) handle(ctx context.Context, sig Signal, m Msg) bool {
	switch m.T {
	case msgHostOnline:
		g.mu.Lock()
		g.hostUp = true
		warned := g.warned
		g.warned = false
		g.mu.Unlock()
		if warned {
			emitRecovered(g.em, "host_unreachable")
		}
		// Reabre só se não há conexão saudável OU se este é OUTRO processo de host (uma
		// conexão antiga pode parecer viva por segundos depois de o host original morrer).
		if !g.peerHealthy() || g.hostChanged(m.PeerID) {
			g.startPeer(ctx, m.PeerID)
		}
	case msgHostLeft:
		g.mu.Lock()
		g.hostUp = false
		already := g.warned
		g.warned = true
		g.mu.Unlock()
		// NÃO derruba a conexão: o host pode só ter perdido a sinalização (a sala avisa
		// host_left nesse caso) e o caminho de dados continua funcionando. Se ele saiu de
		// verdade, o ICE detecta em poucos segundos e a conexão falha sozinha.
		if !already {
			emitWarning(g.em, "host_unreachable", "o host saiu ou ainda não está online")
		}
	case msgAnswer:
		if p := g.currentPeer(); p != nil {
			if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: m.SDP}); err != nil {
				emitWarning(g.em, "peer_failed", describe(err))
			}
		}
	case msgICE:
		if p := g.currentPeer(); p != nil && m.Candidate != nil {
			_ = p.pc.AddICECandidate(*m.Candidate)
		}
	case msgError:
		if m.Code == "ROOM_FULL" {
			g.fail(coded("room_full", errors.New(m.Detail)))
			return false
		}
		emitWarning(g.em, "signal_error", m.Code+" "+m.Detail)
	}
	return true
}

func (g *Guest) fail(err error) {
	select {
	case g.fatalCh <- err:
	default:
	}
}

func (g *Guest) currentPeer() *guestPeer {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.peer
}

func (g *Guest) peerHealthy() bool {
	p := g.currentPeer()
	if p == nil {
		return false
	}
	switch p.pc.ConnectionState() {
	case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed, webrtc.PeerConnectionStateDisconnected:
		return false
	}
	return true
}

// hostChanged: true se a sala anunciou um host de OUTRA sessão que a do peer atual.
func (g *Guest) hostChanged(session string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return session != "" && g.hostSess != "" && session != g.hostSess
}

func (g *Guest) lastHostSession() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.hostSess
}

func (g *Guest) closePeer() {
	g.mu.Lock()
	p := g.peer
	g.peer = nil
	g.mu.Unlock()
	if p != nil {
		_ = p.pc.Close()
	}
}

// startPeer cria a conexão com o host e envia a oferta pela sinalização.
func (g *Guest) startPeer(ctx context.Context, hostSession string) {
	g.closePeer()
	pc, err := newPeerConnection(g.cfg)
	if err != nil {
		emitWarning(g.em, "peer_failed", describe(err))
		return
	}
	p := &guestPeer{pc: pc, ready: make(chan struct{})}
	p.rtt.Store(-1)
	g.mu.Lock()
	g.peer = p
	g.hostSess = hostSession
	g.mu.Unlock()

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		g.mu.Lock()
		sig := g.sig
		g.mu.Unlock()
		if sig != nil {
			_ = sig.Send(ctx, Msg{T: msgICE, Candidate: &init})
		}
	})

	var graceTimer atomic.Pointer[time.Timer]
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateConnected:
			if t := graceTimer.Swap(nil); t != nil {
				t.Stop()
			}
			g.reportPath(ctx, p)
		case webrtc.PeerConnectionStateDisconnected:
			// Rede oscilou: espera um pouco e tenta reiniciar o ICE (as conexões TCP do
			// jogo sobrevivem se o caminho voltar); se não voltar, o estado vira failed.
			t := time.AfterFunc(disconnectGrace, func() {
				if pc.ConnectionState() == webrtc.PeerConnectionStateDisconnected && g.currentPeer() == p {
					g.restartICE(ctx, p)
				}
			})
			if old := graceTimer.Swap(t); old != nil {
				old.Stop()
			}
		case webrtc.PeerConnectionStateFailed:
			if g.currentPeer() == p {
				emitWarning(g.em, "connection_lost", "a conexão com o host caiu; reconectando")
				g.mu.Lock()
				up := g.hostUp
				g.mu.Unlock()
				if up && ctx.Err() == nil {
					go func() {
						sleepCtx(ctx, time.Second)
						if g.currentPeer() == p {
							g.startPeer(ctx, g.lastHostSession())
						}
					}()
				}
			}
		}
	})

	// O canal de controle abre primeiro: cria a seção SCTP e sinaliza "caminho pronto".
	ctl, err := pc.CreateDataChannel(labelCtl, nil)
	if err != nil {
		emitWarning(g.em, "peer_failed", describe(err))
		return
	}
	ctl.OnOpen(func() {
		rwc, err := ctl.Detach()
		if err != nil {
			return
		}
		p.readyOnce.Do(func() { close(p.ready) })
		go g.runCtl(ctx, p, rwc)
	})

	offer, err := pc.CreateOffer(nil)
	if err == nil {
		err = pc.SetLocalDescription(offer)
	}
	if err != nil {
		emitWarning(g.em, "peer_failed", describe(err))
		return
	}
	g.mu.Lock()
	sig := g.sig
	g.mu.Unlock()
	if sig != nil {
		_ = sig.Send(ctx, Msg{T: msgOffer, SDP: offer.SDP})
	}
}

func (g *Guest) restartICE(ctx context.Context, p *guestPeer) {
	offer, err := p.pc.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
	if err == nil {
		err = p.pc.SetLocalDescription(offer)
	}
	if err != nil {
		return
	}
	g.mu.Lock()
	sig := g.sig
	g.mu.Unlock()
	if sig != nil {
		_ = sig.Send(ctx, Msg{T: msgOffer, SDP: offer.SDP})
	}
}

// reportPath emite o tipo de caminho quando muda (e a latência, quando já medida). Se a conexão
// ficou em relay, agenda UMA tentativa de subir para um caminho direto (veja scheduleUpgrade).
func (g *Guest) reportPath(ctx context.Context, p *guestPeer) {
	path := classifyPath(p.pc)
	p.pathMu.Lock()
	changed := path != "" && path != p.lastPath
	if changed {
		p.lastPath = path
	}
	p.pathMu.Unlock()
	if !changed {
		return
	}
	emitPath(g.em, path, p.rtt.Load())
	if path == "relay" && !g.cfg.RelayOnly {
		g.scheduleUpgrade(ctx, p)
	}
}

// scheduleUpgrade: conexões que começam em relay costumam poder ser diretas pouco depois (os
// mapeamentos de NAT já estão "quentes"). Passado um tempo, reinicia o ICE uma vez; se um caminho
// direto funcionar ele passa a ser o escolhido, senão continua no relay. As conexões TCP do jogo
// sobrevivem (a associação DTLS/SCTP continua). Cada byte que sai do relay é custo a menos.
func (g *Guest) scheduleUpgrade(ctx context.Context, p *guestPeer) {
	p.pathMu.Lock()
	if p.upgrading {
		p.pathMu.Unlock()
		return
	}
	p.upgrading = true
	p.pathMu.Unlock()
	time.AfterFunc(upgradeAfter, func() {
		if ctx.Err() != nil || g.currentPeer() != p {
			return
		}
		p.pathMu.Lock()
		stillRelay := p.lastPath == "relay"
		p.pathMu.Unlock()
		if stillRelay && p.pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
			emitInfo(g.em, "tentando um caminho direto (a conexão está em relay)")
			g.restartICE(ctx, p)
		}
	})
}

// runCtl mede a latência (ping/pong) enquanto o canal de controle estiver aberto.
func (g *Guest) runCtl(ctx context.Context, p *guestPeer, rwc io.ReadWriteCloser) {
	defer rwc.Close()
	go func() {
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
			if json.Unmarshal(buf[:n], &m) == nil && m.T == "pong" {
				rtt := (time.Now().UnixNano() - m.TS) / int64(time.Millisecond)
				first := p.rtt.Swap(rtt) < 0
				if first {
					g.reportPathForce(p, rtt)
				}
			}
		}
	}()
	t := time.NewTicker(pingEvery)
	defer t.Stop()
	for {
		b, _ := json.Marshal(map[string]any{"t": "ping", "ts": time.Now().UnixNano()})
		if _, err := rwc.Write(b); err != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			g.reportPath(ctx, p) // o caminho pode ter mudado (ex.: subiu de relay para direto)
		}
	}
}

// reportPathForce reemite o caminho com a primeira latência medida.
func (g *Guest) reportPathForce(p *guestPeer, rtt int64) {
	if path := classifyPath(p.pc); path != "" {
		emitPath(g.em, path, rtt)
	}
}

// ---------------- listeners locais ----------------

func (g *Guest) acceptLoop(ctx context.Context, ln net.Listener, prefix string) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			return // listener fechado
		}
		go g.handleConn(ctx, conn, prefix)
	}
}

func (g *Guest) handleConn(ctx context.Context, conn net.Conn, prefix string) {
	label := prefix + strconv.FormatInt(g.seq.Add(1), 10)
	rwc, err := g.openChannel(ctx, label)
	if err != nil {
		_ = conn.Close()
		return
	}
	pipe(conn, rwc)
}

// openChannel espera o caminho com o host ficar pronto e abre um DataChannel.
func (g *Guest) openChannel(ctx context.Context, label string) (io.ReadWriteCloser, error) {
	deadline := time.NewTimer(waitPeerTimeout)
	defer deadline.Stop()
	var p *guestPeer
	for {
		if p = g.currentPeer(); p != nil {
			select {
			case <-p.ready:
				goto ready
			default:
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			return nil, errors.New("host indisponível")
		case <-time.After(100 * time.Millisecond):
		}
	}
ready:
	dc, err := p.pc.CreateDataChannel(label, nil)
	if err != nil {
		return nil, err
	}
	opened := make(chan io.ReadWriteCloser, 1)
	dc.OnOpen(func() {
		if rwc, err := dc.Detach(); err == nil {
			opened <- rwc
		}
	})
	select {
	case rwc := <-opened:
		return rwc, nil
	case <-time.After(openChannelTimeout):
		_ = dc.Close()
		return nil, errors.New("tempo esgotado abrindo o canal")
	case <-ctx.Done():
		_ = dc.Close()
		return nil, ctx.Err()
	}
}
