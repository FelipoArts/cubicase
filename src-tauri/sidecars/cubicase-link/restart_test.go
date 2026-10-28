package main

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"
)

// tryEcho faz uma troca de dados completa e devolve o erro (em vez de falhar o teste): serve para insistir
// enquanto o convidado ainda está se recuperando.
func tryEcho(guestPort, size int) error {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(guestPort), 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	payload := make([]byte, size)
	_, _ = rand.Read(payload)
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	go func() { _, _ = conn.Write(payload) }()
	got := make([]byte, size)
	if _, err := io.ReadFull(conn, got); err != nil {
		return err
	}
	if !bytes.Equal(got, payload) {
		return fmt.Errorf("os bytes do eco não batem com o enviado")
	}
	return nil
}

// Vários convidados ligados quando o host cai e volta (processo novo): TODOS precisam voltar a trocar dados, não só
// o primeiro. Reproduz o que o teste de campo (scripts/e2e-link.mjs) viu: um convidado em cada rodada ficava preso.
func TestHostReiniciaComVariosConvidados_TodosRecuperam(t *testing.T) {
	const n = 8
	hub := newHub()
	hostEm := &capEmitter{}
	mc := startEcho(t)
	hcfg := testConfig(t, modeHost, mc)
	_, hostRun := startHost(t, hcfg, hostEm, hub)
	hostEm.wait(t, "host online", 5*time.Second, has("status", "online"))

	ports := make([]int, n)
	ems := make([]*capEmitter, n)
	for i := 0; i < n; i++ {
		gcfg, gamePort, _ := guestConfig(t)
		ems[i] = &capEmitter{}
		startGuest(t, gcfg, ems[i], hub)
		ports[i] = gamePort
	}
	for i := 0; i < n; i++ {
		echoThrough(t, ports[i], 64*1024)
	}

	if err := hostRun.stop(); err != nil {
		t.Fatalf("host deveria parar limpo: %v", err)
	}
	time.Sleep(2 * time.Second)
	hcfg.PeerID = "sess-host-2"
	startHost(t, hcfg, &capEmitter{}, hub)

	var wg sync.WaitGroup
	failed := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			deadline := time.Now().Add(60 * time.Second)
			for time.Now().Before(deadline) {
				if failed[i] = tryEcho(ports[i], 32*1024); failed[i] == nil {
					return
				}
				time.Sleep(2 * time.Second)
			}
		}(i)
	}
	wg.Wait()
	for i, err := range failed {
		if err != nil {
			t.Errorf("convidado %d nunca se recuperou depois que o host voltou: %v (eventos: %v)", i+1, err, snapshot(ems[i]))
		}
	}
}

func snapshot(c *capEmitter) []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]map[string]any(nil), c.evs...)
}

// A resposta do host a uma oferta se perde no caminho (a sala de sinalização descartou a mensagem): o convidado não
// pode ficar esperando para sempre; recomeça a negociação e conecta.
func TestRespostaPerdida_ConvidadoRecomecaEConecta(t *testing.T) {
	old := answerTimeout
	answerTimeout = 1500 * time.Millisecond
	t.Cleanup(func() { answerTimeout = old })

	hub := newHub()
	hub.dropAnswers = 1 // a primeira resposta do host some
	hostEm, guestEm := &capEmitter{}, &capEmitter{}
	mc := startEcho(t)
	startHost(t, testConfig(t, modeHost, mc), hostEm, hub)
	hostEm.wait(t, "host online", 5*time.Second, has("status", "online"))

	gcfg, gamePort, _ := guestConfig(t)
	startGuest(t, gcfg, guestEm, hub)
	echoThrough(t, gamePort, 64*1024)
	guestEm.wait(t, "nova tentativa", 5*time.Second, has("info", "o host não respondeu à negociação; tentando de novo"))
}
