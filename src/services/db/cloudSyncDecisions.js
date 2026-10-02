/**
 * Decisões puras da sincronização com a nuvem, isoladas do orquestrador em
 * `cloudStorage.js` (que importa o cliente Supabase e o DuckDB e por isso não
 * carrega em Node).
 *
 * O que mora aqui são justamente os pontos em que errar custa DADO:
 * classificar um erro de download como "primeiro uso" e decidir se outro
 * dispositivo escreveu. Todos são testáveis sem rede.
 */

// Assinatura gzip (RFC 1952). Snapshots antigos, gravados antes da
// compressão, são JSON puro — a detecção por magic bytes é o que mantém a
// leitura compatível com os dois formatos.
export const GZIP_MAGIC_BYTES = [0x1f, 0x8b];

/**
 * O Supabase Storage devolve 400/404 quando o objeto não existe. Esse é o
 * caso canônico do primeiro acesso: não há snapshot ainda e o app deve seguir
 * com a base vazia.
 *
 * PERIGO: classificar um erro real (rede, permissão, token expirado) como
 * "não encontrado" faria o app hidratar vazio e, no primeiro flush, subir
 * esse vazio por cima dos dados bons. Por isso o casamento é restrito a
 * not-found e nada mais.
 */
export function isObjectNotFoundError(error) {
  if (!error) return false;

  const status = Number(error.status ?? error.statusCode ?? 0);
  if (status === 404) return true;

  const message = String(error.message ?? "").toLowerCase();
  if (!message) return false;

  return (
    message.includes("not found") ||
    message.includes("object not found") ||
    message.includes("404")
  );
}

/**
 * Houve escrita de outro dispositivo desde o último snapshot que vimos?
 *
 * Só afirma conflito quando os DOIS lados são conhecidos. Sem âncora local
 * (primeira sessão) ou sem versão remota (objeto ainda não existe) não há com
 * o que comparar — e tratar isso como conflito travaria a sincronização de um
 * usuário novo.
 */
export function hasRemoteVersionChanged(knownVersion, remoteVersion) {
  if (!knownVersion || !remoteVersion) return false;
  return knownVersion !== remoteVersion;
}

/**
 * O destino de uma cópia já existe? (HTTP 409 no armazenamento.)
 *
 * Usado ao guardar a cópia do arquivo antigo na migração: uma tentativa
 * anterior pode ter feito a cópia e falhado no passo seguinte. Nesse caso a
 * cópia que vale é a PRIMEIRA — refazê-la agora copiaria o aviso que já está
 * no lugar do arquivo, por cima do arquivo de verdade.
 */
export function isAlreadyExistsError(error) {
  if (!error) return false;

  const status = Number(error.status ?? error.statusCode ?? 0);
  if (status === 409) return true;

  const message = String(error.message ?? "").toLowerCase();
  return (
    message.includes("already exists") ||
    message.includes("duplicate") ||
    String(error.statusCode ?? "") === "409"
  );
}

/**
 * Vale disparar flush quando a página está indo para segundo plano?
 *
 * Diferente do `beforeunload`, aqui a página continua viva, então o upload
 * normal (sem limite de tamanho) funciona. Só não faz sentido disparar sem
 * usuário ativo ou sem trabalho pendente.
 */
export function shouldFlushOnHide({
  isConfigured = false,
  activeUserId = null,
  hasPendingWork = false,
} = {}) {
  return Boolean(isConfigured && activeUserId && hasPendingWork);
}

/**
 * Há gravação local que nenhum upload bem-sucedido levou?
 *
 * Cada gravação soma um à revisão local; cada upload registra a revisão que
 * o snapshot DELE continha. A diferença é o que ainda não está na nuvem.
 *
 * Existe porque "há um envio agendado ou em andamento" não responde a mesma
 * pergunta: uma gravação feita com um envio já no ar não está no snapshot
 * dele, e quando esse envio termina não sobra nada agendado — a alteração
 * ficava só no navegador, com o app dizendo "sincronizado".
 */
export function hasUnsyncedRevision(localRevision, uploadedRevision) {
  return Number(localRevision) > Number(uploadedRevision);
}

/**
 * Esperas entre as novas tentativas automáticas de upload, na ordem.
 *
 * Crescentes e FINITAS. Crescentes porque a falha mais comum é passageira
 * (rede) e resolve em segundos, mas a que não resolve — arquivo acima do
 * limite do armazenamento, por exemplo — não melhora insistindo: cada
 * tentativa exporta o banco inteiro e sobe dezenas de MB. Finitas porque,
 * esgotadas, quem decide tentar de novo é o usuário (nova alteração, voltar
 * à aba, "Sincronizar agora"), e não um laço.
 */
export const UPLOAD_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

/**
 * Quanto esperar antes da próxima tentativa, dado quantos uploads SEGUIDOS
 * já falharam. `null` quando as tentativas automáticas se esgotaram.
 */
export function nextUploadRetryDelay(consecutiveFailures) {
  const failures = Number(consecutiveFailures);
  if (!Number.isInteger(failures) || failures < 1) return null;
  return UPLOAD_RETRY_DELAYS_MS[failures - 1] ?? null;
}

/**
 * A versão do que está na nuvem, a partir da listagem da pasta do usuário.
 *
 * Com o formato em partes, quem diz qual é o banco é o ÍNDICE — a versão é a
 * dele. Sem índice, vale a do arquivo único antigo (conta que ainda não
 * migrou). O prefixo distingue os dois: sair do arquivo antigo para o índice
 * é uma mudança de versão, e precisa ser vista como tal.
 */
export function pickServerVersion(entries, { manifestName, legacyName }) {
  const manifestVersion = pickSnapshotVersion(entries, manifestName);
  if (manifestVersion) return `manifest:${manifestVersion}`;

  const legacyVersion = pickSnapshotVersion(entries, legacyName);
  return legacyVersion ? `legacy:${legacyVersion}` : null;
}

/**
 * Extrai a versão (timestamp) do objeto de snapshot na listagem do bucket.
 * `updated_at` é o campo natural; objetos recém-criados podem vir só com
 * `created_at`.
 */
export function pickSnapshotVersion(entries, objectName) {
  const entry = (entries ?? []).find((item) => item?.name === objectName);
  return entry?.updated_at ?? entry?.created_at ?? null;
}
