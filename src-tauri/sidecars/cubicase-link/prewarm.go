package main

import (
	"io"
	"net"
	"time"
)

// prewarmFirewall abre, por `hold`, um ouvinte TCP e uma porta UDP em todas as interfaces e depois fecha.
//
// Serve para o Windows fazer a pergunta do Firewall ("permitir o Cubicase na rede?") num momento
// previsível — quando o host abre o servidor para os amigos, ou o convidado vai conectar — em vez de no
// meio da primeira conexão. Quando a pessoa responde, o Windows grava uma regra POR PROGRAMA (vale para
// TCP e UDP e para qualquer porta), então a negociação real depois já encontra a regra pronta. O ouvinte TCP
// é o que dispara a pergunta de forma confiável; a porta UDP cobre o caso em que ela só aparece nela.
//
// Não aceita conexões nem lê pacotes: só mantém as portas abertas até o tempo acabar. Se a regra já existe,
// o Windows não pergunta nada e isto não tem efeito visível.
func prewarmFirewall(hold time.Duration) {
	var open []io.Closer
	if ln, err := net.Listen("tcp", ":0"); err == nil {
		open = append(open, ln)
	}
	if pc, err := net.ListenPacket("udp4", ":0"); err == nil {
		open = append(open, pc)
	}
	time.Sleep(hold)
	for _, c := range open {
		_ = c.Close()
	}
}
