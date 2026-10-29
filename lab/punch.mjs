// Teste manual de furo de NAT: envia pacotes UDP para o endereço público do outro lado e mostra o que chega.
// uso: node punch.mjs <porta-local> <ip-destino> <porta-destino>
import dgram from "node:dgram";
const [lport, dip, dport] = [Number(process.argv[2]), process.argv[3], Number(process.argv[4])];
const s = dgram.createSocket("udp4");
let got = 0;
s.on("message", (m, r) => { got++; if (got <= 2) console.log(`recebi "${m}" de ${r.address}:${r.port}`); });
s.bind(lport, () => {
  const t = setInterval(() => s.send(Buffer.from(`oi de ${lport}`), dport, dip), 200);
  setTimeout(() => { clearInterval(t); console.log(`porta ${lport}: ${got} pacote(s) recebido(s)`); s.close(); }, 4000);
});
