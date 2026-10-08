package main

import (
	"fmt"
	"io"
	"os"
	"time"
)

// soakTest mantém a conexão por um tempo (um ping de 64 bytes a cada 5 s). Serve para provar que um
// caminho em RELAY sobrevive além da validade das permissões do TURN (~5 min): o cliente TURN renova
// todas as permissões numa só requisição, e um endereço recusado pelo relay (IPv6, IP privado) faz a
// renovação falhar ("CreatePermission 400"). O host só precisa ficar de pé ecoando.
func soakTest(role string, echo io.ReadWriter, d time.Duration, path string) {
	fmt.Fprintf(os.Stderr, "\n== TESTE DE RESISTÊNCIA por %v (%s) ==\n", d, path)
	if role != "guest" {
		time.Sleep(d + 20*time.Second) // o host só ecoa; fica de pé enquanto o convidado testa
		return
	}
	start := time.Now()
	ok, fail := 0, 0
	for time.Since(start) < d {
		done := make(chan time.Duration, 1)
		go func() {
			t := time.Now()
			if _, err := echo.Write(make([]byte, 64)); err != nil {
				return
			}
			if _, err := io.ReadFull(echo, make([]byte, 64)); err != nil {
				return
			}
			done <- time.Since(t)
		}()
		select {
		case rtt := <-done:
			ok++
			if ok%12 == 1 { // uma linha por minuto
				fmt.Fprintf(os.Stderr, "%5.0fs  ok  rtt=%v\n", time.Since(start).Seconds(), rtt.Round(time.Millisecond))
			}
		case <-time.After(10 * time.Second):
			fail++
			fmt.Fprintf(os.Stderr, "%5.0fs  SEM RESPOSTA (a conexão caiu?)\n", time.Since(start).Seconds())
			if fail >= 3 {
				fmt.Fprintf(os.Stderr, "RESULTADO: CAIU depois de %.0fs (respostas ok=%d)\n", time.Since(start).Seconds(), ok)
				return
			}
		}
		time.Sleep(5 * time.Second)
	}
	fmt.Fprintf(os.Stderr, "RESULTADO: sobreviveu %v (respostas ok=%d, falhas=%d)\n", d, ok, fail)
}
