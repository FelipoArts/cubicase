// Spike da Fase 0 (plans/p2p-link-transport-plan.md): valida o transporte
// WebRTC (ICE + DTLS + SCTP) com pion antes de construir o sidecar de verdade.
//
//	go run . loopback            testes locais (vazão, latência, canais, ponte TCP)
//	go run . host   [flags]      lado do host (sinalização manual por copiar/colar)
//	go run . guest  [flags]      lado do convidado
//
// Flags de rede (host/guest): -stun, -turn url,user,pass, -relay (só relay), -mb (tamanho do teste).
package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

const chunk = 16 * 1024

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "erro:", err)
		os.Exit(1)
	}
}

type netOpts struct {
	stun      string
	turn      string
	relayOnly bool
	loopback  bool
}

func newPC(o netOpts) *webrtc.PeerConnection {
	se := webrtc.SettingEngine{}
	se.DetachDataChannels()
	if o.loopback {
		se.SetIncludeLoopbackCandidate(true)
	}
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
	cfg := webrtc.Configuration{}
	if o.stun != "" {
		cfg.ICEServers = append(cfg.ICEServers, webrtc.ICEServer{URLs: strings.Split(o.stun, ",")})
	}
	if o.turn != "" {
		parts := strings.SplitN(o.turn, ",", 3)
		if len(parts) == 3 {
			cfg.ICEServers = append(cfg.ICEServers, webrtc.ICEServer{URLs: []string{parts[0]}, Username: parts[1], Credential: parts[2]})
		}
	}
	if o.relayOnly {
		cfg.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	pc, err := api.NewPeerConnection(cfg)
	must(err)
	return pc
}

// pathOf devolve o tipo do caminho ICE escolhido (host/srflx/prflx/relay).
func pathOf(pc *webrtc.PeerConnection) string {
	sctp := pc.SCTP()
	if sctp == nil {
		return "?"
	}
	pair, err := sctp.Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil {
		return "?"
	}
	return fmt.Sprintf("local=%s(%s) remote=%s(%s)", pair.Local.Typ, pair.Local.Address, pair.Remote.Typ, pair.Remote.Address)
}

// offerBlob/answerBlob: SDP sem trickle (espera a coleta de candidatos), em base64 de uma linha.
func encode(sd *webrtc.SessionDescription) string {
	b, _ := json.Marshal(sd)
	return base64.StdEncoding.EncodeToString(b)
}

func decode(s string) webrtc.SessionDescription {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	must(err)
	var sd webrtc.SessionDescription
	must(json.Unmarshal(raw, &sd))
	return sd
}

func localDesc(pc *webrtc.PeerConnection) *webrtc.SessionDescription {
	<-webrtc.GatheringCompletePromise(pc)
	return pc.LocalDescription()
}

// ---------- testes sobre um par de DataChannels já abertos ----------

type result struct {
	name string
	val  string
}

func report(rs []result) {
	fmt.Println("\n=== RESULTADOS ===")
	for _, r := range rs {
		fmt.Printf("%-34s %s\n", r.name, r.val)
	}
}

// throughput: quem chama escreve `mb` MiB em w; quem recebe lê até EOF-marker. Devolve MB/s.
func sendBulk(w io.Writer, mb int) {
	buf := bytes.Repeat([]byte{0xAB}, chunk)
	total := mb * 1024 * 1024
	for sent := 0; sent < total; sent += chunk {
		_, err := w.Write(buf)
		must(err)
	}
}

func recvBulk(r io.Reader, mb int) time.Duration {
	total := mb * 1024 * 1024
	buf := make([]byte, 64*1024)
	got := 0
	start := time.Now()
	for got < total {
		n, err := r.Read(buf)
		must(err)
		got += n
	}
	return time.Since(start)
}

func mbps(mb int, d time.Duration) string {
	sec := d.Seconds()
	return fmt.Sprintf("%.1f MB/s (%.0f Mbps) em %.2fs", float64(mb)/sec, float64(mb)*8/sec, sec)
}

// latency: ping-pong de 64 bytes N vezes; echo do outro lado.
func pingPong(rw io.ReadWriter, n int) (p50, p99 time.Duration) {
	msg := make([]byte, 64)
	buf := make([]byte, 64)
	var ds []time.Duration
	for i := 0; i < n; i++ {
		t := time.Now()
		_, err := rw.Write(msg)
		must(err)
		_, err = io.ReadFull(rw, buf)
		must(err)
		ds = append(ds, time.Since(t))
	}
	sort.Slice(ds, func(i, j int) bool { return ds[i] < ds[j] })
	return ds[len(ds)/2], ds[len(ds)*99/100]
}

// ---------- modo loopback: dois peers no mesmo processo ----------

func openPair(o netOpts, labels []string) (hostPC, guestPC *webrtc.PeerConnection, hostDCs, guestDCs map[string]io.ReadWriteCloser) {
	hostPC, guestPC = newPC(o), newPC(o)
	hostDCs = map[string]io.ReadWriteCloser{}
	guestDCs = map[string]io.ReadWriteCloser{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	wg.Add(2 * len(labels))

	hostPC.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnOpen(func() {
			rwc, err := dc.Detach()
			must(err)
			mu.Lock()
			hostDCs[dc.Label()] = rwc
			mu.Unlock()
			wg.Done()
		})
	})
	for _, l := range labels {
		dc, err := guestPC.CreateDataChannel(l, nil)
		must(err)
		dc.OnOpen(func() {
			rwc, err := dc.Detach()
			must(err)
			mu.Lock()
			guestDCs[dc.Label()] = rwc
			mu.Unlock()
			wg.Done()
		})
	}
	offer, err := guestPC.CreateOffer(nil)
	must(err)
	must(guestPC.SetLocalDescription(offer))
	od := localDesc(guestPC)
	must(hostPC.SetRemoteDescription(*od))
	answer, err := hostPC.CreateAnswer(nil)
	must(err)
	must(hostPC.SetLocalDescription(answer))
	ad := localDesc(hostPC)
	must(guestPC.SetRemoteDescription(*ad))
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		must(fmt.Errorf("timeout abrindo DataChannels (caminho ICE não conectou)"))
	}
	return
}

func runLoopback(mb int) {
	var rs []result
	t0 := time.Now()
	h, g, hd, gd := openPair(netOpts{loopback: true}, []string{"bulk", "echo"})
	rs = append(rs, result{"tempo para conectar", time.Since(t0).Round(time.Millisecond).String()})
	rs = append(rs, result{"caminho ICE", pathOf(g)})

	// 1) vazão convidado→host e host→convidado (o jogo é host→convidado na maior parte do tempo)
	go sendBulk(gd["bulk"], mb)
	rs = append(rs, result{"vazão convidado→host", mbps(mb, recvBulk(hd["bulk"], mb))})
	go sendBulk(hd["bulk"], mb)
	rs = append(rs, result{"vazão host→convidado", mbps(mb, recvBulk(gd["bulk"], mb))})

	// 2) latência (eco no host)
	go func() { _, _ = io.Copy(hd["echo"], hd["echo"]) }()
	p50, p99 := pingPong(gd["echo"], 300)
	rs = append(rs, result{"latência ida-e-volta p50/p99", fmt.Sprintf("%v / %v", p50.Round(time.Microsecond), p99.Round(time.Microsecond))})
	_ = h.Close()
	_ = g.Close()

	// 3) muitos canais simultâneos (jogo + mods) — 40 canais x 2 MiB
	rs = append(rs, manyChannels(40, 2))

	// 4) ponte TCP real: cada conexão TCP vira um DataChannel (o padrão do sidecar)
	rs = append(rs, tcpBridge(10)...)

	report(rs)
}

func manyChannels(n, mb int) result {
	labels := make([]string, n)
	for i := range labels {
		labels[i] = fmt.Sprintf("c%d", i)
	}
	h, g, hd, gd := openPair(netOpts{loopback: true}, labels)
	defer h.Close()
	defer g.Close()
	start := time.Now()
	var wg sync.WaitGroup
	for _, l := range labels {
		l := l
		wg.Add(2)
		go func() { defer wg.Done(); sendBulk(gd[l], mb) }()
		go func() { defer wg.Done(); recvBulk(hd[l], mb) }()
	}
	wg.Wait()
	d := time.Since(start)
	return result{fmt.Sprintf("%d canais simultâneos x %d MiB", n, mb), mbps(n*mb, d) + " agregado"}
}

// tcpBridge: cliente TCP → [sidecar convidado] → DataChannel → [sidecar host] → servidor TCP (eco).
func tcpBridge(mb int) []result {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()

	hostPC, guestPC := newPC(netOpts{loopback: true}), newPC(netOpts{loopback: true})
	defer hostPC.Close()
	defer guestPC.Close()
	// host: cada DataChannel aberto pelo convidado → conexão TCP ao servidor de eco
	hostPC.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnOpen(func() {
			rwc, err := dc.Detach()
			must(err)
			conn, err := net.Dial("tcp", echo.Addr().String())
			must(err)
			go func() { _, _ = io.Copy(conn, rwc); conn.Close() }()
			go func() { _, _ = io.Copy(rwc, conn); rwc.Close() }()
		})
	})
	// convidado: ouve TCP local; cada conexão cria um DataChannel
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	defer ln.Close()
	ready := make(chan struct{})
	ctrl, err := guestPC.CreateDataChannel("ctl", nil)
	must(err)
	ctrl.OnOpen(func() { close(ready) })
	offer, _ := guestPC.CreateOffer(nil)
	must(guestPC.SetLocalDescription(offer))
	must(hostPC.SetRemoteDescription(*localDesc(guestPC)))
	ans, _ := hostPC.CreateAnswer(nil)
	must(hostPC.SetLocalDescription(ans))
	must(guestPC.SetRemoteDescription(*localDesc(hostPC)))
	<-ready
	var seq int64
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				dc, err := guestPC.CreateDataChannel(fmt.Sprintf("game#%d", atomic.AddInt64(&seq, 1)), nil)
				must(err)
				dc.OnOpen(func() {
					rwc, err := dc.Detach()
					must(err)
					go func() { _, _ = io.Copy(rwc, c); rwc.Close() }()
					go func() { _, _ = io.Copy(c, rwc); c.Close() }()
				})
			}()
		}
	}()

	// 3 conexões TCP simultâneas atravessando a ponte; cada uma envia mb MiB e confere o eco
	start := time.Now()
	var wg sync.WaitGroup
	okAll := int32(1)
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := net.Dial("tcp", ln.Addr().String())
			must(err)
			defer c.Close()
			go func() {
				w := bufio.NewWriter(c)
				buf := bytes.Repeat([]byte{0x5A}, chunk)
				for sent := 0; sent < mb*1024*1024; sent += chunk {
					_, _ = w.Write(buf)
				}
				_ = w.Flush()
			}()
			got := 0
			buf := make([]byte, 64*1024)
			for got < mb*1024*1024 {
				n, err := c.Read(buf)
				if err != nil {
					atomic.StoreInt32(&okAll, 0)
					return
				}
				got += n
			}
		}()
	}
	wg.Wait()
	d := time.Since(start)
	status := "OK (todos os bytes de volta)"
	if okAll == 0 {
		status = "FALHOU"
	}
	return []result{
		{"ponte TCP (3 conexões x ida e volta)", mbps(3*mb*2, d) + " agregado"},
		{"ponte TCP integridade", status},
	}
}

// ---------- modos host/guest com sinalização manual ----------

func readLine(prompt string) string {
	fmt.Fprint(os.Stderr, prompt)
	r := bufio.NewReaderSize(os.Stdin, 1<<20)
	line, err := r.ReadString('\n')
	if err != nil && line == "" {
		must(err)
	}
	return strings.TrimSpace(line)
}

func runRemote(role string, o netOpts, mb int) {
	pc := newPC(o)
	opened := make(chan io.ReadWriteCloser, 2)
	if role == "guest" {
		for _, l := range []string{"bulk", "echo"} {
			dc, err := pc.CreateDataChannel(l, nil)
			must(err)
			dc.OnOpen(func() { rwc, err := dc.Detach(); must(err); opened <- rwc })
		}
		offer, _ := pc.CreateOffer(nil)
		must(pc.SetLocalDescription(offer))
		fmt.Fprintln(os.Stderr, "\n>>> Copie a linha abaixo e cole no HOST:")
		fmt.Println(encode(localDesc(pc)))
		must(pc.SetRemoteDescription(decode(readLine("\n<<< Cole aqui a RESPOSTA do host e dê Enter: "))))
	} else {
		pc.OnDataChannel(func(dc *webrtc.DataChannel) {
			dc.OnOpen(func() { rwc, err := dc.Detach(); must(err); opened <- &labeled{rwc, dc.Label()} })
		})
		must(pc.SetRemoteDescription(decode(readLine("<<< Cole aqui a OFERTA do convidado e dê Enter: "))))
		ans, _ := pc.CreateAnswer(nil)
		must(pc.SetLocalDescription(ans))
		fmt.Fprintln(os.Stderr, "\n>>> Copie a linha abaixo e cole no CONVIDADO:")
		fmt.Println(encode(localDesc(pc)))
	}
	t0 := time.Now()
	chans := map[string]io.ReadWriteCloser{}
	for len(chans) < 2 {
		select {
		case c := <-opened:
			if role == "guest" {
				// guest não sabe o rótulo de cada um; ordem de abertura é bulk, echo na prática
				if _, ok := chans["bulk"]; !ok {
					chans["bulk"] = c
				} else {
					chans["echo"] = c
				}
			} else {
				l := c.(*labeled)
				chans[l.label] = l.ReadWriteCloser
			}
		case <-time.After(30 * time.Second):
			must(fmt.Errorf("timeout: o caminho ICE não conectou em 30 s (firewall/NAT simétrico? tente -turn)"))
		}
	}
	fmt.Fprintf(os.Stderr, "conectado em %v — caminho: %s\n", time.Since(t0).Round(time.Millisecond), pathOf(pc))

	var rs []result
	rs = append(rs, result{"caminho ICE", pathOf(pc)})
	if role == "guest" {
		sendBulk(chans["bulk"], mb) // guest→host
		b := make([]byte, 1)
		_, _ = io.ReadFull(chans["bulk"], b) // espera o host terminar de receber
		d := recvBulk(chans["bulk"], mb)      // host→guest
		rs = append(rs, result{"vazão host→convidado", mbps(mb, d)})
		p50, p99 := pingPong(chans["echo"], 300)
		rs = append(rs, result{"latência ida-e-volta p50/p99", fmt.Sprintf("%v / %v", p50.Round(100*time.Microsecond), p99.Round(100*time.Microsecond))})
	} else {
		d := recvBulk(chans["bulk"], mb)
		rs = append(rs, result{"vazão convidado→host", mbps(mb, d)})
		_, _ = chans["bulk"].Write([]byte{1})
		sendBulk(chans["bulk"], mb)
		_, _ = io.Copy(chans["echo"], chans["echo"])
	}
	report(rs)
	time.Sleep(2 * time.Second)
}

type labeled struct {
	io.ReadWriteCloser
	label string
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("uso: link-spike loopback | host | guest [-stun url] [-turn url,user,pass] [-relay] [-mb N]")
		os.Exit(2)
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	o := netOpts{}
	mb := fs.Int("mb", 100, "MiB por teste de vazão")
	fs.StringVar(&o.stun, "stun", "stun:stun.l.google.com:19302", "URLs STUN separadas por vírgula (vazio = nenhum)")
	fs.StringVar(&o.turn, "turn", "", "url,usuario,senha do TURN")
	fs.BoolVar(&o.relayOnly, "relay", false, "forçar uso do relay")
	_ = fs.Parse(os.Args[2:])
	switch os.Args[1] {
	case "loopback":
		runLoopback(*mb)
	case "host", "guest":
		runRemote(os.Args[1], o, *mb)
	default:
		fmt.Println("modo desconhecido:", os.Args[1])
		os.Exit(2)
	}
}
