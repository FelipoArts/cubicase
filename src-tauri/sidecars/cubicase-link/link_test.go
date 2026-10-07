package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

// echoThrough abre uma conexão TCP no convidado e confere que `size` bytes aleatórios
// voltam idênticos (passando convidado → DataChannel → host → "Minecraft" falso e de volta).
func echoThrough(t *testing.T, guestPort, size int) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(guestPort), 5*time.Second)
	if err != nil {
		t.Fatalf("conectar no convidado: %v", err)
	}
	defer conn.Close()
	payload := make([]byte, size)
	_, _ = rand.Read(payload)
	_ = conn.SetDeadline(time.Now().Add(40 * time.Second))
	go func() { _, _ = conn.Write(payload) }()
	got := make([]byte, size)
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("ler eco: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("os bytes do eco não batem com o enviado")
	}
}

func TestEndToEnd_JogoEModsPeloMesmoCaminho(t *testing.T) {
	hub := newHub()
	hostEm, guestEm := &capEmitter{}, &capEmitter{}
	mc := startEcho(t)
	registry := startRegistry(t, "lista-de-mods")

	hcfg := testConfig(t, modeHost, mc)
	hcfg.RegistryPort = registry
	startHost(t, hcfg, hostEm, hub)
	hostEm.wait(t, "host online", 5*time.Second, has("status", "online"))

	gcfg, gamePort, modsPort := guestConfig(t)
	startGuest(t, gcfg, guestEm, hub)
	guestEm.wait(t, "convidado online", 5*time.Second, has("status", "online"))

	// Minecraft: 2 MiB de ida e volta.
	echoThrough(t, gamePort, 2*1024*1024)
	// Sincronização de mods: HTTP do app do host, via canal http#.
	if got := httpGet(t, modsPort, "/mods?code=ABC"); got != "lista-de-mods path=/mods" {
		t.Fatalf("resposta HTTP inesperada: %q", got)
	}

	ev := guestEm.wait(t, "tipo de caminho", 10*time.Second, has("path", ""))
	if p := ev["path"]; p != "direct-v4" && p != "direct-v6" {
		t.Fatalf("em loopback o caminho deveria ser direto, veio %v", p)
	}
}

func TestVariosConvidadosAoMesmoTempo(t *testing.T) {
	hub := newHub()
	hostEm := &capEmitter{}
	mc := startEcho(t)
	h, _ := startHost(t, testConfig(t, modeHost, mc), hostEm, hub)
	hostEm.wait(t, "host online", 5*time.Second, has("status", "online"))

	const n = 3
	ports := make([]int, n)
	for i := 0; i < n; i++ {
		gcfg, gamePort, _ := guestConfig(t)
		startGuest(t, gcfg, &capEmitter{}, hub)
		ports[i] = gamePort
	}
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(p int) { defer wg.Done(); echoThrough(t, p, 512*1024) }(ports[i])
	}
	wg.Wait()
	if got := h.GuestCount(); got != n {
		t.Fatalf("o host deveria ter %d convidados, tem %d", n, got)
	}
}

func TestVariasConexoesDoMesmoConvidado(t *testing.T) {
	hub := newHub()
	hostEm := &capEmitter{}
	mc := startEcho(t)
	startHost(t, testConfig(t, modeHost, mc), hostEm, hub)
	hostEm.wait(t, "host online", 5*time.Second, has("status", "online"))
	gcfg, gamePort, _ := guestConfig(t)
	startGuest(t, gcfg, &capEmitter{}, hub)

	var wg sync.WaitGroup
	for i := 0; i < 6; i++ { // o Minecraft abre mais de uma conexão (ping da lista + jogo)
		wg.Add(1)
		go func() { defer wg.Done(); echoThrough(t, gamePort, 256*1024) }()
	}
	wg.Wait()
}

func TestHostCheio_RejeitaOExcedenteComSalaCheia(t *testing.T) {
	hub := newHub()
	hostEm := &capEmitter{}
	mc := startEcho(t)
	hcfg := testConfig(t, modeHost, mc)
	hcfg.MaxGuests = 1
	startHost(t, hcfg, hostEm, hub)
	hostEm.wait(t, "host online", 5*time.Second, has("status", "online"))

	g1cfg, port1, _ := guestConfig(t)
	startGuest(t, g1cfg, &capEmitter{}, hub)
	echoThrough(t, port1, 1024) // 1º convidado entrou de fato

	g2cfg, _, _ := guestConfig(t)
	g2, r2 := startGuest(t, g2cfg, &capEmitter{}, hub)
	_ = g2
	select {
	case err := <-r2.done:
		var ce *codedError
		if !errors.As(err, &ce) || ce.Code != "room_full" {
			t.Fatalf("esperava erro room_full, veio %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("o 2º convidado deveria ser recusado (limite de convidados)")
	}
}

func TestHostSaiEVolta_ConvidadoAvisaERecupera(t *testing.T) {
	hub := newHub()
	hostEm, guestEm := &capEmitter{}, &capEmitter{}
	mc := startEcho(t)
	hcfg := testConfig(t, modeHost, mc)
	_, hostRun := startHost(t, hcfg, hostEm, hub)
	hostEm.wait(t, "host online", 5*time.Second, has("status", "online"))

	gcfg, gamePort, _ := guestConfig(t)
	startGuest(t, gcfg, guestEm, hub)
	echoThrough(t, gamePort, 4096)

	if err := hostRun.stop(); err != nil {
		t.Fatalf("host deveria parar limpo: %v", err)
	}
	guestEm.wait(t, "host_unreachable", 10*time.Second, has("warning", "host_unreachable"))

	// O host volta (processo novo = sessão nova): o convidado se recupera sozinho.
	hcfg.PeerID = "sess-host-2"
	startHost(t, hcfg, &capEmitter{}, hub)
	guestEm.wait(t, "recuperado", 15*time.Second, has("recovered", "host_unreachable"))
	echoThrough(t, gamePort, 64*1024)
}

func TestSinalizacaoCai_ConexaoAtivaSobreviveENovosConvidadosEntram(t *testing.T) {
	hub := newHub()
	hostEm := &capEmitter{}
	mc := startEcho(t)
	startHost(t, testConfig(t, modeHost, mc), hostEm, hub)
	hostEm.wait(t, "host online", 5*time.Second, has("status", "online"))

	g1cfg, port1, _ := guestConfig(t)
	startGuest(t, g1cfg, &capEmitter{}, hub)
	echoThrough(t, port1, 4096)

	// Um jogador já conectado continua jogando mesmo com a sinalização fora.
	conn, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(port1))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	_, _ = conn.Write([]byte("antes"))
	buf := make([]byte, 5)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}

	hub.killHost() // WebSocket do host caiu; o host reconecta sozinho (backoff de 1 s)
	hostEm.wait(t, "aviso de sinalização perdida", 5*time.Second, has("warning", "signal_lost"))
	hostEm.wait(t, "sinalização recuperada", 10*time.Second, has("recovered", "signal_lost"))

	_, _ = conn.Write([]byte("depois"))
	buf = make([]byte, 6)
	if _, err := io.ReadFull(conn, buf); err != nil || string(buf) != "depois" {
		t.Fatalf("a conexão ativa deveria seguir funcionando: %q %v", buf, err)
	}

	// E um convidado NOVO consegue entrar depois da reconexão.
	g2cfg, port2, _ := guestConfig(t)
	startGuest(t, g2cfg, &capEmitter{}, hub)
	echoThrough(t, port2, 8192)
}

func TestConvidado_PortaLocalOcupadaEhErroFatalComCodigo(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	cfg := testConfig(t, modeGuest, ln.Addr().(*net.TCPAddr).Port)
	g := NewGuest(cfg, &capEmitter{}, newHub().Dialer(modeGuest))
	err = g.Run(context.Background())
	var ce *codedError
	if !errors.As(err, &ce) || ce.Code != "listen_local_failed" {
		t.Fatalf("esperava listen_local_failed, veio %v", err)
	}
}

func TestConvidado_SalaSemHostEmiteAvisoENaoTrava(t *testing.T) {
	hub := newHub()
	em := &capEmitter{}
	gcfg, gamePort, _ := guestConfig(t)
	startGuest(t, gcfg, em, hub)
	em.wait(t, "host_unreachable", 5*time.Second, has("warning", "host_unreachable"))
	// Sem host, uma conexão do jogo é fechada (não fica pendurada para sempre).
	conn, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(gamePort))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(waitPeerTimeout + 5*time.Second))
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("a conexão deveria ser encerrada quando o host não está disponível")
	}
}

func TestPathLabel(t *testing.T) {
	H, S, P, R := webrtc.ICECandidateTypeHost, webrtc.ICECandidateTypeSrflx, webrtc.ICECandidateTypePrflx, webrtc.ICECandidateTypeRelay
	cases := []struct {
		l, r   webrtc.ICECandidateType
		la, ra string
		want   string
	}{
		{H, H, "192.168.0.2", "192.168.0.9", "direct-v4"},
		{H, H, "2804:1::2", "2804:2::9", "direct-v6"},
		{H, S, "192.168.0.2", "200.1.1.1", "punched"},
		{S, P, "200.1.1.1", "200.2.2.2", "punched"},
		{R, S, "10.0.0.1", "200.2.2.2", "relay"},
		{H, R, "192.168.0.2", "10.0.0.1", "relay"},
	}
	for _, c := range cases {
		if got := pathLabel(c.l, c.r, c.la, c.ra); got != c.want {
			t.Errorf("pathLabel(%v,%v,%s,%s) = %s, esperado %s", c.l, c.r, c.la, c.ra, got, c.want)
		}
	}
}

func TestChannelKind(t *testing.T) {
	for label, want := range map[string]string{"ctl": labelCtl, "game#3": labelGame, "http#9": labelHTTP, "x": "", "game": "", "": ""} {
		if got := channelKind(label); got != want {
			t.Errorf("channelKind(%q) = %q, esperado %q", label, got, want)
		}
	}
}

// ---- pipe ----

type fakeRWC struct {
	io.Reader
	io.Writer
	closer io.Closer // como um DataChannel real: fechar destrava quem está lendo
	closed chan struct{}
	once   sync.Once
}

func (f *fakeRWC) Close() error {
	f.once.Do(func() { close(f.closed); _ = f.closer.Close() })
	return nil
}

func TestPipe_CopiaNosDoisSentidosEFechaOsDois(t *testing.T) {
	a, b := net.Pipe() // "TCP" (lado do app) e a ponta que o teste controla
	dcIn, dcOut := io.Pipe()
	var toDC bytes.Buffer
	var mu sync.Mutex
	rwc := &fakeRWC{Reader: dcIn, closer: dcIn, Writer: writerFunc(func(p []byte) (int, error) { mu.Lock(); defer mu.Unlock(); return toDC.Write(p) }), closed: make(chan struct{})}

	done := make(chan struct{})
	go func() { pipe(a, rwc); close(done) }()

	_, _ = b.Write([]byte("do-jogo"))         // TCP → DataChannel
	_, _ = dcOut.Write([]byte("do-servidor")) // DataChannel → TCP
	got := make([]byte, len("do-servidor"))
	_ = b.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadFull(b, got); err != nil || string(got) != "do-servidor" {
		t.Fatalf("DC→TCP falhou: %q %v", got, err)
	}
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	if toDC.String() != "do-jogo" {
		t.Fatalf("TCP→DC falhou: %q", toDC.String())
	}
	mu.Unlock()

	_ = b.Close() // um lado termina → fecha o outro e libera a função
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("pipe deveria terminar quando um lado fecha")
	}
	select {
	case <-rwc.closed:
	default:
		t.Fatal("o DataChannel deveria ter sido fechado")
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// ---- configuração ----

func TestParseConfig(t *testing.T) {
	ok := `{"mode":"Host","peerId":"p1","signalUrl":"wss://x.example/ws","signalToken":"t","localPort":25565,
	  "ice":{"stunUrls":["stun:stun.l.google.com:19302"],"turn":{"urls":["turn:t.example:3478","turns:t.example:443?transport=tcp"],"username":"u","credential":"c"}}}`
	cfg, err := ParseConfig(strings.NewReader(ok))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != "host" || cfg.MaxGuests != defaultMaxGuests || cfg.ModsPort != defaultModsPort || cfg.RegistryPort != defaultRegistryPort {
		t.Fatalf("padrões não aplicados: %+v", cfg)
	}

	bad := map[string]string{
		"modo":           `{"mode":"x","peerId":"p","signalUrl":"wss://a/b","localPort":1}`,
		"sem peerId":     `{"mode":"host","signalUrl":"wss://a/b","localPort":1}`,
		"url http":       `{"mode":"host","peerId":"p","signalUrl":"https://a/b","localPort":1}`,
		"porta":          `{"mode":"host","peerId":"p","signalUrl":"wss://a/b","localPort":0}`,
		"stun inválido":  `{"mode":"host","peerId":"p","signalUrl":"wss://a/b","localPort":1,"ice":{"stunUrls":["http://x"]}}`,
		"turn inválido":  `{"mode":"host","peerId":"p","signalUrl":"wss://a/b","localPort":1,"ice":{"turn":{"urls":["stun:x"]}}}`,
		"relay sem turn": `{"mode":"guest","peerId":"p","signalUrl":"wss://a/b","localPort":1,"relayOnly":true}`,
		"json quebrado":  `{"mode":`,
	}
	for name, body := range bad {
		_, err := ParseConfig(strings.NewReader(body))
		var ce *codedError
		if err == nil || !errors.As(err, &ce) || ce.Code != "config_decode_failed" {
			t.Errorf("%s: esperava config_decode_failed, veio %v", name, err)
		}
	}
}

// ---- WebSocket ----

func TestWebSocket_EnviaTokenEIdaEVolta(t *testing.T) {
	var gotAuth string
	var once sync.Once
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() { gotAuth = r.Header.Get("Authorization") })
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			typ, data, err := c.Read(r.Context())
			if err != nil {
				return
			}
			if string(data) == "ping" {
				_ = c.Write(r.Context(), typ, []byte("pong"))
				continue
			}
			_ = c.Write(r.Context(), typ, data) // eco do JSON
		}
	}))
	defer srv.Close()

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	sig, err := DialWebSocket(url, "segredo-123")(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer sig.Close()
	if err := sig.Send(context.Background(), Msg{T: msgHello, V: 1, Role: modeHost, PeerID: "p"}); err != nil {
		t.Fatal(err)
	}
	select {
	case m := <-sig.Recv():
		if m.T != msgHello || m.PeerID != "p" {
			t.Fatalf("mensagem inesperada: %+v", m)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("sem resposta da sala")
	}
	if gotAuth != "Bearer segredo-123" {
		t.Fatalf("header Authorization = %q", gotAuth)
	}
}

func TestWebSocket_SalaQueFechaFechaORecv(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		_ = c.Close(websocket.StatusNormalClosure, "fim")
	}))
	defer srv.Close()
	sig, err := DialWebSocket("ws"+strings.TrimPrefix(srv.URL, "http"), "t")(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer sig.Close()
	select {
	case _, ok := <-sig.Recv():
		if ok {
			t.Fatal("Recv deveria ser fechado quando a sala fecha a conexão")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Recv não fechou")
	}
}

func TestWebSocket_RecusaMensagemGrandeDemais(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		<-r.Context().Done()
	}))
	defer srv.Close()
	sig, err := DialWebSocket("ws"+strings.TrimPrefix(srv.URL, "http"), "t")(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer sig.Close()
	big := Msg{T: msgOffer, SDP: strings.Repeat("x", maxSignalMessage+10)}
	if err := sig.Send(context.Background(), big); err == nil {
		t.Fatal("deveria recusar enviar uma sinalização maior que o limite")
	}
}

// ---- eventos ----

func TestStreamEmitter_UmaLinhaJSONPorEvento(t *testing.T) {
	var buf bytes.Buffer
	em := newStreamEmitter(&buf)
	emitStatusOnline(em)
	emitWarning(em, "host_unreachable", "x")
	emitPath(em, "relay", -1)
	emitPath(em, "direct-v6", 12)
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	want := []string{
		`{"ip":"p2p","status":"online"}`,
		`{"detail":"x","warning":"host_unreachable"}`,
		`{"path":"relay"}`,
		`{"path":"direct-v6","rttMs":12}`,
	}
	if len(lines) != len(want) {
		t.Fatalf("linhas: %v", lines)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Errorf("linha %d = %s, esperado %s", i, lines[i], want[i])
		}
	}
}
