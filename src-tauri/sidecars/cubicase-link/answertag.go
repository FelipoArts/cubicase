package main

import "strings"

// Amarra cada resposta do host à oferta que a originou. Depois de uma queda de rede o convidado manda ofertas novas
// enquanto respostas antigas ainda estão a caminho: aceitar uma resposta de outra oferta deixa a conexão com o ICE
// e o DTLS errados, e ela só falha 20 s depois. A sala repassa só campos que conhece, então a marca viaja no nome de
// sessão do SDP (linha "s="), que nenhuma das pontas interpreta: o host escreve ali o ice-ufrag da oferta respondida e
// o convidado confere com o da sua oferta atual. Host antigo não marca; resposta sem marca é aceita como sempre.
const answerTagPrefix = "cubicase:"

// offerUfrag devolve o ice-ufrag do SDP ("" se não houver).
func offerUfrag(sdp string) string {
	for _, line := range strings.Split(sdp, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "a=ice-ufrag:"); ok {
			return v
		}
	}
	return ""
}

// tagAnswer escreve no SDP da resposta a marca da oferta respondida.
func tagAnswer(answerSDP, offerSDP string) string {
	u := offerUfrag(offerSDP)
	if u == "" {
		return answerSDP
	}
	lines := strings.Split(answerSDP, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, "s=") {
			lines[i] = "s=" + answerTagPrefix + u + strings.TrimPrefix(line, strings.TrimRight(line, "\r"))
			break
		}
	}
	return strings.Join(lines, "\n")
}

// answerMatchesOffer: false só quando a resposta tem marca e ela é de outra oferta.
func answerMatchesOffer(answerSDP, localOfferSDP string) bool {
	for _, line := range strings.Split(answerSDP, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "s="+answerTagPrefix); ok {
			return v == offerUfrag(localOfferSDP)
		}
	}
	return true
}
