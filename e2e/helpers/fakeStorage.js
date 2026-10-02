import { Buffer } from "node:buffer";
import http from "node:http";
import zlib from "node:zlib";

/**
 * Supabase Storage de mentira, para exercitar a sincronização de verdade.
 *
 * O resto da suíte roda com `VITE_NOTAR_AUTH_MODE=local`, em que o Supabase
 * nem é inicializado — nenhum daqueles testes passa por hidratação, upload
 * ou falha de rede. Este servidor responde só o que `cloudStorage.js` usa
 * (listar, baixar e enviar um objeto), e o segundo servidor de dev do
 * `playwright.config.js` aponta para ele.
 *
 * O estado fica no processo do teste, então a especificação consegue tanto
 * preparar a nuvem (`seed`) quanto ler o que o app enviou (`uploads`).
 */

export const FAKE_STORAGE_PORT = 4175;
export const CLOUD_APP_URL = "http://127.0.0.1:4174";
export const FAKE_USER_ID = "usuario-e2e";

// O cliente do Supabase guarda a sessão em `sb-<primeiro rótulo do host>-auth-token`.
// Para `http://127.0.0.1:4175` o rótulo é "127".
const SESSION_STORAGE_KEY = "sb-127-auth-token";

const base64Url = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * Sessão que o cliente aceita sem ir à rede: não expirada e com a forma de
 * um JWT. Nenhum servidor valida a assinatura — o storage falso aceita
 * qualquer portador.
 */
export function buildFakeSession() {
  const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

  return {
    access_token: [
      base64Url({ alg: "HS256", typ: "JWT" }),
      base64Url({ sub: FAKE_USER_ID, exp: expiresAt, role: "authenticated" }),
      "assinatura",
    ].join("."),
    refresh_token: "renovacao-e2e",
    token_type: "bearer",
    expires_in: 24 * 60 * 60,
    expires_at: expiresAt,
    user: {
      id: FAKE_USER_ID,
      email: "e2e@example.test",
      aud: "authenticated",
      role: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
}

/** Faz a página nascer autenticada. Chamar antes do primeiro `goto`. */
export async function signInWithFakeSession(page) {
  await page.addInitScript(
    ([key, session]) => {
      window.localStorage.setItem(key, JSON.stringify(session));
    },
    [SESSION_STORAGE_KEY, buildFakeSession()],
  );
}

/** Extrai o arquivo do corpo multipart que o cliente do Supabase envia. */
function extractUploadedFile(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType ?? "")?.[1];
  if (!boundary) return body;

  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = 0;
  let file = null;

  for (;;) {
    const start = body.indexOf(delimiter, cursor);
    if (start === -1) break;
    const headerEnd = body.indexOf("\r\n\r\n", start);
    if (headerEnd === -1) break;
    const next = body.indexOf(delimiter, headerEnd);
    if (next === -1) break;

    const headers = body.subarray(start, headerEnd).toString("utf8");
    if (/filename=/.test(headers) || !file) {
      file = body.subarray(headerEnd + 4, next - 2);
    }
    cursor = next;
  }

  return file ?? body;
}

function decodeSnapshot(buffer) {
  const isGzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
  const text = (isGzip ? zlib.gunzipSync(buffer) : buffer).toString("utf8");
  return JSON.parse(text);
}

export async function startFakeStorage() {
  const state = {
    object: null,
    updatedAt: null,
    // Código HTTP com que todo upload é recusado; `null` aceita.
    rejectUploadsWith: null,
    // Quanto o servidor demora para concluir um upload aceito. Serve para
    // manter um envio "em andamento" enquanto o teste faz outra coisa.
    uploadDelayMs: 0,
    // Um registro por tentativa de upload, aceita ou não.
    attempts: [],
  };

  const server = http.createServer((request, response) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    };

    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }

    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const send = (status, payload, type = "application/json") => {
        response.writeHead(status, { ...cors, "content-type": type });
        response.end(
          type === "application/json" ? JSON.stringify(payload) : payload,
        );
      };
      const url = request.url ?? "";

      if (url.startsWith("/storage/v1/object/list/")) {
        send(
          200,
          state.object
            ? [
                {
                  name: "dados.json",
                  id: "objeto-e2e",
                  updated_at: state.updatedAt,
                  created_at: state.updatedAt,
                  metadata: {},
                },
              ]
            : [],
        );
        return;
      }

      if (url.startsWith("/storage/v1/object/") && request.method === "GET") {
        if (!state.object) {
          send(404, {
            statusCode: "404",
            error: "not_found",
            message: "Object not found",
          });
          return;
        }
        send(200, state.object, "application/octet-stream");
        return;
      }

      if (url.startsWith("/storage/v1/object/") && request.method === "POST") {
        const file = extractUploadedFile(body, request.headers["content-type"]);
        const accepted = state.rejectUploadsWith === null;
        state.attempts.push({
          at: Date.now(),
          accepted,
          bytes: file.length,
          finished: !accepted,
        });

        if (!accepted) {
          send(state.rejectUploadsWith, {
            statusCode: String(state.rejectUploadsWith),
            error: "Payload too large",
            message: "The object exceeded the maximum allowed size",
          });
          return;
        }

        const attempt = state.attempts.at(-1);
        setTimeout(() => {
          state.object = file;
          state.updatedAt = new Date().toISOString();
          attempt.finished = true;
          send(200, { Key: `notar/${FAKE_USER_ID}/dados.json`, Id: "objeto-e2e" });
        }, state.uploadDelayMs);
        return;
      }

      // Autenticação e o que mais o cliente consultar: a sessão do
      // `localStorage` já basta, então qualquer resposta válida serve.
      send(200, { id: FAKE_USER_ID, email: "e2e@example.test" });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(FAKE_STORAGE_PORT, "127.0.0.1", resolve);
  });

  return {
    /** Tentativas de upload, na ordem em que chegaram. */
    get attempts() {
      return state.attempts;
    },
    /** Uploads aceitos E já concluídos (o servidor pode estar demorando). */
    get acceptedUploads() {
      return state.attempts.filter(
        (attempt) => attempt.accepted && attempt.finished,
      ).length;
    },
    /** O snapshot que está "na nuvem", já decodificado; `null` se não há. */
    readStoredSnapshot() {
      return state.object ? decodeSnapshot(state.object) : null;
    },
    /** Deixa um snapshot pronto na nuvem, como se outro dispositivo o tivesse gravado. */
    seed(snapshot) {
      state.object = Buffer.from(JSON.stringify(snapshot), "utf8");
      state.updatedAt = new Date().toISOString();
    },
    rejectUploads(status) {
      state.rejectUploadsWith = status;
    },
    acceptUploads() {
      state.rejectUploadsWith = null;
    },
    delayUploads(milliseconds) {
      state.uploadDelayMs = milliseconds;
    },
    /** Como se outro dispositivo tivesse acabado de gravar por cima. */
    touchFromAnotherDevice() {
      state.updatedAt = new Date(Date.now() + 60_000).toISOString();
    },
    reset() {
      state.object = null;
      state.updatedAt = null;
      state.rejectUploadsWith = null;
      state.uploadDelayMs = 0;
      state.attempts = [];
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
