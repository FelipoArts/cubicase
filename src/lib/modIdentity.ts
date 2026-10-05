import { invoke } from "@tauri-apps/api/core";

// ============================================================
// Identidade dos mods (lida dos próprios .jar pelo backend Rust)
// ============================================================
// Nome de arquivo não identifica um mod (versões diferentes têm nomes
// diferentes; o mesmo mod vem da Modrinth ou da CurseForge). O id declarado
// dentro do jar sim. Ver src-tauri/src/mod_identity.rs.
// ============================================================

export interface ModIdentity {
  file_name: string;
  enabled: boolean;
  mod_id: string | null;
  version: string | null;
  loader: string | null;
}

export interface JarIdentity {
  mod_id: string | null;
  version: string | null;
  loader: string | null;
}

export function readModIdentities(serverDir: string, folderName: string): Promise<ModIdentity[]> {
  return invoke<ModIdentity[]>("read_mod_identities", { serverDir, folderName });
}

export function readJarIdentity(path: string): Promise<JarIdentity> {
  return invoke<JarIdentity>("read_jar_identity", { path });
}

export interface DuplicateGroup {
  modId: string;
  files: ModIdentity[];
}

/**
 * Mods com o mesmo id em mais de um arquivo ATIVO (mesmo que as versões sejam
 * iguais) — é o que faz o loader reclamar de "duplicate mod" ou carregar o
 * errado. Arquivos desabilitados não contam: já estão fora de uso.
 */
export function findDuplicates(identities: ModIdentity[]): DuplicateGroup[] {
  const byId = new Map<string, ModIdentity[]>();
  for (const m of identities) {
    if (!m.enabled || !m.mod_id) continue;
    byId.set(m.mod_id, [...(byId.get(m.mod_id) ?? []), m]);
  }
  return [...byId.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([modId, files]) => ({ modId, files }))
    .sort((a, b) => a.modId.localeCompare(b.modId));
}

export type IncomingStatus = "new" | "identical" | "conflict";

export interface IncomingClassification {
  status: IncomingStatus;
  /** O mod já presente no servidor com que este colide/coincide. */
  existing?: ModIdentity;
}

const baseName = (fileName: string) => fileName.replace(/\.disabled$/i, "").toLowerCase();

/**
 * Compara um mod que vai ser instalado com o que o servidor já tem:
 * - mesmo id e mesma versão  → "identical" (não precisa instalar de novo);
 * - mesmo id, versão diferente (ou desconhecida) → "conflict";
 * - id desconhecido: vale o nome do arquivo (mesmo nome = "identical");
 * - nome de arquivo igual mas id diferente → "conflict" (não sobrescrever em silêncio);
 * - nada em comum → "new".
 * Mods já presentes porém desabilitados contam: o host os desligou de propósito.
 */
export function classifyIncoming(
  existing: ModIdentity[],
  incoming: { filename: string; mod_id: string | null; version: string | null }
): IncomingClassification {
  const sameFile = existing.find((e) => baseName(e.file_name) === baseName(incoming.filename));

  if (incoming.mod_id) {
    const sameId = existing.filter((e) => e.mod_id === incoming.mod_id);
    if (sameId.length > 0) {
      const exact = sameId.find((e) => e.version !== null && e.version === incoming.version);
      if (exact) return { status: "identical", existing: exact };
      return { status: "conflict", existing: sameId.find((e) => e.enabled) ?? sameId[0] };
    }
    if (sameFile) return { status: "conflict", existing: sameFile };
    return { status: "new" };
  }

  if (sameFile) return { status: "identical", existing: sameFile };
  return { status: "new" };
}

export interface PlanCounts {
  new: number;
  identical: number;
  conflict: number;
}

export function countStatuses(items: { status: IncomingStatus }[]): PlanCounts {
  const counts: PlanCounts = { new: 0, identical: 0, conflict: 0 };
  for (const i of items) counts[i.status]++;
  return counts;
}
