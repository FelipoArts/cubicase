package main

import (
	"fmt"
	"os"
	"time"
)

// Registro de diagnóstico, desligado por padrão: com CUBICASE_LINK_DEBUG=1 o sidecar escreve no stderr o que decide
// ao negociar com o host (mensagens da sala, troca de conexão, estados do ICE). O app só lê o stdout, então isto
// nunca aparece para o usuário; serve para investigar problemas de conexão em campo (ver scripts/e2e-link.mjs).
var debugOn = os.Getenv("CUBICASE_LINK_DEBUG") != ""

func dbg(format string, args ...any) {
	if !debugOn {
		return
	}
	fmt.Fprintf(os.Stderr, "%s "+format+"\n", append([]any{time.Now().Format("15:04:05.000")}, args...)...)
}
