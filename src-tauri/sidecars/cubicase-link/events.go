package main

import (
	"encoding/json"
	"io"
	"sync"
)

// Emitter escreve eventos estruturados (uma linha JSON por evento) na saída que o app
// escuta. Formato compatível com o tsnet-node:
//
//	{"status":"online","ip":"p2p"}      rede pronta
//	{"info":"..."}                      informativo
//	{"warning":"host_unreachable",...}  degradado (não fatal)
//	{"recovered":"host_unreachable"}    voltou
//	{"error":"<código>","detail":"..."} fatal (o processo sai em seguida)
//	{"path":"direct-v6","rttMs":12}     tipo de caminho e latência
type Emitter interface {
	Emit(event map[string]any)
}

type streamEmitter struct {
	mu sync.Mutex
	w  io.Writer
}

func newStreamEmitter(w io.Writer) *streamEmitter { return &streamEmitter{w: w} }

func (s *streamEmitter) Emit(event map[string]any) {
	b, err := json.Marshal(event)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.w.Write(append(b, '\n'))
}

func emitStatusOnline(e Emitter)        { e.Emit(map[string]any{"status": "online", "ip": "p2p"}) }
func emitInfo(e Emitter, msg string)    { e.Emit(map[string]any{"info": msg}) }
func emitRecovered(e Emitter, c string) { e.Emit(map[string]any{"recovered": c}) }
func emitWarning(e Emitter, code, detail string) {
	e.Emit(map[string]any{"warning": code, "detail": detail})
}
func emitError(e Emitter, code, detail string) {
	e.Emit(map[string]any{"error": code, "detail": detail})
}
func emitPath(e Emitter, path string, rttMs int64) {
	ev := map[string]any{"path": path}
	if rttMs >= 0 {
		ev["rttMs"] = rttMs
	}
	e.Emit(ev)
}
