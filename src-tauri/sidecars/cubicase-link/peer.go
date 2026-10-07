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
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))

	rc := webrtc.Configuration{}
	if len(cfg.ICE.STUNURLs) > 0 {
		rc.ICEServers = append(rc.ICEServers, webrtc.ICEServer{URLs: cfg.ICE.STUNURLs})
	}
	if t := cfg.ICE.TURN; t != nil {
		rc.ICEServers = append(rc.ICEServers, webrtc.ICEServer{URLs: t.URLs, Username: t.Username, Credential: t.Credential})
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
