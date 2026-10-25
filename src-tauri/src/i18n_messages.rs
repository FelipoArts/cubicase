//! Catálogo de mensagens do backend: cada chave tem (pt-BR, en) lado a lado.
//! Placeholders usam `{nome}`. Ver `i18n.rs` para o uso (`tr!`) e os testes que
//! garantem paridade de placeholders e que toda chave usada no código existe aqui.

macro_rules! messages {
    ($($key:literal => ($pt:literal, $en:literal),)*) => {
        /// Par (pt-BR, en) de uma chave.
        pub fn lookup(key: &str) -> Option<(&'static str, &'static str)> {
            match key {
                $($key => Some(($pt, $en)),)*
                _ => None,
            }
        }

        /// Todas as chaves do catálogo (usada nos testes de consistência).
        #[cfg(test)]
        pub const KEYS: &[&str] = &[$($key),*];
    };
}

messages! {
    // ---------- Tray ----------
    "tray.show" => ("Abrir Cubicase", "Open Cubicase"),
    "tray.quit" => ("Sair (encerra servidor e conexão)", "Quit (stops the server and the connection)"),

    // ---------- Erros do sidecar de rede (título + mensagem) ----------
    "sidecar.config.title" => ("Configuração de rede inválida", "Invalid network configuration"),
    "sidecar.config.message" => (
        "Não foi possível ler a configuração da conexão. Tente reiniciar o app; se persistir, reinstale o Cubicase.",
        "Couldn't read the connection configuration. Try restarting the app; if it persists, reinstall Cubicase."
    ),
    "sidecar.listenLocal.title" => ("Porta local já em uso", "Local port already in use"),
    "sidecar.listenLocal.message" => (
        "Não foi possível abrir a porta local necessária para a conexão — provavelmente já está em uso por outro programa. Detalhe técnico: {detail}",
        "Couldn't open the local port needed for the connection — it's probably already in use by another program. Technical detail: {detail}"
    ),
    "sidecar.other.title" => ("Erro inesperado na conexão", "Unexpected connection error"),
    "sidecar.other.code" => ("Código: {code}", "Code: {code}"),
    "sidecar.hostUnreachable.title" => ("Conexão com o host instável", "Unstable connection to the host"),
    "sidecar.hostUnreachable.message" => (
        "Não estamos conseguindo alcançar o host há um tempo — a conexão pode ter caído ou o host pode ter ficado offline. O app continua tentando se recuperar sozinho; se persistir, peça para o host verificar a internet dele.",
        "We haven't been able to reach the host for a while — the connection may have dropped or the host may have gone offline. The app keeps trying to recover on its own; if it persists, ask the host to check their internet."
    ),
    "sidecar.tokenExpired.title" => ("Conexão renovada", "Connection renewed"),
    "sidecar.tokenExpired.message" => (
        "A sessão de conexão expirou depois de muito tempo ligada. O Cubicase está reconectando sozinho; se os amigos caírem, é só entrarem de novo.",
        "The connection session expired after running for a long time. Cubicase is reconnecting by itself; if friends get dropped they just need to join again."
    ),
    "sidecar.roomFull.title" => ("Servidor lotado", "Server is full"),
    "sidecar.roomFull.message" => (
        "O host atingiu o limite de convidados conectados ao mesmo tempo. Tente de novo quando alguém sair.",
        "The host has reached the limit of guests connected at the same time. Try again when someone leaves."
    ),
    "sidecar.signal.title" => ("Conexão com o Cubicase instável", "Unstable connection to Cubicase"),
    "sidecar.signal.message" => (
        "Não estamos conseguindo falar com o servidor do Cubicase para organizar novas conexões. Quem já está jogando não é afetado; o app tenta reconectar sozinho.",
        "We can't reach the Cubicase server to set up new connections. Players already connected aren't affected; the app keeps trying to reconnect on its own."
    ),
    "sidecar.connLost.title" => ("Conexão com o host caiu", "Connection to the host dropped"),
    "sidecar.connLost.message" => (
        "A conexão direta com o outro computador caiu. O app tenta restabelecê-la automaticamente; se não voltar em alguns segundos, entre de novo.",
        "The direct connection to the other computer dropped. The app tries to restore it automatically; if it doesn't come back in a few seconds, join again."
    ),
    "sidecar.modsProxy.title" => ("Sincronização de mods indisponível", "Mod sync unavailable"),
    "sidecar.modsProxy.message" => (
        "Não foi possível abrir a porta local usada para sincronizar mods (provavelmente em uso por outro programa). O jogo em si não é afetado.",
        "Couldn't open the local port used to sync mods (probably in use by another program). The game itself is not affected."
    ),
    "sidecar.warn.title" => ("Aviso na conexão", "Connection warning"),

    // ---------- Rede ----------
    "net.roleConflict" => (
        "Esta instalação já está com a conexão ativa como \"{active}\". Pare-a antes de conectar como \"{requested}\". Se quiser jogar no seu próprio servidor a partir deste mesmo computador, conecte direto em localhost:{port} — não precisa (e não é suportado) usar o modo Convidado para isso.",
        "This installation already has the connection active as \"{active}\". Stop it before connecting as \"{requested}\". If you want to play on your own server from this same computer, connect straight to localhost:{port} — you don't need to (and can't) use Guest mode for that."
    ),
    "net.role.host" => ("Host", "Host"),
    "net.role.guest" => ("Convidado", "Guest"),
    "net.credentialsFailed" => ("Não foi possível obter credenciais de rede: {error}", "Couldn't get network credentials: {error}"),
    "net.link.unsupported" => (
        "O servidor do Cubicase ainda não está atualizado para esta versão do app. Tente de novo em alguns minutos.",
        "The Cubicase server isn't updated for this version of the app yet. Try again in a few minutes."
    ),
    "provider.link.incomplete" => ("As credenciais da conexão P2P vieram incompletas. Tente novamente.", "The P2P connection credentials came back incomplete. Try again."),
    "net.hostReconnected" => ("Conexão com o host restabelecida.", "Connection to the host restored."),
    "net.meshDisconnected" => ("Conexão desconectada.", "Connection disconnected."),
    "net.closed" => ("Conexão de rede encerrada: {title} (ver Central de Diagnósticos)", "Network connection closed: {title} (see the Diagnostics Center)"),
    "net.closedUnexpected" => ("Conexão de rede encerrada inesperadamente (Código: {code})", "Network connection closed unexpectedly (Code: {code})"),
    "net.mock.authenticating" => ("[mock-provider] Autenticando nó virtual simulado...", "[mock-provider] Authenticating the simulated virtual node..."),
    "net.mock.registered" => ("[mock-provider] Nó registrado com IP virtual simulado: {ip}", "[mock-provider] Node registered with simulated virtual IP: {ip}"),
    "net.mock.starting" => ("[mock-provider] Inicializando provedor de testes (Mock)...", "[mock-provider] Starting the test provider (Mock)..."),
    "net.mock.proxy" => ("[mock-provider] Proxy reverso simulado escutando em localhost:{port}", "[mock-provider] Simulated reverse proxy listening on localhost:{port}"),
    "net.mock.stopping" => ("[mock-provider] Finalizando sessão simulada...", "[mock-provider] Ending the simulated session..."),
    "net.mock.stopped" => ("[mock-provider] Rede simulada encerrada.", "[mock-provider] Simulated network stopped."),

    // ---------- Arquivos / launcher / instalação ----------
    "err.serverMustBeStopped" => (
        "O servidor Minecraft precisa estar parado para fazer isso — pare o servidor e tente novamente.",
        "The Minecraft server needs to be stopped to do this — stop the server and try again."
    ),
    "err.javaPathInvalid" => ("Configuração de inicialização inválida (Java, JAR ou pasta de argumentos).", "Invalid launch setup (Java, JAR or arguments folder)."),
    "err.commandInvalid" => ("Comando inválido (vazio ou com quebra de linha).", "Invalid command (empty or contains a line break)."),
    "props.invalidEntry" => ("Propriedade inválida em server.properties: {key}", "Invalid server.properties entry: {key}"),
    "err.iconTooBig" => ("A imagem é grande demais (máximo 25 MB e 8192 px de lado).", "The image is too large (max 25 MB and 8192 px per side)."),
    "err.modCopyInvalid" => ("Cópia de mod inválida (só arquivos .jar com caminho completo).", "Invalid mod copy (only .jar files with a full path)."),
    "err.serversDatUnreadable" => ("O servers.dat do Minecraft existe mas não pôde ser lido; ele não foi alterado para não apagar sua lista de servidores.", "Minecraft's servers.dat exists but couldn't be read; it was left untouched so your server list isn't lost."),
    "players.invalidName" => ("Nome de jogador inválido: {name}", "Invalid player name: {name}"),
    "players.invalidIp" => ("Endereço IP inválido: {ip}", "Invalid IP address: {ip}"),
    "err.serversDatRead" => ("Falha ao ler servers.dat: {error}", "Failed to read servers.dat: {error}"),
    "err.serversDatBuild" => ("Falha ao montar servers.dat: {error}", "Failed to build servers.dat: {error}"),
    "err.serversDatSerialize" => ("Falha ao serializar servers.dat: {error}", "Failed to serialize servers.dat: {error}"),
    "err.serversDatWrite" => ("Falha ao gravar servers.dat: {error}", "Failed to write servers.dat: {error}"),
    "err.listVersions" => ("Falha ao listar versions/: {error}", "Failed to list versions/: {error}"),
    "err.instanceDir" => ("Falha ao criar a pasta da instância: {error}", "Failed to create the instance folder: {error}"),
    "err.profilesInvalid" => ("{file} não tem um campo \"profiles\" válido", "{file} has no valid \"profiles\" field"),
    "err.fileRead" => ("Falha ao ler {file}: {error}", "Failed to read {file}: {error}"),
    "err.fileParse" => ("Falha ao interpretar {file}: {error}", "Failed to parse {file}: {error}"),
    "err.fileBackup" => ("Falha ao criar backup de {file}: {error}", "Failed to back up {file}: {error}"),
    "err.fileSerialize" => ("Falha ao serializar {file}: {error}", "Failed to serialize {file}: {error}"),
    "err.fileWrite" => ("Falha ao gravar {file}: {error}", "Failed to write {file}: {error}"),
    "err.openLauncher" => ("Falha ao abrir o Minecraft Launcher: {error}", "Failed to open the Minecraft Launcher: {error}"),
    "err.downloadHttp" => ("Falha no download: HTTP {status}", "Download failed: HTTP {status}"),
    "err.checksumSha1" => ("Checksum SHA1 não confere (esperado {expected}, obtido {actual})", "SHA1 checksum mismatch (expected {expected}, got {actual})"),
    "err.checksumSha256" => ("Checksum SHA256 não confere (esperado {expected}, obtido {actual})", "SHA256 checksum mismatch (expected {expected}, got {actual})"),
    "err.checksumSha1AfterDownload" => ("Checksum SHA1 não confere após o download.", "SHA1 checksum mismatch after the download."),
    "err.downloadAttempts" => ("Falha ao baixar após {attempts} tentativas: {error}", "Download failed after {attempts} attempts: {error}"),
    "err.modDownloadAttempts" => ("Falha ao baixar mod após {attempts} tentativas: {error}", "Failed to download the mod after {attempts} attempts: {error}"),
    "err.openFile" => ("Não foi possível abrir o arquivo: {error}", "Couldn't open the file: {error}"),
    "err.invalidArchive" => ("Arquivo inválido ou corrompido: {error}", "Invalid or corrupted file: {error}"),

    // ---------- Servidor Minecraft ----------
    "mc.oom.title" => ("Sem memória suficiente (OutOfMemoryError)", "Not enough memory (OutOfMemoryError)"),
    "mc.oom.message" => (
        "O servidor Minecraft ficou sem memória durante a execução. Tente aumentar a RAM alocada nas configurações do servidor, ou feche outros programas para liberar memória.",
        "The Minecraft server ran out of memory while running. Try increasing the RAM allocated in the server settings, or close other programs to free up memory."
    ),
    "mc.javaVersion.title" => ("Versão do Java incompatível", "Incompatible Java version"),
    "mc.javaVersion.message" => (
        "A versão do Java instalada não é compatível com esta versão do Minecraft. Reinstale a JRE recomendada para este servidor nas configurações.",
        "The installed Java version isn't compatible with this Minecraft version. Reinstall the JRE recommended for this server in the settings."
    ),
    "mc.portInUse.title" => ("Porta já em uso", "Port already in use"),
    "mc.portInUse.message" => (
        "Não foi possível abrir a porta do servidor porque ela já está sendo usada por outro processo. Fecha o processo ou altere a porta do servidor nas configurações.",
        "Couldn't open the server port because it's already being used by another process. Close that process or change the server port in the settings."
    ),
    "mc.eula.title" => ("EULA não aceito", "EULA not accepted"),
    "mc.eula.message" => (
        "O arquivo eula.txt não está marcado como aceito. Isso normalmente é feito automaticamente pelo Cubicase — se persistir, abra a pasta do servidor e defina eula=true em eula.txt.",
        "The eula.txt file isn't marked as accepted. Cubicase normally does this automatically — if it persists, open the server folder and set eula=true in eula.txt."
    ),
    "mc.portBusy" => (
        "A porta {port} já está em uso por outro processo. Pare-o ou altere a porta do servidor antes de iniciar.",
        "Port {port} is already in use by another process. Stop it or change the server port before starting."
    ),
    "mc.notRunning" => ("Nenhum servidor Minecraft está em execução.", "No Minecraft server is running."),
    "mc.installerPath" => ("Caminho do instalador inválido", "Invalid installer path"),
    "mc.forgeTimeout" => ("Instalador do Forge excedeu o tempo limite de 10 minutos.", "The Forge installer exceeded the 10-minute time limit."),
    "mc.forgeWait" => ("Erro ao aguardar instalador do Forge: {error}", "Error waiting for the Forge installer: {error}"),
    "mc.forgeFailed" => ("Instalador do Forge falhou com código: {code}", "The Forge installer failed with code: {code}"),
    "mc.forgeFailedClient" => (
        "Instalador do Forge falhou com código: {code}. Se você nunca abriu o Minecraft Launcher neste computador, abra-o pelo menos uma vez e tente de novo.",
        "The Forge installer failed with code: {code}. If you've never opened the Minecraft Launcher on this computer, open it at least once and try again."
    ),
    "mc.forgeNoVersion" => ("O instalador do Forge rodou, mas não encontramos a versão instalada em versions/.", "The Forge installer ran, but we couldn't find the installed version in versions/."),
    "mc.fabricTimeout" => ("Instalador do Fabric excedeu o tempo limite de 5 minutos.", "The Fabric installer exceeded the 5-minute time limit."),
    "mc.fabricWait" => ("Erro ao aguardar instalador do Fabric: {error}", "Error waiting for the Fabric installer: {error}"),
    "mc.fabricFailed" => ("Instalador do Fabric falhou com código: {code}", "The Fabric installer failed with code: {code}"),
    "mc.fabricNoVersion" => ("O instalador do Fabric rodou, mas não encontramos a versão instalada em versions/.", "The Fabric installer ran, but we couldn't find the installed version in versions/."),
    "mc.installNotFound" => ("Não encontramos sua instalação do Minecraft.", "We couldn't find your Minecraft installation."),
    "err.iconOpen" => ("Não foi possível abrir a imagem: {error}", "Couldn't open the image: {error}"),
    "err.iconSave" => ("Não foi possível salvar o ícone: {error}", "Couldn't save the icon: {error}"),
    "err.modNotFound" => ("Mod não encontrado: {file}", "Mod not found: {file}"),

    // ---------- Backups do mundo ----------
    "backupsDir.notAbsolute" => ("Escolha o caminho completo de uma pasta.", "Pick the full path of a folder."),
    "backupsDir.driveRoot" => ("Escolha uma pasta, não o disco inteiro.", "Pick a folder, not a whole drive."),
    "backupsDir.insideServers" => ("Esta pasta fica dentro da pasta de um servidor: apagar o servidor apagaria os backups junto. Escolha outra.", "This folder is inside a server folder: deleting the server would delete the backups too. Pick another one."),
    "backupsDir.notWritable" => ("Não consegui gravar nessa pasta: {error}", "Couldn't write to that folder: {error}"),
    "backupsDir.targetExists" => ("Já existe uma pasta de backups chamada \"{name}\".", "A backups folder named \"{name}\" already exists."),
    "backup.alreadyRunning" => ("Já existe um backup em andamento. Aguarde terminar.", "A backup is already running. Wait for it to finish."),
    "backup.noWorld" => ("Nenhuma pasta de mundo encontrada para fazer backup.", "No world folder found to back up."),
    "backup.preUpgradePrefix" => ("ANTES-DE-ATUALIZAR_", "BEFORE-UPGRADE_"),
    "upgrade.err.invalidDir" => ("Pasta de servidor inválida.", "Invalid server folder."),
    "upgrade.err.busy" => ("Já existe uma atualização ou exportação em andamento neste servidor.", "An upgrade or export is already running for this server."),
    "upgrade.err.notStarted" => ("A atualização não foi iniciada ou expirou. Comece de novo.", "The upgrade wasn't started or has expired. Start again."),
    "upgrade.err.blocksStart" => ("Este servidor está sendo atualizado. Aguarde terminar para iniciá-lo.", "This server is being upgraded. Wait for it to finish before starting it."),
    "upgrade.err.invalidPlan" => ("Plano de atualização inválido.", "Invalid upgrade plan."),
    "upgrade.err.backupFailed" => ("Não foi possível fazer o backup completo antes de atualizar ({error}). Nada foi alterado.", "Couldn't make the full backup before upgrading ({error}). Nothing was changed."),
    "upgrade.err.missingStaged" => ("Arquivo preparado não encontrado: {file}", "Prepared file not found: {file}"),
    "upgrade.err.metaUnreadable" => ("Não foi possível ler o cubicase-meta.json do servidor ({error}).", "Couldn't read the server's cubicase-meta.json ({error})."),
    "upgrade.err.rolledBack" => ("A atualização falhou ({error}). Tudo foi desfeito: o servidor continua como estava.", "The upgrade failed ({error}). Everything was undone: the server is as it was."),
    "upgrade.err.rollbackFailed" => ("A atualização falhou ({error}) e não foi possível desfazer tudo. Arquivos para conferir: {files}. Se o servidor não iniciar, restaure o backup completo.", "The upgrade failed ({error}) and not everything could be undone. Files to check: {files}. If the server won't start, restore the full backup."),
    "world.err.invalidName" => ("Nome de mundo inválido. Use letras, números, espaços, hífen ou sublinhado (até 64 caracteres) e não use o nome de uma pasta do servidor.", "Invalid world name. Use letters, numbers, spaces, hyphens or underscores (up to 64 characters) and avoid server folder names."),
    "world.err.invalidSeed" => ("Seed inválida (use até 64 caracteres, sem quebra de linha).", "Invalid seed (up to 64 characters, no line breaks)."),
    "world.err.datapackDir" => ("Este datapack é uma pasta; para desativar, remova-o da lista.", "This datapack is a folder; remove it from the list to disable it."),
    "world.err.datapackExists" => ("Já existe um arquivo com o nome que o datapack teria depois da troca.", "A file already exists with the name the datapack would get after the change."),
    "world.err.notAWorld" => ("A pasta {name} não é um mundo (não tem level.dat).", "The folder {name} isn't a world (no level.dat)."),
    "world.err.badZip" => ("Escolha um arquivo .zip válido.", "Pick a valid .zip file."),
    "world.err.noLevelDat" => ("Não encontrei um mundo neste zip (nenhum level.dat). Escolha o zip do mundo inteiro.", "I couldn't find a world in this zip (no level.dat). Pick the zip of the whole world."),
    "world.err.multipleWorlds" => ("Este zip tem mais de um mundo. Extraia o que você quer e compacte só aquela pasta.", "This zip has more than one world. Extract the one you want and zip only that folder."),
    "world.err.tooBig" => ("O mundo deste zip é grande demais para importar.", "The world in this zip is too big to import."),
    "world.err.nameExists" => ("Já existe uma pasta chamada {name} neste servidor. Escolha outro nome.", "A folder named {name} already exists on this server. Pick another name."),
    "backup.preResetPrefix" => ("ANTES-DO-RESET_", "BEFORE-RESET_"),
    "backup.preRestorePrefix" => ("ANTES-DE-RESTAURAR_", "BEFORE-RESTORE_"),
    "backup.restoreBackupFailed" => ("Não foi possível criar o backup de segurança do mundo atual antes de restaurar ({error}). Nada foi alterado.", "Couldn't create the safety backup of the current world before restoring ({error}). Nothing was changed."),
    "backup.resetBackupFailed" => ("Não foi possível criar o backup de segurança antes do reset ({error}). O mundo NÃO foi apagado.", "Couldn't create the safety backup before the reset ({error}). The world was NOT erased."),
    "backup.resetPartial" => ("O reset ficou incompleto ({error}). O backup de segurança de antes do reset está salvo: {backup}", "The reset didn't finish ({error}). The pre-reset safety backup is saved: {backup}"),
    "backup.noWorldReset" => ("Nenhuma pasta de mundo encontrada para resetar.", "No world folder found to reset."),
    "backup.notFound" => ("Backup não encontrado: {file}", "Backup not found: {file}"),
    "backup.openFailed" => ("Não foi possível abrir o backup: {error}", "Couldn't open the backup: {error}"),
    "backup.corrupted" => ("Backup corrompido ou inválido — mundo atual preservado: {error}", "Corrupted or invalid backup — current world preserved: {error}"),
    "backup.corruptedEntry" => ("Backup corrompido (entrada {index} ilegível) — mundo atual preservado: {error}", "Corrupted backup (entry {index} unreadable) — current world preserved: {error}"),
    "backup.prepareFailed" => ("Não foi possível preparar a restauração (mundo atual preservado): {error}", "Couldn't prepare the restore (current world preserved): {error}"),
    "backup.extractFailed" => ("Falha ao extrair o backup — mundo original restaurado: {error}", "Failed to extract the backup — original world restored: {error}"),
    "backup.restoreRollbackFailed" => (
        "Falha ao extrair o backup, e não foi possível restaurar o mundo original automaticamente (talvez travado por outro programa, como um antivírus). SEU MUNDO ORIGINAL NÃO FOI PERDIDO: ele está preservado em \"{staging}\" — mova essa pasta de volta manualmente. Erro da extração: {error}",
        "Failed to extract the backup, and the original world couldn't be restored automatically (it may be locked by another program, such as antivirus software). YOUR ORIGINAL WORLD WAS NOT LOST: it's preserved at \"{staging}\" — move that folder back manually. Extraction error: {error}"
    ),

    // ---------- Jogadores ----------
    "players.mojangNotFound" => ("Jogador \"{name}\" não encontrado (verifique o nome da conta Minecraft/Microsoft).", "Player \"{name}\" not found (check the Minecraft/Microsoft account name)."),
    "players.mojangHttp" => ("Falha ao consultar a API da Mojang: HTTP {status}", "Failed to query the Mojang API: HTTP {status}"),
    "players.alreadyWhitelisted" => ("\"{name}\" já está na whitelist.", "\"{name}\" is already on the whitelist."),
    "players.whitelistNotFound" => ("Jogador não encontrado na whitelist.", "Player not found on the whitelist."),
    "players.alreadyOp" => ("\"{name}\" já é operador.", "\"{name}\" is already an operator."),
    "players.opNotFound" => ("Operador não encontrado.", "Operator not found."),
    "players.alreadyBanned" => ("\"{name}\" já está banido.", "\"{name}\" is already banned."),
    "players.banNotFound" => ("Banimento não encontrado.", "Ban not found."),
    "players.ipAlreadyBanned" => ("O IP \"{ip}\" já está banido.", "The IP \"{ip}\" is already banned."),
    "players.ipBanNotFound" => ("Banimento de IP não encontrado.", "IP ban not found."),

    // ---------- Modpacks ----------
    "modpack.manifestInvalid" => ("manifest.json inválido: {error}", "Invalid manifest.json: {error}"),
    "modpack.noLoader" => ("Modpack não especifica um mod loader (Forge/Fabric/NeoForge).", "The modpack doesn't specify a mod loader (Forge/Fabric/NeoForge)."),
    "modpack.loaderParse" => ("Não foi possível interpretar o mod loader \"{loader}\".", "Couldn't parse the mod loader \"{loader}\"."),
    "modpack.loaderUnsupported" => ("Mod loader \"{loader}\" não é suportado pelo CubeForge.", "Mod loader \"{loader}\" isn't supported by CubeForge."),
    "modpack.indexInvalid" => ("modrinth.index.json inválido: {error}", "Invalid modrinth.index.json: {error}"),
    "modpack.noMcVersion" => ("Modpack não especifica a versão do Minecraft.", "The modpack doesn't specify the Minecraft version."),
    "modpack.quilt" => ("Modpacks Quilt não são suportados pelo CubeForge no momento.", "Quilt modpacks aren't supported by CubeForge at the moment."),
    "modpack.noSupportedLoader" => ("Modpack não especifica um mod loader suportado (Forge/Fabric/NeoForge).", "The modpack doesn't specify a supported mod loader (Forge/Fabric/NeoForge)."),
    "modpack.notAModpack" => (
        "Arquivo não é um modpack CurseForge (.zip) ou Modrinth (.mrpack) válido — manifest.json ou modrinth.index.json não encontrado.",
        "The file isn't a valid CurseForge (.zip) or Modrinth (.mrpack) modpack — manifest.json or modrinth.index.json not found."
    ),

    // ---------- Modrinth / API Central ----------
    "err.modrinthQuery" => ("Falha ao consultar o Modrinth: {error}", "Failed to query Modrinth: {error}"),
    "err.modrinthHttp" => ("Modrinth respondeu HTTP {status}", "Modrinth responded with HTTP {status}"),
    "err.modrinthUnexpected" => ("Resposta inesperada do Modrinth: {error}", "Unexpected response from Modrinth: {error}"),
    "err.connectionFailed" => ("Falha de conexão: {error}", "Connection failed: {error}"),
    "err.shortCodeRequired" => ("shortCode obrigatório", "shortCode required"),
    "err.queued" => ("Operação enfileirada.", "Operation queued."),
    "err.queuedForSync" => ("Operação enfileirada para sincronização.", "Operation queued for syncing."),
    "err.queuedWithError" => ("Operação enfileirada: {error}", "Operation queued: {error}"),
    "err.noNewShortCode" => ("Resposta da API sem o novo shortCode", "API response missing the new shortCode"),
    "err.neverTried" => ("Nunca tentado", "Never attempted"),
    "err.networkTimeout" => ("Timeout de {seconds}s esperando a rede (tentativa {attempt}/{max})", "Timed out after {seconds}s waiting for the network (attempt {attempt}/{max})"),
    "err.wakeNoJava" => (
        "Java ainda não instalado para este servidor — inicie-o manualmente pelo menos uma vez antes de ativar o modo de espera.",
        "Java isn't installed for this server yet — start it manually at least once before enabling standby mode."
    ),

    // ---------- Sessão / API client / providers ----------
    "session.invalidTransition" => ("Transição inválida: {from} → {to}", "Invalid transition: {from} → {to}"),
    "session.busy" => ("Já existe uma operação em andamento. Pare a sessão atual antes de iniciar outra.", "An operation is already in progress. Stop the current session before starting another one."),
    "session.internal" => ("Erro interno: {error}", "Internal error: {error}"),
    "api.requestFailed" => ("Falha na requisição: {error}", "Request failed: {error}"),
    "api.parseFailed" => ("Falha ao parsear resposta: {error}", "Failed to parse the response: {error}"),
    "api.noData" => ("Resposta da API não contém 'data'", "The API response has no 'data'"),
    "api.sessionDeserialize" => ("Falha ao desserializar sessão: {error}", "Failed to deserialize the session: {error}"),
    "api.noDataShort" => ("Resposta não contém 'data'", "The response has no 'data'"),
    "provider.launcherUnsupported" => ("Launcher '{launcher}' não é suportado pelo ProviderManager.", "Launcher '{launcher}' isn't supported by the ProviderManager."),
    "provider.dataDir" => ("Erro ao obter data_dir: {error}", "Error getting data_dir: {error}"),
    "provider.dataDirCreate" => ("Erro ao criar data_dir: {error}", "Error creating data_dir: {error}"),
    "provider.serializeConfig" => ("Erro ao serializar config: {error}", "Error serializing config: {error}"),
    "provider.tempFile" => ("Erro ao criar arquivo temp: {error}", "Error creating temp file: {error}"),
    "provider.writeConfig" => ("Erro ao escrever config: {error}", "Error writing config: {error}"),
    "provider.createSidecar" => ("Erro ao criar sidecar: {error}", "Error creating sidecar: {error}"),
    "provider.spawnSidecar" => ("Erro ao spawnar sidecar: {error}", "Error spawning sidecar: {error}"),
    "provider.mockNoSidecar" => ("Mock provider não requer sidecar. Use o fluxo mock diretamente.", "The mock provider doesn't need a sidecar. Use the mock flow directly."),

    // ---------- Pacotes .cubicase (exportar/importar servidor) ----------
    "pack.cancelled" => ("Operação cancelada.", "Operation cancelled."),
    "pack.err.busy" => ("Já existe uma exportação ou importação em andamento. Aguarde terminar ou cancele.", "An export or import is already in progress. Wait for it to finish or cancel it."),
    "pack.err.exportingBlocksStart" => ("Este servidor está sendo exportado agora. Aguarde a exportação terminar para iniciá-lo.", "This server is being exported right now. Wait for the export to finish before starting it."),
    "pack.err.pendingBlocksStart" => ("Este servidor foi importado de um pacote leve e ainda faltam mods. Abra o gerenciamento do servidor e clique em \"Completar agora\" (é preciso ter internet).", "This server was imported from a light pack and mods are still missing. Open the server management panel and click \"Complete now\" (internet is needed)."),
    "pack.err.badMode" => ("Modo de pacote inválido: {mode}.", "Invalid pack mode: {mode}."),
    "pack.err.serverMissing" => ("A pasta do servidor não foi encontrada.", "The server folder wasn't found."),
    "pack.err.serverExternal" => ("O Minecraft parece estar rodando fora do Cubicase (processo Java {pid} usando esta pasta). Feche-o por completo antes de exportar.", "Minecraft seems to be running outside Cubicase (Java process {pid} is using this folder). Close it completely before exporting."),
    "pack.err.serverStartedDuring" => ("O servidor foi iniciado durante a exportação (processo Java {pid}). O pacote foi descartado para não sair com o mundo corrompido. Feche o servidor e exporte de novo.", "The server was started during the export (Java process {pid}). The pack was discarded so it wouldn't contain a corrupted world. Close the server and export again."),
    "pack.err.serverStartedAfter" => ("O mundo mudou enquanto o pacote era criado (o servidor provavelmente foi iniciado). O pacote foi descartado. Feche o servidor e exporte de novo.", "The world changed while the pack was being created (the server was probably started). The pack was discarded. Close the server and export again."),
    "pack.err.changedDuring" => ("O arquivo \"{file}\" mudou durante a exportação. Feche qualquer programa que esteja usando o servidor e tente de novo.", "The file \"{file}\" changed during the export. Close any program that is using the server and try again."),
    "pack.err.destExtension" => ("O arquivo de destino precisa terminar em .cubicase.", "The destination file must end in .cubicase."),
    "pack.err.destFolderMissing" => ("A pasta de destino não existe.", "The destination folder doesn't exist."),
    "pack.err.destInsideServer" => ("O destino não pode ficar dentro da pasta do próprio servidor. Escolha outra pasta.", "The destination can't be inside the server's own folder. Choose another folder."),
    "pack.err.destPathTooLong" => ("O caminho do arquivo de destino é longo demais para o Windows (máx. {max} caracteres). Escolha uma pasta mais curta (ex.: Documentos ou Área de Trabalho) ou um nome de arquivo menor.", "The destination file path is too long for Windows (max {max} characters). Choose a shorter folder (e.g. Documents or Desktop) or a shorter file name."),
    "pack.err.destNotWritable" => ("Não foi possível gravar na pasta de destino (sem permissão, somente leitura ou disco indisponível): {error}", "Couldn't write to the destination folder (no permission, read-only or disk unavailable): {error}"),
    "pack.err.destExists" => ("Já existe um arquivo com esse nome no destino.", "A file with that name already exists at the destination."),
    "pack.err.destIsFolder" => ("O destino escolhido é uma pasta, não um arquivo.", "The chosen destination is a folder, not a file."),
    "pack.err.staleTmp" => ("Não foi possível apagar um arquivo temporário antigo no destino: {error}", "Couldn't delete an old temporary file at the destination: {error}"),
    "pack.err.jreRequired" => ("O modo completo precisa do Java do servidor, mas ele não foi encontrado neste computador.", "Full mode needs the server's Java, but it wasn't found on this computer."),
    "pack.err.jreIncomplete" => ("A instalação do Java deste computador está incompleta. Inicie o servidor uma vez (ou reinstale o Java) e tente de novo.", "This computer's Java installation is incomplete. Start the server once (or reinstall Java) and try again."),
    "pack.err.walk" => ("Não foi possível ler uma pasta do servidor: {error}", "Couldn't read a server folder: {error}"),
    "pack.err.readFile" => ("Não foi possível ler o arquivo \"{file}\" (talvez esteja em uso por outro programa): {error}", "Couldn't read the file \"{file}\" (it may be in use by another program): {error}"),
    "pack.err.unsafeName" => ("O arquivo \"{file}\" tem um nome que o pacote não consegue guardar com segurança (caracteres inválidos, nome reservado do Windows ou espaço/ponto no fim). Renomeie-o e tente de novo.", "The file \"{file}\" has a name the pack can't store safely (invalid characters, reserved Windows name, or trailing space/dot). Rename it and try again."),
    "pack.err.diskFull" => ("O disco ficou sem espaço durante a gravação. O arquivo parcial foi apagado. Libere espaço ou escolha outro disco.", "The disk ran out of space while writing. The partial file was deleted. Free up space or choose another disk."),
    "pack.err.writeFailed" => ("Falha ao gravar o arquivo: {error}", "Failed to write the file: {error}"),
    "pack.err.noSpaceExport" => ("Espaço insuficiente no destino: o pacote pode precisar de até {need}, e há {free} livres (faltam {missing}). Libere espaço ou escolha outro disco.", "Not enough space at the destination: the pack may need up to {need}, and {free} is free ({missing} short). Free up space or choose another disk."),
    "pack.err.verifyFailed" => ("A verificação do pacote recém-criado falhou ({error}). O arquivo foi descartado.", "Verification of the newly created pack failed ({error}). The file was discarded."),
    "pack.err.replaceFailed" => ("Não foi possível substituir o arquivo existente: {error}", "Couldn't replace the existing file: {error}"),
    "pack.err.renameFailed" => ("Não foi possível concluir o arquivo final: {error}", "Couldn't finalize the file: {error}"),
    "pack.err.openPack" => ("Não foi possível abrir o pacote: {error}", "Couldn't open the pack: {error}"),
    "pack.err.notAPack" => ("Este arquivo não é um pacote .cubicase válido ({error}).", "This file isn't a valid .cubicase pack ({error})."),
    "pack.err.noManifest" => ("Este arquivo não é um pacote .cubicase (falta o manifesto).", "This file isn't a .cubicase pack (the manifest is missing)."),
    "pack.err.manifestInvalid" => ("O manifesto do pacote está corrompido: {error}", "The pack's manifest is corrupted: {error}"),
    "pack.err.newerFormat" => ("Este pacote foi criado por uma versão mais nova do Cubicase. Atualize o Cubicase para importá-lo.", "This pack was created by a newer version of Cubicase. Update Cubicase to import it."),
    "pack.err.tooManyEntries" => ("O pacote tem arquivos demais para ser seguro de importar.", "The pack has too many files to be safe to import."),
    "pack.err.tooBig" => ("O conteúdo do pacote é maior que o limite de segurança ({max}).", "The pack's contents exceed the safety limit ({max})."),
    "pack.err.unsafeEntry" => ("Pacote recusado: contém um caminho inseguro (\"{name}\"). Não importe arquivos .cubicase de fontes em que você não confia.", "Pack rejected: it contains an unsafe path (\"{name}\"). Don't import .cubicase files from sources you don't trust."),
    "pack.err.duplicateEntry" => ("Pacote recusado: o arquivo \"{name}\" aparece mais de uma vez.", "Pack rejected: the file \"{name}\" appears more than once."),
    "pack.err.symlinkEntry" => ("Pacote recusado: contém um link simbólico (\"{name}\").", "Pack rejected: it contains a symbolic link (\"{name}\")."),
    "pack.err.manifestMismatch" => ("O pacote está corrompido ou foi alterado: o conteúdo não bate com o manifesto.", "The pack is corrupted or was tampered with: its contents don't match the manifest."),
    "pack.err.declaredSizeExceeded" => ("Pacote recusado: \"{name}\" é maior do que o tamanho declarado.", "Pack rejected: \"{name}\" is larger than its declared size."),
    "pack.err.corruptEntry" => ("O pacote está corrompido: não foi possível ler \"{name}\" ({error}).", "The pack is corrupted: couldn't read \"{name}\" ({error})."),
    "pack.err.nameEmpty" => ("Informe um nome para o servidor.", "Enter a name for the server."),
    "pack.err.nameInvalid" => ("O nome \"{name}\" não é válido para uma pasta no Windows.", "The name \"{name}\" isn't valid for a Windows folder."),
    "pack.err.nameExists" => ("Já existe um servidor chamado \"{name}\". Escolha outro nome.", "A server named \"{name}\" already exists. Choose another name."),
    "pack.err.pathTooLong" => ("O caminho ficaria longo demais para o Windows (máx. {max} caracteres, contando o maior arquivo do pacote). Use um nome de servidor de até {allowed} caracteres.", "The path would be too long for Windows (max {max} characters, counting the pack's longest file). Use a server name of up to {allowed} characters."),
    "pack.err.noSpaceImport" => ("Espaço insuficiente para importar: são necessários cerca de {need}, e há {free} livres (faltam {missing}). Libere espaço e tente de novo.", "Not enough space to import: about {need} is needed, and {free} is free ({missing} short). Free up space and try again."),
    "pack.warn.jrePathTooLong" => ("O Java do pacote não foi instalado porque o caminho ficaria longo demais. Ele será baixado depois, se houver internet.", "The pack's Java wasn't installed because the path would be too long. It will be downloaded later if there's internet."),

    // ---------- Hospedagem unificada (servidor + rede) ----------
    "hosting.err.noJava" => ("O Java deste servidor não foi encontrado. Reinicie o app ou reinstale o Java e tente de novo.", "This server's Java wasn't found. Restart the app or reinstall Java and try again."),
    "hosting.err.noServerDir" => ("A pasta do servidor não existe mais: {dir}", "The server folder no longer exists: {dir}"),
    "hosting.err.alreadyRunning" => ("Já existe um servidor sendo hospedado. Pare-o antes de iniciar outro.", "A server is already being hosted. Stop it before starting another."),
    "hosting.err.notRunning" => ("Nenhum servidor está sendo hospedado agora.", "No server is being hosted right now."),
    "hosting.err.stopping" => ("O servidor está sendo parado. Aguarde terminar.", "The server is being stopped. Wait for it to finish."),
}
