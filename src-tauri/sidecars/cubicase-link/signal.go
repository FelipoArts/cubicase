package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

// Tipos de mensagem da sinalização (ver plans/p2p-link-transport-plan.md §6.1).
// Quem não é da sala só enxerga estes campos; o "from" é sempre preenchido pela
// SALA (o convidado nunca escolhe a própria identidade).
const (
	msgHello      = "hello"       // peer → sala (1ª mensagem)
	msgOffer      = "offer"       // convidado → host (a sala acrescenta from)
	msgAnswer     = "answer"      // host → convidado (to)
	msgICE        = "ice"         // nos dois sentidos (convidado→host: from; host→convidado: to)
	msgBye        = "bye"         // despedida
	msgPeerJoined = "peer_joined" // sala → host
	msgPeerLeft   = "peer_left"   // sala → host
	msgHostOnline = "host_online" // sala → convidado
	msgHostLeft   = "host_left"   // sala → convidado
	msgError      = "error"       // sala → peer (code: ROOM_FULL, RATE_LIMITED, NOT_OWNER...)
)

const protocolVersion = 1

type Msg struct {
	T         string                   `json:"t"`
	V         int                      `json:"v,omitempty"`
	Role      string                   `json:"role,omitempty"`
	PeerID    string                   `json:"peerId,omitempty"`
	From      string                   `json:"from,omitempty"`
	To        string                   `json:"to,omitempty"`
	SDP       string                   `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
	Code      string                   `json:"code,omitempty"`
	Detail    string                   `json:"detail,omitempty"`
}

// Signal é uma conexão de sinalização já aberta. Recv é fechado quando a conexão cai.
type Signal interface {
	Send(ctx context.Context, m Msg) error
	Recv() <-chan Msg
	Close()
}

// Dialer abre (ou reabre) a conexão de sinalização.
type Dialer func(ctx context.Context) (Signal, error)

// ---------------- WebSocket ----------------

const (
	maxSignalMessage = 64 * 1024 // SDP + candidatos cabem com folga
	wsKeepalive      = 30 * time.Second
	wsWriteTimeout   = 10 * time.Second
)

type wsSignal struct {
	conn   *websocket.Conn
	recv   chan Msg
	cancel context.CancelFunc
	once   sync.Once
}

// DialWebSocket devolve um Dialer que conecta na sala de sinalização. O token vai no
// header Authorization (o sidecar não é um navegador, então pode mandar header).
func DialWebSocket(url, token string) Dialer {
	return func(ctx context.Context) (Signal, error) {
		dctx, cancelDial := context.WithTimeout(ctx, 15*time.Second)
		defer cancelDial()
		conn, _, err := websocket.Dial(dctx, url, &websocket.DialOptions{
			HTTPHeader: http.Header{"Authorization": {"Bearer " + token}},
		})
		if err != nil {
			return nil, err
		}
		conn.SetReadLimit(maxSignalMessage)
		rctx, cancel := context.WithCancel(context.Background())
		s := &wsSignal{conn: conn, recv: make(chan Msg, 64), cancel: cancel}
		go s.readLoop(rctx)
		go s.keepalive(rctx)
		return s, nil
	}
}

func (s *wsSignal) readLoop(ctx context.Context) {
	defer close(s.recv)
	for {
		typ, data, err := s.conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		if string(data) == "pong" { // resposta do keepalive (a sala responde sem acordar)
			continue
		}
		var m Msg
		if json.Unmarshal(data, &m) != nil || m.T == "" {
			continue // lixo da rede: ignora
		}
		select {
		case s.recv <- m:
		case <-ctx.Done():
			return
		}
	}
}

func (s *wsSignal) keepalive(ctx context.Context) {
	t := time.NewTicker(wsKeepalive)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			wctx, cancel := context.WithTimeout(ctx, wsWriteTimeout)
			err := s.conn.Write(wctx, websocket.MessageText, []byte("ping"))
			cancel()
			if err != nil {
				s.Close()
				return
			}
		}
	}
}

func (s *wsSignal) Send(ctx context.Context, m Msg) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if len(b) > maxSignalMessage {
		return errors.New("mensagem de sinalização grande demais")
	}
	wctx, cancel := context.WithTimeout(ctx, wsWriteTimeout)
	defer cancel()
	return s.conn.Write(wctx, websocket.MessageText, b)
}

func (s *wsSignal) Recv() <-chan Msg { return s.recv }

func (s *wsSignal) Close() {
	s.once.Do(func() {
		s.cancel()
		_ = s.conn.Close(websocket.StatusNormalClosure, "bye")
	})
}
