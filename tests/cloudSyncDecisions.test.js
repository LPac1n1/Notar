import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UPLOAD_RETRY_DELAYS_MS,
  hasRemoteVersionChanged,
  isAlreadyExistsError,
  isObjectNotFoundError,
  nextUploadRetryDelay,
  pickServerVersion,
  pickSnapshotVersion,
  shouldFlushOnHide,
} from "../src/services/db/cloudSyncDecisions.js";

// Estas decisões governam a sincronização. Errar qualquer uma delas custa
// DADO do usuário, não só uma tela errada — por isso os casos abaixo focam
// nos modos de falha, não no caminho feliz.

test("only a genuine not-found is treated as first use", () => {
  // Caminho canônico do primeiro acesso: o objeto ainda não existe.
  assert.equal(isObjectNotFoundError({ status: 404 }), true);
  assert.equal(isObjectNotFoundError({ statusCode: "404" }), true);
  assert.equal(isObjectNotFoundError({ message: "Object not found" }), true);
  assert.equal(isObjectNotFoundError({ message: "The resource was not found" }), true);
  assert.equal(isObjectNotFoundError({ message: "Request failed with 404" }), true);
});

test("real failures must NOT be mistaken for an empty bucket", () => {
  // Este é o cenário de perda de dado: se um destes fosse classificado como
  // "não encontrado", o app hidrataria vazio e o próximo flush subiria esse
  // vazio por cima do snapshot bom que está no servidor.
  const dangerous = [
    { status: 401, message: "Unauthorized" },
    { status: 403, message: "new row violates row-level security policy" },
    { status: 500, message: "Internal Server Error" },
    { message: "Failed to fetch" },
    { message: "NetworkError when attempting to fetch resource" },
    { message: "JWT expired" },
    { message: "signature verification failed" },
  ];

  for (const error of dangerous) {
    assert.equal(
      isObjectNotFoundError(error),
      false,
      `não deveria tratar como primeiro uso: ${JSON.stringify(error)}`,
    );
  }
});

test("missing or malformed errors never silently pass as not-found", () => {
  assert.equal(isObjectNotFoundError(null), false);
  assert.equal(isObjectNotFoundError(undefined), false);
  assert.equal(isObjectNotFoundError({}), false);
  assert.equal(isObjectNotFoundError({ message: "" }), false);
});

test("conflict needs both sides known", () => {
  // Sem âncora local (primeira sessão) ou sem versão remota (objeto ainda não
  // existe) não há comparação possível. Chamar isso de conflito travaria a
  // sincronização de um usuário novo — que nunca conseguiria o primeiro
  // upload.
  assert.equal(hasRemoteVersionChanged(null, "2026-08-01T10:00:00Z"), false);
  assert.equal(hasRemoteVersionChanged("2026-08-01T10:00:00Z", null), false);
  assert.equal(hasRemoteVersionChanged(null, null), false);
  assert.equal(hasRemoteVersionChanged("", ""), false);
});

test("conflict is exactly a version mismatch", () => {
  const known = "2026-08-01T10:00:00Z";
  assert.equal(hasRemoteVersionChanged(known, known), false);
  assert.equal(hasRemoteVersionChanged(known, "2026-08-01T10:05:00Z"), true);
});

test("a versão da nuvem é a do índice; sem índice, a do arquivo antigo", () => {
  const names = { manifestName: "manifest.json", legacyName: "dados.json" };
  const legacy = { name: "dados.json", updated_at: "2026-09-27T10:00:00Z" };
  const manifest = { name: "manifest.json", updated_at: "2026-10-02T18:00:00Z" };

  assert.equal(pickServerVersion([], names), null);
  assert.equal(pickServerVersion([legacy], names), "legacy:2026-09-27T10:00:00Z");
  // Com os dois presentes vale o índice: o arquivo antigo é só o aviso que
  // ficou no lugar.
  assert.equal(
    pickServerVersion([legacy, manifest, { name: "parts" }], names),
    "manifest:2026-10-02T18:00:00Z",
  );

  // Migrar é mudar de versão — quem conhecia só o arquivo antigo precisa
  // perceber que o banco passou a ser outro.
  assert.equal(
    hasRemoteVersionChanged(
      pickServerVersion([legacy], names),
      pickServerVersion([legacy, manifest], names),
    ),
    true,
  );
});

test("cópia cujo destino já existe é reconhecida, e só ela", () => {
  assert.equal(isAlreadyExistsError({ status: 409 }), true);
  assert.equal(isAlreadyExistsError({ statusCode: "409" }), true);
  assert.equal(isAlreadyExistsError({ message: "The resource already exists" }), true);
  assert.equal(isAlreadyExistsError({ message: "Duplicate" }), true);

  // Qualquer outra falha na cópia NÃO pode ser lida como "já copiado": o
  // passo seguinte troca o arquivo antigo pelo aviso.
  for (const error of [
    null,
    {},
    { status: 400, message: "Object not found" },
    { status: 403, message: "new row violates row-level security policy" },
    { status: 500, message: "Internal Server Error" },
    { message: "Failed to fetch" },
  ]) {
    assert.equal(isAlreadyExistsError(error), false, JSON.stringify(error));
  }
});

test("hide-time flush requires configuration, a user and pending work", () => {
  const base = { isConfigured: true, activeUserId: "u1", hasPendingWork: true };
  assert.equal(shouldFlushOnHide(base), true);

  assert.equal(shouldFlushOnHide({ ...base, isConfigured: false }), false);
  assert.equal(shouldFlushOnHide({ ...base, activeUserId: null }), false);
  assert.equal(shouldFlushOnHide({ ...base, hasPendingWork: false }), false);
  assert.equal(shouldFlushOnHide(), false);
});

test("snapshot version prefers updated_at and tolerates a fresh object", () => {
  const entries = [
    { name: "outro.json", updated_at: "2026-01-01T00:00:00Z" },
    { name: "dados.json", updated_at: "2026-08-01T10:00:00Z", created_at: "2026-07-01T10:00:00Z" },
  ];
  assert.equal(pickSnapshotVersion(entries, "dados.json"), "2026-08-01T10:00:00Z");

  // Objeto recém-criado pode vir sem updated_at.
  assert.equal(
    pickSnapshotVersion(
      [{ name: "dados.json", created_at: "2026-07-01T10:00:00Z" }],
      "dados.json",
    ),
    "2026-07-01T10:00:00Z",
  );

  // Ausente / listagem vazia => sem versão (e, portanto, sem conflito).
  assert.equal(pickSnapshotVersion([], "dados.json"), null);
  assert.equal(pickSnapshotVersion(null, "dados.json"), null);
  assert.equal(
    pickSnapshotVersion([{ name: "outro.json" }], "dados.json"),
    null,
  );
});

// Uma falha de upload já entrou em laço uma vez: o registro do erro agendava
// outro upload, que falhava de novo, a cada 2 s, exportando o banco inteiro.
// As tentativas automáticas precisam ESPAÇAR e precisam ACABAR.
test("as novas tentativas de upload espaçam cada vez mais", () => {
  const delays = [1, 2, 3, 4, 5].map((failures) => nextUploadRetryDelay(failures));

  assert.deepEqual(delays, UPLOAD_RETRY_DELAYS_MS);
  for (let index = 1; index < delays.length; index += 1) {
    assert.ok(
      delays[index] > delays[index - 1],
      "cada espera tem de ser maior que a anterior",
    );
  }
  // A primeira não pode ser curta a ponto de reproduzir o laço de 2 s.
  assert.ok(delays[0] >= 5_000);
});

test("as novas tentativas de upload acabam", () => {
  assert.equal(nextUploadRetryDelay(UPLOAD_RETRY_DELAYS_MS.length + 1), null);
  assert.equal(nextUploadRetryDelay(50), null);
});

test("sem falha registrada não há o que tentar de novo", () => {
  assert.equal(nextUploadRetryDelay(0), null);
  assert.equal(nextUploadRetryDelay(-1), null);
  assert.equal(nextUploadRetryDelay(undefined), null);
  assert.equal(nextUploadRetryDelay(1.5), null);
});

// Uma gravação feita com um upload já no ar não está no snapshot dele. Sem
// contar revisões, o app terminava esse upload, não via nada agendado e se
// dizia sincronizado com uma alteração só no navegador.
test("gravação posterior ao snapshot enviado conta como não sincronizada", async () => {
  const { hasUnsyncedRevision } = await import(
    "../src/services/db/cloudSyncDecisions.js"
  );

  // Gravou três vezes; o upload levou até a segunda.
  assert.equal(hasUnsyncedRevision(3, 2), true);
  // O upload levou tudo.
  assert.equal(hasUnsyncedRevision(3, 3), false);
  // Nada gravado ainda.
  assert.equal(hasUnsyncedRevision(0, 0), false);
});
