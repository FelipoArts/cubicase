package main

import "testing"

const (
	tagOffer = "v=0\r\ns=-\r\nt=0 0\r\na=ice-ufrag:AAAA\r\na=ice-pwd:x\r\n"
	tagOther = "v=0\r\ns=-\r\nt=0 0\r\na=ice-ufrag:BBBB\r\na=ice-pwd:y\r\n"
	tagAns   = "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=ice-ufrag:HOST\r\n"
)

func TestAnswerTag(t *testing.T) {
	tagged := tagAnswer(tagAns, tagOffer)
	if tagged == tagAns {
		t.Fatal("a resposta devia ter sido marcada")
	}
	if !answerMatchesOffer(tagged, tagOffer) {
		t.Error("a resposta marcada devia combinar com a própria oferta")
	}
	if answerMatchesOffer(tagged, tagOther) {
		t.Error("a resposta de outra oferta devia ser recusada")
	}
	if !answerMatchesOffer(tagAns, tagOther) {
		t.Error("resposta sem marca (host antigo) devia ser aceita")
	}
	if offerUfrag(tagged) != "HOST" {
		t.Errorf("a marca não pode mexer no ice-ufrag da resposta: %q", offerUfrag(tagged))
	}
	if tagAnswer(tagAns, "v=0\r\n") != tagAns {
		t.Error("oferta sem ice-ufrag não deve alterar a resposta")
	}
}
