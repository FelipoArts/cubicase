package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
)

// Config é o que o app (Rust) entrega ao sidecar — por arquivo (--config) ou pela
// primeira linha do stdin (--stdin). Mesmo contrato do tsnet-node: o sidecar morre
// quando o stdin do pai fecha.
type Config struct {
	// Mode: "host" (hospeda: recebe convidados e encaminha para o Minecraft local) ou
	// "guest" (entra: escuta em localhost e leva o tráfego ao host).
	Mode string `json:"mode"`
	// PeerID identifica esta sessão (a ConnectionSession da API).
	PeerID string `json:"peerId"`
	// SignalURL: WebSocket da sala de sinalização do servidor (wss://...). SignalToken
	// autentica esta sessão na sala (header Authorization: Bearer).
	SignalURL   string    `json:"signalUrl"`
	SignalToken string    `json:"signalToken"`
	ICE         ICEConfig `json:"ice"`
	// RelayOnly força o uso do relay (modo privado, benefício do Plus).
	RelayOnly bool `json:"relayOnly"`
	// LocalPort: no host, a porta do servidor Minecraft local; no convidado, a porta
	// local em 127.0.0.1 onde o Minecraft deve conectar.
	LocalPort int `json:"localPort"`
	// ModsPort (convidado): porta local do proxy HTTP de sincronização de mods.
	ModsPort int `json:"modsPort"`
	// RegistryPort (host): porta do servidor HTTP local do app (lista/arquivos de mods).
	RegistryPort int `json:"registryPort"`
	// MaxGuests (host): limite de convidados simultâneos.
	MaxGuests int `json:"maxGuests"`
	// LoopbackCandidates inclui endereços 127.0.0.1 nos candidatos ICE. Só para testes.
	LoopbackCandidates bool `json:"loopbackCandidates,omitempty"`
}

type ICEConfig struct {
	STUNURLs []string    `json:"stunUrls"`
	TURN     *TURNConfig `json:"turn,omitempty"`
}

type TURNConfig struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

const (
	modeHost  = "host"
	modeGuest = "guest"

	defaultMaxGuests    = 20
	defaultModsPort     = 25568
	defaultRegistryPort = 25567
)

// codedError carrega o código estruturado que o app traduz para o usuário.
type codedError struct {
	Code string
	Err  error
}

func (e *codedError) Error() string {
	if e.Err == nil {
		return e.Code
	}
	return e.Code + ": " + e.Err.Error()
}
func (e *codedError) Unwrap() error { return e.Err }

func coded(code string, err error) error { return &codedError{Code: code, Err: err} }

// ParseConfig lê e valida a configuração, aplicando os padrões.
func ParseConfig(r io.Reader) (Config, error) {
	var cfg Config
	dec := json.NewDecoder(io.LimitReader(r, 1<<20))
	if err := dec.Decode(&cfg); err != nil {
		return cfg, coded("config_decode_failed", err)
	}
	if err := cfg.normalize(); err != nil {
		return cfg, coded("config_decode_failed", err)
	}
	return cfg, nil
}

func validPort(p int) bool { return p >= 1 && p <= 65535 }

func (c *Config) normalize() error {
	c.Mode = strings.ToLower(strings.TrimSpace(c.Mode))
	if c.Mode != modeHost && c.Mode != modeGuest {
		return fmt.Errorf("mode precisa ser %q ou %q", modeHost, modeGuest)
	}
	if strings.TrimSpace(c.PeerID) == "" {
		return errors.New("peerId obrigatório")
	}
	u, err := url.Parse(c.SignalURL)
	if err != nil || (u.Scheme != "wss" && u.Scheme != "ws") || u.Host == "" {
		return errors.New("signalUrl precisa ser uma URL ws:// ou wss://")
	}
	if !validPort(c.LocalPort) {
		return errors.New("localPort inválida")
	}
	if c.MaxGuests <= 0 {
		c.MaxGuests = defaultMaxGuests
	}
	if c.ModsPort == 0 {
		c.ModsPort = defaultModsPort
	}
	if c.RegistryPort == 0 {
		c.RegistryPort = defaultRegistryPort
	}
	if !validPort(c.ModsPort) || !validPort(c.RegistryPort) {
		return errors.New("modsPort/registryPort inválida")
	}
	for _, s := range c.ICE.STUNURLs {
		if !strings.HasPrefix(s, "stun:") && !strings.HasPrefix(s, "stuns:") {
			return fmt.Errorf("URL STUN inválida: %q", s)
		}
	}
	if t := c.ICE.TURN; t != nil {
		if len(t.URLs) == 0 {
			return errors.New("turn.urls vazio")
		}
		for _, s := range t.URLs {
			if !strings.HasPrefix(s, "turn:") && !strings.HasPrefix(s, "turns:") {
				return fmt.Errorf("URL TURN inválida: %q", s)
			}
		}
	}
	if c.RelayOnly && c.ICE.TURN == nil {
		return errors.New("relayOnly exige um servidor TURN")
	}
	return nil
}
