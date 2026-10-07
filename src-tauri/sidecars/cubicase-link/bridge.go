package main

import (
	"io"
	"net"
	"strconv"
	"sync"
	"time"
)

const (
	tcpReadChunk = 16 * 1024 // mensagens SCTP pequenas: seguro e baixa latência
	dcReadBuf    = 64 * 1024 // cabe qualquer mensagem do outro lado
)

// pipe copia nos dois sentidos entre uma conexão TCP e um DataChannel (já "detached")
// até qualquer lado terminar; aí fecha os dois. Bloqueia até acabar.
//
// Fechar os dois quando UM lado termina é o mesmo comportamento do proxy TCP que o
// app já usava (handleProxy no tsnet-node) e é o que o Minecraft espera (um disconnect
// de qualquer lado encerra a sessão).
func pipe(conn net.Conn, dc io.ReadWriteCloser) {
	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			_ = conn.Close()
			_ = dc.Close()
		})
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { // TCP → DataChannel
		defer wg.Done()
		defer closeBoth()
		buf := make([]byte, tcpReadChunk)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				if _, werr := dc.Write(buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	go func() { // DataChannel → TCP
		defer wg.Done()
		defer closeBoth()
		buf := make([]byte, dcReadBuf)
		for {
			n, err := dc.Read(buf)
			if n > 0 {
				if _, werr := conn.Write(buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	wg.Wait()
}

// dialLocal conecta no serviço local do host (Minecraft ou servidor HTTP do app).
func dialLocal(port int) (net.Conn, error) {
	return net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 5*time.Second)
}
