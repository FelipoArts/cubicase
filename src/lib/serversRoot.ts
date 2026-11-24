import { invoke } from "@tauri-apps/api/core";

// Pasta onde ficam os servidores criados pelo Cubicase. A ÚNICA fonte do caminho é o backend
// (src-tauri/src/storage_dirs.rs): instalações novas usam C:\Users\<você>\Cubicase\Servers; quem já tinha
// Documentos\CubicaseServers continua nela. Não codifique o caminho em outro lugar: peça por aqui.

let cached: Promise<string> | null = null;

export function getServersRoot(): Promise<string> {
  if (!cached) {
    cached = invoke<string>("get_servers_root").catch((err) => {
      cached = null; // tenta de novo na próxima chamada
      throw err;
    });
  }
  return cached;
}
