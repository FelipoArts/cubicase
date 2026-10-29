// labstun: servidor STUN mínimo (só "Binding") para o laboratório de rede. Devolve ao cliente o endereço e a porta de onde
// o pacote dele chegou — com o NAT simulado no meio, esse é o endereço "público" que o ICE anuncia como candidato srflx.
// (O STUN do Google devolveria o IP real da sua internet, igual para host e convidado, e a conexão direta entre eles não
// teria como acontecer dentro do laboratório.)
package main

import (
	"flag"
	"log"
	"net"

	"github.com/pion/stun/v4"
)

func main() {
	addr := flag.String("listen", ":3478", "endereço UDP")
	flag.Parse()
	conn, err := net.ListenPacket("udp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("labstun escutando em %s", conn.LocalAddr())
	buf := make([]byte, 1500)
	for {
		n, from, err := conn.ReadFrom(buf)
		if err != nil {
			log.Fatal(err)
		}
		req := &stun.Message{Raw: append([]byte(nil), buf[:n]...)}
		if err := req.Decode(); err != nil || req.Type != stun.BindingRequest {
			continue
		}
		udp := from.(*net.UDPAddr)
		resp, err := stun.Build(
			stun.NewTransactionIDSetter(req.TransactionID),
			stun.BindingSuccess,
			&stun.XORMappedAddress{IP: udp.IP, Port: udp.Port},
			stun.Fingerprint,
		)
		if err != nil {
			continue
		}
		log.Printf("binding de %s", from)
		_, _ = conn.WriteTo(resp.Raw, from)
	}
}
