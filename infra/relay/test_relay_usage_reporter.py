import importlib.util
import json
import os
import unittest

spec = importlib.util.spec_from_file_location("reporter", os.path.join(os.path.dirname(__file__), "relay-usage-reporter.py"))
reporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reporter)

USAGE = "2026-10-11T00:11:24+00:00 relay turnserver: 3400: : session 001000000000000001: usage: realm=<turn.cubicase.net>, username=<1791681292:abc-123>, rp=1032, rb=95616, sp=1034, sb=94520"
PEER = "2026-10-11T00:11:24+00:00 relay turnserver: 3400: : session 001000000000000001: peer usage: realm=<turn.cubicase.net>, username=<1791681292:abc-123>, rp=1016, rb=89408, sp=1014, sb=89232"


class CollectorTest(unittest.TestCase):
    def test_soma_o_que_saiu_da_vm_nas_duas_direcoes(self):
        c = reporter.Collector()
        self.assertIsNone(c.feed(USAGE))
        self.assertEqual(c.feed(PEER), {"peerId": "abc-123", "bytes": 94520 + 89232})

    def test_ignora_linhas_que_nao_sao_de_consumo(self):
        c = reporter.Collector()
        self.assertIsNone(c.feed("session 1: realm <x> user <y>: incoming packet CREATE_PERMISSION processed, success"))
        self.assertIsNone(c.feed(""))

    def test_peer_usage_sem_a_linha_anterior_e_ignorado(self):
        self.assertIsNone(reporter.Collector().feed(PEER))

    def test_sessoes_intercaladas_nao_se_misturam(self):
        c = reporter.Collector()
        a1 = USAGE.replace("001000000000000001", "11").replace("abc-123", "peer-a")
        a2 = PEER.replace("001000000000000001", "11").replace("abc-123", "peer-a")
        b1 = USAGE.replace("001000000000000001", "22").replace("abc-123", "peer-b").replace("sb=94520", "sb=10")
        b2 = PEER.replace("001000000000000001", "22").replace("abc-123", "peer-b").replace("sb=89232", "sb=5")
        out = [c.feed(x) for x in (a1, b1, b2, a2)]
        self.assertEqual([o for o in out if o], [{"peerId": "peer-b", "bytes": 15}, {"peerId": "peer-a", "bytes": 94520 + 89232}])

    def test_username_fora_do_formato_de_credencial_temporaria_e_ignorado(self):
        c = reporter.Collector()
        c.feed(USAGE.replace("<1791681292:abc-123>", "<semdoispontos>"))
        self.assertIsNone(c.feed(PEER.replace("<1791681292:abc-123>", "<semdoispontos>")))

    def test_consumo_zero_nao_gera_entrada(self):
        c = reporter.Collector()
        c.feed(USAGE.replace("sb=94520", "sb=0"))
        self.assertIsNone(c.feed(PEER.replace("sb=89232", "sb=0")))


class SignatureTest(unittest.TestCase):
    def test_assinatura_bate_com_o_hmac_sha256_em_hex(self):
        import hashlib
        import hmac
        self.assertEqual(reporter.sign("s", b'{"a":1}'), hmac.new(b"s", b'{"a":1}', hashlib.sha256).hexdigest())
        self.assertRegex(reporter.sign("s", b"x"), r"^[0-9a-f]{64}$")


class FlushTest(unittest.TestCase):
    def test_falha_de_rede_mantem_a_fila(self):
        orig = reporter.post
        reporter.post = lambda *a, **k: (_ for _ in ()).throw(OSError("sem rede"))
        try:
            q = [{"peerId": "p", "bytes": 1}]
            self.assertEqual(reporter.flush("s", q), [{"peerId": "p", "bytes": 1}])
        finally:
            reporter.post = orig

    def test_sucesso_esvazia_a_fila_em_lotes(self):
        sent = []
        orig = reporter.post
        reporter.post = lambda secret, entries, *a, **k: sent.append(len(entries)) or 200
        try:
            q = [{"peerId": "p%d" % i, "bytes": 1} for i in range(950)]
            self.assertEqual(reporter.flush("s", q), [])
            self.assertEqual(sent, [400, 400, 150])
        finally:
            reporter.post = orig


if __name__ == "__main__":
    unittest.main()
