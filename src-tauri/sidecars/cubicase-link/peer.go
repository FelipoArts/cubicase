package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	labelCtl  = "ctl"
	labelGame = "game#"
	labelHTTP = "http#"

	// Limites por convidado no host (ver plano §6.2).
	maxGameChannels = 16
	maxHTTPChannels = 4
)

// newPeerConnection monta uma PeerConnection com os servidores ICE da configuração.
// Canais são "detached" (viram io.ReadWriteCloser) para a ponte TCP usar io.Copy.
func newPeerConnection(cfg Config) (*webrtc.PeerConnection, error) {
	se := webrtc.SettingEngine{}
	se.DetachDataChannels()
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6})
	// disconnected após 5 s sem tráfego, failed após 20 s, keepalive a cada 2 s.
	se.SetICETimeouts(5*time.Second, 20*time.Second, 2*time.Second)
	if cfg.LoopbackCandidates {
		se.SetIncludeLoopbackCandidate(true)
	}
	// Quanto o ICE espera antes de ACEITAR cada tipo de caminho. Os padrões da biblioteca (relay 2 s,
	// NAT 0,5–1 s) fazem o relay — que fica pronto na hora — ganhar do furo de NAT quando este
	// leva um pouco mais (medido em rede real: 1ª conexão em relay, 2ª direta). Dar mais fôlego ao
	// caminho direto custa só alguns segundos a quem de fato precisa do relay, e cada conexão
	// direta é banda que não passa pelo relay. Com relay forçado não há o que esperar.
	se.SetHostAcceptanceMinWait(0)
	se.SetSrflxAcceptanceMinWait(1500 * time.Millisecond)
	se.SetPrflxAcceptanceMinWait(3 * time.Second)
	if !cfg.RelayOnly {
		se.SetRelayAcceptanceMinWait(6 * time.Second)
	}
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))

	rc := webrtc.Configuration{}
	if len(cfg.ICE.STUNURLs) > 0 {
		rc.ICEServers = append(rc.ICEServers, webrtc.ICEServer{URLs: cfg.ICE.STUNURLs})
	}
	if t := cfg.ICE.TURN; t != nil {
		// Uma URL só: cada URL abriria uma alocação no relay (ver turnselect.go).
		if urls := selectTURNURLs(t.URLs, probeTURNUDP); len(urls) > 0 {
			rc.ICEServers = append(rc.ICEServers, webrtc.ICEServer{URLs: urls, Username: t.Username, Credential: t.Credential})
		}
	}
	if cfg.RelayOnly {
		rc.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	return api.NewPeerConnection(rc)
}

// classifyPath resume o caminho ICE escolhido em um rótulo estável para a UI e a telemetria:
// direct-v6, direct-v4, punched (furo de NAT via STUN), relay.
func classifyPath(pc *webrtc.PeerConnection) string {
	sctp := pc.SCTP()
	if sctp == nil {
		return ""
	}
	pair, err := sctp.Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil || pair.Remote == nil {
		return ""
	}
	return pathLabel(pair.Local.Typ, pair.Remote.Typ, pair.Local.Address, pair.Remote.Address)
}

func pathLabel(localTyp, remoteTyp webrtc.ICECandidateType, localAddr, remoteAddr string) string {
	if localTyp == webrtc.ICECandidateTypeRelay || remoteTyp == webrtc.ICECandidateTypeRelay {
		return "relay"
	}
	if localTyp == webrtc.ICECandidateTypeHost && remoteTyp == webrtc.ICECandidateTypeHost {
		if strings.Contains(localAddr, ":") || strings.Contains(remoteAddr, ":") {
			return "direct-v6"
		}
		return "direct-v4"
	}
	return "punched"
}

// channelKind identifica o tipo de DataChannel pelo rótulo.
func channelKind(label string) string {
	switch {
	case label == labelCtl:
		return labelCtl
	case strings.HasPrefix(label, labelGame):
		return labelGame
	case strings.HasPrefix(label, labelHTTP):
		return labelHTTP
	}
	return ""
}

func describe(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprint(err)
}
