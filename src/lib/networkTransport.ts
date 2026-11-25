// Conexão entre host e convidado: sempre P2P (cubicase-link) — o convidado não precisa de IP, só do
// código do servidor. O tipo de caminho que o ICE escolheu vem do sidecar (evento "network-path").

/** Rótulo do caminho (chave de i18n) para mostrar "Conexão direta". Não há relay: todo caminho é direto. */
export function pathLabelKey(path: string): "net.path.direct" | "net.path.punched" {
  if (path === "punched") return "net.path.punched";
  return "net.path.direct";
}
