package main

import (
	"testing"
	"time"
)

// O pré-aquecimento só abre portas e volta quando o tempo acaba — não pode travar nem entrar em pânico.
func TestPrewarmFirewallVoltaNoTempo(t *testing.T) {
	start := time.Now()
	prewarmFirewall(150 * time.Millisecond)
	if d := time.Since(start); d < 150*time.Millisecond || d > 3*time.Second {
		t.Fatalf("durou %v, esperava ~150ms", d)
	}
}
