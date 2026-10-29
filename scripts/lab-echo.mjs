// "Minecraft" falso do laboratório de rede: devolve tudo que recebe. Roda na rede do host (ver lab/case.sh).
import net from "node:net";
const port = Number(process.argv[2] || 39000);
net.createServer((sock) => { sock.on("data", (d) => sock.write(d)); sock.on("error", () => {}); }).listen(port, "127.0.0.1");
