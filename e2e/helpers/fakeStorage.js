import { Buffer } from "node:buffer";
import http from "node:http";
import zlib from "node:zlib";

/**
 * Supabase Storage de mentira, para exercitar a sincronização de verdade.
 *
 * O resto da suíte roda com `VITE_NOTAR_AUTH_MODE=local`, em que o Supabase
 * nem é inicializado — nenhum daqueles testes passa por hidratação, upload
 * ou falha de rede. Este servidor responde só o que `cloudStorage.js` usa
 * (listar, baixar, enviar, copiar e apagar objetos), e o segundo servidor de
 * dev do `playwright.config.js` aponta para ele.
 *
 * O estado fica no processo do teste, então a especificação consegue tanto
 * preparar a nuvem (`seed`) quanto ler o que o app enviou.
 */

export const FAKE_STORAGE_PORT = 4175;
export const CLOUD_APP_URL = "http://127.0.0.1:4174";
export const FAKE_USER_ID = "usuario-e2e";

const LEGACY_PATH = `${FAKE_USER_ID}/dados.json`;
const MANIFEST_PATH = `${FAKE_USER_ID}/manifest.json`;
const PARTS_PREFIX = `${FAKE_USER_ID}/parts/`;
export const LEGACY_ARCHIVE_PATH = `${FAKE_USER_ID}/dados-formato-antigo.json`;

// Uploads separados por menos que isto contam como o MESMO envio: um envio
// do app são várias partes e, por último, o índice.
const BURST_GAP_MS = 1_500;

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

function decodeText(buffer) {
  const isGzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
  return (isGzip ? zlib.gunzipSync(buffer) : buffer).toString("utf8");
}

const NOT_FOUND = {
  statusCode: "404",
  error: "not_found",
  message: "Object not found",
};

export async function startFakeStorage() {
  const state = {
    // caminho (sem o bucket) → { body, createdAt, updatedAt }
    objects: new Map(),
    // Código HTTP com que todo upload é recusado; `null` aceita.
    rejectUploadsWith: null,
    // Quanto o servidor demora para concluir um upload aceito, e de quê.
    // Serve para manter um envio "em andamento" enquanto o teste faz outra
    // coisa.
    uploadDelayMs: 0,
    uploadDelayOnlyManifest: false,
    // Um registro por tentativa de upload, aceita ou não.
    attempts: [],
    copies: [],
    removals: [],
  };

  const put = (path, body) => {
    const now = new Date().toISOString();
    const previous = state.objects.get(path);
    state.objects.set(path, {
      body,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    });
  };

  /** O que há diretamente dentro de uma pasta, como o Supabase lista. */
  const listFolder = (prefix) => {
    const base = prefix.replace(/\/+$/, "") + "/";
    const entries = new Map();

    for (const [path, object] of state.objects) {
      if (!path.startsWith(base)) continue;
      const rest = path.slice(base.length);
      const [name, ...deeper] = rest.split("/");

      if (deeper.length > 0) {
        // Pasta: sem id e sem datas.
        if (!entries.has(name)) {
          entries.set(name, {
            name,
            id: null,
            updated_at: null,
            created_at: null,
            metadata: null,
          });
        }
        continue;
      }

      entries.set(name, {
        name,
        id: `objeto-${name}`,
        updated_at: object.updatedAt,
        created_at: object.createdAt,
        metadata: { size: object.body.length },
      });
    }

    return [...entries.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
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
      const readJson = () => {
        try {
          return JSON.parse(body.toString("utf8") || "{}");
        } catch {
          return {};
        }
      };
      const url = decodeURIComponent((request.url ?? "").split("?")[0]);

      if (url.startsWith("/storage/v1/object/list/")) {
        const { prefix = "", limit = 100, offset = 0 } = readJson();
        send(200, listFolder(prefix).slice(offset, offset + limit));
        return;
      }

      if (url === "/storage/v1/object/copy" && request.method === "POST") {
        const { sourceKey, destinationKey } = readJson();
        const source = state.objects.get(sourceKey);
        state.copies.push({ sourceKey, destinationKey });

        if (!source) {
          send(404, NOT_FOUND);
          return;
        }
        if (state.objects.has(destinationKey)) {
          send(409, {
            statusCode: "409",
            error: "Duplicate",
            message: "The resource already exists",
          });
          return;
        }
        put(destinationKey, Buffer.from(source.body));
        send(200, { Key: `notar/${destinationKey}` });
        return;
      }

      const objectMatch = /^\/storage\/v1\/object\/([^/]+)(?:\/(.+))?$/.exec(url);

      if (objectMatch && request.method === "DELETE" && !objectMatch[2]) {
        const { prefixes = [] } = readJson();
        const removed = [];
        for (const path of prefixes) {
          if (state.objects.delete(path)) removed.push({ name: path });
        }
        state.removals.push(...prefixes);
        send(200, removed);
        return;
      }

      if (objectMatch && request.method === "GET") {
        const object = state.objects.get(objectMatch[2]);
        if (!object) {
          send(404, NOT_FOUND);
          return;
        }
        send(200, object.body, "application/octet-stream");
        return;
      }

      if (objectMatch && request.method === "POST" && objectMatch[2]) {
        const path = objectMatch[2];
        const file = extractUploadedFile(body, request.headers["content-type"]);
        const accepted = state.rejectUploadsWith === null;
        state.attempts.push({
          at: Date.now(),
          path,
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
        const delayed =
          !state.uploadDelayOnlyManifest || path === MANIFEST_PATH;
        setTimeout(
          () => {
            put(path, file);
            attempt.finished = true;
            send(200, { Key: `notar/${path}`, Id: `objeto-${path}` });
          },
          delayed ? state.uploadDelayMs : 0,
        );
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

  const finishedUploads = () =>
    state.attempts.filter((attempt) => attempt.accepted && attempt.finished);
  const readManifest = () => {
    const object = state.objects.get(MANIFEST_PATH);
    return object ? JSON.parse(decodeText(object.body)) : null;
  };

  return {
    /** Tentativas de upload de objeto, na ordem em que chegaram. */
    get attempts() {
      return state.attempts;
    },
    /**
     * Quantos ENVIOS o app tentou. Um envio são vários uploads seguidos
     * (as partes e o índice); uploads próximos contam como um só.
     */
    get uploadBursts() {
      let bursts = 0;
      let last = -Infinity;
      for (const attempt of state.attempts) {
        if (attempt.at - last > BURST_GAP_MS) bursts += 1;
        last = attempt.at;
      }
      return bursts;
    },
    /** Tentativas de gravar o índice — uma por envio que chegou até o fim. */
    get manifestAttempts() {
      return state.attempts.filter((attempt) => attempt.path === MANIFEST_PATH)
        .length;
    },
    /** Índices gravados: é a gravação do índice que troca o banco na nuvem. */
    get manifestUploads() {
      return finishedUploads().filter((attempt) => attempt.path === MANIFEST_PATH)
        .length;
    },
    /** Caminhos dos uploads aceitos e concluídos, na ordem. */
    get uploadedPaths() {
      return finishedUploads().map((attempt) => attempt.path);
    },
    get copies() {
      return state.copies;
    },
    /** Caminhos que o app pediu para apagar. */
    get removals() {
      return state.removals;
    },
    /** Caminhos de tudo o que está guardado. */
    listPaths() {
      return [...state.objects.keys()].sort();
    },
    /** O conteúdo de um objeto como texto (descomprimido); `null` se não há. */
    readText(path) {
      const object = state.objects.get(path);
      return object ? decodeText(object.body) : null;
    },
    readManifest,
    /**
     * O banco que está "na nuvem", montado como o app o leria: pelo índice e
     * pelas partes; ou pelo arquivo único, numa conta que ainda não migrou.
     * `null` se não há nada.
     */
    readStoredSnapshot() {
      const manifest = readManifest();
      if (manifest) {
        const data = {};
        for (const part of manifest.parts) {
          const object = state.objects.get(`${PARTS_PREFIX}${part.file}`);
          if (!object) {
            throw new Error(`O índice cita ${part.file}, que não está guardado.`);
          }
          data[part.key] = (data[part.key] ?? []).concat(
            JSON.parse(decodeText(object.body)),
          );
        }
        return { exportedAt: manifest.exportedAt, data };
      }

      const legacy = state.objects.get(LEGACY_PATH);
      return legacy ? JSON.parse(decodeText(legacy.body)) : null;
    },
    /**
     * Deixa na nuvem um banco no formato ANTIGO (o arquivo único), como uma
     * conta que ainda não migrou.
     */
    seed(snapshot) {
      put(LEGACY_PATH, Buffer.from(JSON.stringify(snapshot), "utf8"));
    },
    /**
     * Grava um objeto qualquer (texto ou bytes prontos), com a data de
     * gravação informada.
     */
    putObject(path, content, { writtenAt } = {}) {
      put(path, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
      if (writtenAt) {
        const object = state.objects.get(path);
        object.createdAt = writtenAt;
        object.updatedAt = writtenAt;
      }
    },
    rejectUploads(status) {
      state.rejectUploadsWith = status;
    },
    acceptUploads() {
      state.rejectUploadsWith = null;
    },
    /** `onlyManifest`: as partes sobem na hora e só o índice demora. */
    delayUploads(milliseconds, { onlyManifest = false } = {}) {
      state.uploadDelayMs = milliseconds;
      state.uploadDelayOnlyManifest = onlyManifest;
    },
    /** Como se outro dispositivo tivesse acabado de gravar por cima. */
    touchFromAnotherDevice() {
      const target =
        state.objects.get(MANIFEST_PATH) ?? state.objects.get(LEGACY_PATH);
      if (target) {
        target.updatedAt = new Date(Date.now() + 60_000).toISOString();
      }
    },
    reset() {
      state.objects = new Map();
      state.rejectUploadsWith = null;
      state.uploadDelayMs = 0;
      state.uploadDelayOnlyManifest = false;
      state.attempts = [];
      state.copies = [];
      state.removals = [];
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
