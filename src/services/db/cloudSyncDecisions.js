/**
 * Decisões puras da sincronização com a nuvem, isoladas do orquestrador em
 * `cloudStorage.js` (que importa o cliente Supabase e o DuckDB e por isso não
 * carrega em Node).
 *
 * O que mora aqui são justamente os pontos em que errar custa DADO:
 * classificar um erro de download como "primeiro uso", decidir se outro
 * dispositivo escreveu, e decidir se o corpo cabe no envio que sobrevive ao
 * fechamento da aba. Todos são testáveis sem rede.
 */

// Navegadores limitam o corpo de `fetch(..., { keepalive: true })` em ~64KB.
// Ficamos abaixo com folga para o pedido não ser descartado pelo navegador.
export const KEEPALIVE_BODY_LIMIT_BYTES = 60_000;

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
 * O corpo cabe no envio com `keepalive` (o único que pode ser concluído
 * depois que a página fecha)?
 */
export function fitsKeepaliveBudget(byteSize) {
  const size = Number(byteSize);
  if (!Number.isFinite(size) || size < 0) return false;
  return size <= KEEPALIVE_BODY_LIMIT_BYTES;
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
 * Extrai a versão (timestamp) do objeto de snapshot na listagem do bucket.
 * `updated_at` é o campo natural; objetos recém-criados podem vir só com
 * `created_at`.
 */
export function pickSnapshotVersion(entries, objectName) {
  const entry = (entries ?? []).find((item) => item?.name === objectName);
  return entry?.updated_at ?? entry?.created_at ?? null;
}
