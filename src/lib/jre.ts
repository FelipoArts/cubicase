import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { t } from "@/i18n";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type JREVersion = 8 | 17 | 21 | 25;

export interface DownloadProgress {
  status: string;
  percent: number;
}

export async function getJREPath(version: JREVersion): Promise<string> {
  const dataDir = await appLocalDataDir();
  return await join(dataDir, "runtime", `java-${version}`);
}

// Nome do arquivo-marcador escrito só depois que download+extração terminam
// de verdade (ver installJREOnce) — usado por isJREInstalled pra diferenciar
// uma instalação completa de uma pela metade (app morto/crash durante a
// extração, sem rodar nenhum catch de limpeza). Sem isso, bastava
// `bin/java.exe` ter sido escrito antes do resto pra essa pasta quebrada
// passar como "instalada" pra sempre, e o próximo start do servidor tentava
// rodar um Java incompleto com um erro nativo sem explicação nenhuma.
const INSTALL_MARKER_FILE = ".cubicase-install-complete";

export async function isJREInstalled(version: JREVersion): Promise<boolean> {
  const jrePath = await getJREPath(version);
  const javaExe = await join(jrePath, "bin", "java.exe");
  if (!(await exists(javaExe))) return false;

  const marker = await join(jrePath, INSTALL_MARKER_FILE);
  if (await exists(marker)) return true;

  // java.exe existe mas o marcador não — instalação incompleta. Limpa a
  // pasta quebrada agora pra próxima tentativa não herdar lixo dela.
  await remove(jrePath, { recursive: true }).catch(() => {});
  return false;
}

const MAX_INSTALL_ATTEMPTS = 3;

// Uma instalação por versão por vez: duas chamadas concorrentes pra instalar
// o MESMO Java (ex: dois servidores criados em sequência que precisam da
// mesma versão) compartilhavam o mesmo zip/pasta temporários — a limpeza de
// uma no catch podia apagar o download que a outra ainda estava fazendo.
// Chamadas concorrentes pra versões DIFERENTES não colidem (cada uma usa seu
// próprio caminho) e continuam rodando em paralelo normalmente.
const installInFlight = new Map<JREVersion, Promise<void>>();

export async function installJRE(
  version: JREVersion,
  onProgress: (p: DownloadProgress) => void
): Promise<void> {
  const existing = installInFlight.get(version);
  if (existing) {
    onProgress({ status: t("jre.waitingInProgress"), percent: 5 });
    return existing;
  }

  const promise = installJREWithRetry(version, onProgress);
  installInFlight.set(version, promise);
  try {
    await promise;
  } finally {
    installInFlight.delete(version);
  }
}

async function installJREWithRetry(
  version: JREVersion,
  onProgress: (p: DownloadProgress) => void
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_INSTALL_ATTEMPTS; attempt++) {
    try {
      await installJREOnce(version, onProgress, attempt, MAX_INSTALL_ATTEMPTS);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[JRE] Tentativa ${attempt}/${MAX_INSTALL_ATTEMPTS} falhou:`, err);
      if (attempt < MAX_INSTALL_ATTEMPTS) {
        onProgress({ status: t("jre.retrying", { attempt, max: MAX_INSTALL_ATTEMPTS }), percent: 5 });
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }
  throw new Error(t("jre.installFailed", { version, max: MAX_INSTALL_ATTEMPTS, error: String(lastErr) }));
}

async function installJREOnce(
  version: JREVersion,
  onProgress: (p: DownloadProgress) => void,
  attempt: number,
  maxAttempts: number
): Promise<void> {
  const jrePath = await getJREPath(version);
  const runtimeDir = await join(await appLocalDataDir(), "runtime");

  if (!(await exists(runtimeDir))) {
    await mkdir(runtimeDir, { recursive: true });
  }

  const attemptSuffix = maxAttempts > 1 ? ` (tentativa ${attempt}/${maxAttempts})` : "";
  onProgress({ status: `Consultando API Adoptium...${attemptSuffix}`, percent: 10 });

  // 1. Resolve a URL de download e o checksum SHA256 esperado via API JSON da
  // Adoptium (em vez de só seguir o redirect do endpoint /binary/latest, que não
  // dá nenhum jeito de verificar integridade depois).
  const assetsResponse = await fetch(
    `https://api.adoptium.net/v3/assets/latest/${version}/hotspot?vendor=eclipse&os=windows&architecture=x64&image_type=jdk`
  );

  if (!assetsResponse.ok) throw new Error(t("jre.apiFailed"));

  const assets = (await assetsResponse.json()) as Array<{
    binary: { package: { link: string; checksum: string } };
  }>;
  const asset = assets[0];
  if (!asset) throw new Error(t("jre.noBuild"));

  const downloadUrl = asset.binary.package.link;
  const expectedSha256 = asset.binary.package.checksum;
  const tempZip = await join(runtimeDir, `jre-${version}.zip`);

  onProgress({ status: "Baixando Java (isso pode demorar)...", percent: 30 });

  try {
    // 2. Download via Rust (reqwest), com verificação de SHA256 — mesmo comando
    // já usado para o server.jar, sem depender de PowerShell nem interpolar a
    // URL da resposta da API diretamente em um script.
    await invoke("download_server_jar", {
      url: downloadUrl,
      destPath: tempZip,
      expectedSha1: null,
      expectedSha256,
    });

    onProgress({ status: "Instalando e extraindo...", percent: 70 });

    // 3. Extração em Rust com proteção contra zip-slip (enclosed_name), e já
    // achata a pasta-raiz do JDK para dentro de jrePath.
    await invoke("extract_jre_zip", { zipPath: tempZip, extractPath: jrePath });

    // Marcador de "instalação completa" — só é escrito DEPOIS que a extração
    // termina de verdade (ver isJREInstalled). Se o app morrer bem aqui no
    // meio, sem marcador, a próxima checagem detecta a pasta incompleta e
    // limpa sozinha em vez de achar que o Java já está pronto.
    await writeTextFile(await join(jrePath, INSTALL_MARKER_FILE), new Date().toISOString());
  } catch (err) {
    // Não deixar um zip parcial ou uma pasta de JRE pela metade entre tentativas —
    // sem isso, a tentativa seguinte podia herdar lixo do download interrompido.
    await remove(tempZip, { recursive: false }).catch(() => {});
    await remove(jrePath, { recursive: true }).catch(() => {});
    throw new Error(t("jre.installError", { error: String(err) }));
  }

  onProgress({ status: "Java instalado com sucesso!", percent: 100 });
}
