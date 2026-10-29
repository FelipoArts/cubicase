// labwire: um "cabo ruim" para o laboratório de rede. Liga duas interfaces (A <-> B) repassando cada quadro de uma para
// a outra, e no caminho aplica atraso, oscilação (jitter), perda, limite de banda e fila finita. É transparente: nenhum
// dos lados sabe que está no meio. Existe porque o kernel do Docker Desktop não tem o `netem`.
//
//	labwire -a vethA -b vethB -delay 80ms -jitter 30ms -loss 0.03 -rate 250000 -queue 300ms
//
// -rate é em bytes/s (0 = sem limite). -loss é a probabilidade de descarte por quadro, nos dois sentidos.
// -blackout "10s:12s" corta tudo entre 10 s e 12 s depois da partida (queda total de rede). Mudanças em tempo real: SIGUSR1
// alterna o corte total (liga/desliga), para o teste simular a rede caindo e voltando.
package main

import (
	"flag"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type shaper struct {
	delay, jitter time.Duration
	loss          float64
	rate          float64 // bytes/s
	maxQueue      time.Duration
	reorder       bool
	cut           *atomic.Bool

	// por sentido
	nextFree time.Time // quando o "fio" fica livre (serialização por banda)
	lastOut  time.Time // última liberação (para não reordenar quando reorder=false)
	rng      *rand.Rand
}

func htons(v uint16) uint16 { return v<<8 | v>>8 }

func open(ifname string) (fd int, idx int) {
	i, err := netIndex(ifname)
	if err != nil {
		log.Fatalf("interface %s: %v", ifname, err)
	}
	fd, err = unix.Socket(unix.AF_PACKET, unix.SOCK_RAW, int(htons(unix.ETH_P_ALL)))
	if err != nil {
		log.Fatalf("socket: %v", err)
	}
	if err := unix.Bind(fd, &unix.SockaddrLinklayer{Protocol: htons(unix.ETH_P_ALL), Ifindex: i}); err != nil {
		log.Fatalf("bind %s: %v", ifname, err)
	}
	return fd, i
}

func netIndex(name string) (int, error) {
	ifc, err := netInterfaceByName(name)
	return ifc, err
}

func (s *shaper) run(srcFd, dstFd, dstIdx int, tag string, sent *atomic.Int64, dropped *atomic.Int64) {
	buf := make([]byte, 65536)
	for {
		n, from, err := unix.Recvfrom(srcFd, buf, 0)
		if err != nil {
			log.Fatalf("%s recv: %v", tag, err)
		}
		if ll, ok := from.(*unix.SockaddrLinklayer); ok && ll.Pkttype == unix.PACKET_OUTGOING {
			continue // o que nós mesmos enviamos por esta interface
		}
		if s.cut.Load() || (s.loss > 0 && s.rng.Float64() < s.loss) {
			dropped.Add(1)
			continue
		}
		now := time.Now()
		release := now.Add(s.delay)
		if s.jitter > 0 {
			release = release.Add(time.Duration((s.rng.Float64()*2 - 1) * float64(s.jitter)))
		}
		if s.rate > 0 {
			start := s.nextFree
			if start.Before(now) {
				start = now
			}
			if s.maxQueue > 0 && start.Sub(now) > s.maxQueue {
				dropped.Add(1) // fila cheia: descarta (como um roteador de verdade)
				continue
			}
			s.nextFree = start.Add(time.Duration(float64(n) / s.rate * float64(time.Second)))
			if s.nextFree.After(release) {
				release = s.nextFree
			}
		}
		if !s.reorder && release.Before(s.lastOut) {
			release = s.lastOut
		}
		s.lastOut = release
		frame := append([]byte(nil), buf[:n]...)
		time.AfterFunc(time.Until(release), func() {
			if s.cut.Load() {
				return
			}
			_ = unix.Sendto(dstFd, frame, 0, &unix.SockaddrLinklayer{Ifindex: dstIdx, Halen: 6})
			sent.Add(1)
		})
	}
}

func main() {
	a := flag.String("a", "", "interface A")
	b := flag.String("b", "", "interface B")
	delay := flag.Duration("delay", 0, "atraso fixo em cada sentido")
	jitter := flag.Duration("jitter", 0, "variação do atraso (±)")
	loss := flag.Float64("loss", 0, "probabilidade de perda por quadro (0 a 1)")
	rate := flag.Float64("rate", 0, "banda em bytes/s por sentido (0 = ilimitada)")
	queue := flag.Duration("queue", 300*time.Millisecond, "fila máxima por sentido antes de descartar")
	reorder := flag.Bool("reorder", false, "permitir que o jitter reordene os pacotes")
	blackout := flag.String("blackout", "", "corte total, ex.: 10s:12s (início:fim depois da partida)")
	flag.Parse()
	if *a == "" || *b == "" {
		log.Fatal("use -a e -b")
	}

	cut := &atomic.Bool{}
	fdA, idxA := open(*a)
	fdB, idxB := open(*b)
	var sentAB, sentBA, dropAB, dropBA atomic.Int64
	mk := func(seed int64) *shaper {
		return &shaper{delay: *delay, jitter: *jitter, loss: *loss, rate: *rate, maxQueue: *queue, reorder: *reorder, cut: cut, rng: rand.New(rand.NewSource(seed))}
	}
	go mk(1).run(fdA, fdB, idxB, "A->B", &sentAB, &dropAB)
	go mk(2).run(fdB, fdA, idxA, "B->A", &sentBA, &dropBA)

	if *blackout != "" {
		var from, to time.Duration
		var f, t string
		for i := 0; i < len(*blackout); i++ {
			if (*blackout)[i] == ':' {
				f, t = (*blackout)[:i], (*blackout)[i+1:]
			}
		}
		from, _ = time.ParseDuration(f)
		to, _ = time.ParseDuration(t)
		time.AfterFunc(from, func() { cut.Store(true); log.Printf("corte total ligado") })
		time.AfterFunc(to, func() { cut.Store(false); log.Printf("corte total desligado") })
	}

	log.Printf("labwire %s <-> %s | atraso=%v jitter=%v perda=%.1f%% banda=%.0f B/s fila=%v", *a, *b, *delay, *jitter, *loss*100, *rate, *queue)
	sig := make(chan os.Signal, 4)
	signal.Notify(sig, syscall.SIGUSR1, syscall.SIGTERM, syscall.SIGINT)
	for s := range sig {
		switch s {
		case syscall.SIGUSR1:
			cut.Store(!cut.Load())
			log.Printf("corte total = %v", cut.Load())
		default:
			log.Printf("encerrando | A->B enviados=%d descartados=%d | B->A enviados=%d descartados=%d", sentAB.Load(), dropAB.Load(), sentBA.Load(), dropBA.Load())
			return
		}
	}
}
