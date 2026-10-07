// cubicase-link: transporte P2P (WebRTC: ICE + DTLS + SCTP) entre host e convidado do
// Cubicase. Substitui o tsnet-node (Tailscale) — ver plans/p2p-link-transport-plan.md.
//
// Contrato com o app (mesmo do tsnet-node):
//   - configuração por --config <arquivo> ou --stdin (primeira linha JSON);
//   - eventos como uma linha JSON por evento no stdout (ver events.go);
//   - o processo sai quando o stdin do pai fecha (o app morreu).
package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

const version = "0.1.0"

func main() {
	useStdin := flag.Bool("stdin", false, "ler a configuração da primeira linha do stdin")
	configPath := flag.String("config", "", "caminho do arquivo de configuração JSON")
	showVersion := flag.Bool("version", false, "mostra a versão e sai")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}
	em := newStreamEmitter(os.Stdout)

	cfg, err := loadConfig(*useStdin, *configPath)
	if err != nil {
		fatal(em, err)
	}

	// O pai fechou o stdin (morreu): sai também, sem deixar o processo órfão.
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	dial := DialWebSocket(cfg.SignalURL, cfg.SignalToken)
	switch cfg.Mode {
	case modeHost:
		err = NewHost(cfg, em, dial).Run(ctx)
	case modeGuest:
		err = NewGuest(cfg, em, dial).Run(ctx)
	}
	if err != nil {
		fatal(em, err)
	}
}

func loadConfig(useStdin bool, path string) (Config, error) {
	switch {
	case useStdin:
		line, err := bufio.NewReader(os.Stdin).ReadBytes('\n')
		if err != nil && len(line) == 0 {
			return Config{}, coded("config_read_failed", err)
		}
		return ParseConfig(bytes.NewReader(line))
	case path != "":
		f, err := os.Open(path)
		if err != nil {
			return Config{}, coded("config_read_failed", err)
		}
		defer f.Close()
		return ParseConfig(f)
	}
	return Config{}, coded("config_missing", nil)
}

func fatal(em Emitter, err error) {
	var ce *codedError
	code, detail := "internal_error", err.Error()
	if errors.As(err, &ce) {
		code = ce.Code
		detail = ""
		if ce.Err != nil {
			detail = ce.Err.Error()
		}
	}
	emitError(em, code, detail)
	os.Exit(1)
}
