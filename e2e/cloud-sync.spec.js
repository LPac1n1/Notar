import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  CLOUD_APP_URL,
  FAKE_USER_ID,
  LEGACY_ARCHIVE_PATH,
  signInWithFakeSession,
  startFakeStorage,
} from "./helpers/fakeStorage.js";

/**
 * Sincronização com a nuvem, de ponta a ponta.
 *
 * É a única especificação que NÃO roda em modo local: usa o segundo servidor
 * de dev do `playwright.config.js`, configurado para um Supabase Storage de
 * mentira (`helpers/fakeStorage.js`). Com isso o caminho real é exercitado —
 * hidratar ao abrir, enviar depois de gravar — e o teste lê o que de fato
 * chegou "à nuvem".
 *
 * O banco é gravado em PARTES com um índice: um envio são vários uploads e,
 * por último, o do índice. É a gravação do índice que conta como "subiu".
 *
 * Os testes dividem um servidor de storage numa porta fixa, por isso rodam
 * em série e todos neste arquivo.
 */
test.describe.configure({ mode: "serial" });
test.use({ baseURL: CLOUD_APP_URL });

const LEGACY_PATH = `${FAKE_USER_ID}/dados.json`;
const MANIFEST_PATH = `${FAKE_USER_ID}/manifest.json`;

let storage;

test.beforeAll(async () => {
  storage = await startFakeStorage();
});

test.afterAll(async () => {
  await storage?.close();
});

test.beforeEach(async ({ page }) => {
  storage.reset();
  await signInWithFakeSession(page);
});

async function addDemand(page, name) {
  await page.getByRole("link", { name: "Demandas" }).click();
  await page.getByRole("button", { name: "Adicionar demanda" }).click();
  const dialog = page.getByRole("dialog", { name: "Adicionar demanda" });
  await dialog.getByPlaceholder("Nome da demanda").fill(name);
  await dialog.getByRole("button", { name: "Adicionar demanda" }).click();
  await expect(page.getByText(name.toUpperCase())).toBeVisible();
}

const storedDemandNames = () =>
  (storage.readStoredSnapshot()?.data.demands ?? []).map((demand) => demand.name);

/** Como outro dispositivo teria deixado a conta, no formato de arquivo único. */
function buildLegacySeed() {
  const fixture = JSON.parse(
    fs.readFileSync(
      fileURLToPath(
        new URL("./fixtures/project-credit-backup.json", import.meta.url),
      ),
      "utf8",
    ),
  );
  const data = fixture.data ?? fixture;

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      ...data,
      // Arquivo anterior à mudança que tirou a conciliação do snapshot: a
      // tabela vem gravada — aqui com TODAS as notas marcadas como sem par.
      // Se o app restaurasse essas linhas, o projeto abriria sem crédito
      // nenhum.
      creditReconciliation: data.creditNotes.map((note, index) => ({
        id: `gravada-${index}`,
        credit_note_id: note.id,
        donation_note_id: null,
        match_status: "credit_only",
        created_at: "2026-01-01 00:00:00",
      })),
    },
  };
}

const accumulatedCredit = (page) =>
  page.getByText("Crédito acumulado").locator("xpath=..");

test("o que é gravado sobe para a nuvem e volta ao recarregar", async ({
  page,
}) => {
  await page.goto("/p/demandas-de-moradia");
  await addDemand(page, "Demanda sincronizada");

  // O envio acontece sozinho, 2 s depois da gravação.
  await expect
    .poll(() => storage.manifestUploads, { timeout: 30_000 })
    .toBeGreaterThan(0);

  const snapshot = storage.readStoredSnapshot();
  expect(snapshot.data.demands.map((demand) => demand.name)).toContain(
    "DEMANDA SINCRONIZADA",
  );
  // A conciliação é derivada das notas: não viaja.
  expect(Object.keys(snapshot.data)).not.toContain("creditReconciliation");
  // Conta que já nasce no formato novo: o arquivo único nunca é criado.
  expect(storage.listPaths()).not.toContain(LEGACY_PATH);

  // Recarregar zera o banco em memória; o que aparece depois veio da nuvem.
  await page.reload();
  await expect(page.getByText("DEMANDA SINCRONIZADA")).toBeVisible({
    timeout: 60_000,
  });
});

test("conta no formato antigo migra ao abrir: nada se perde e o arquivo velho é bloqueado", async ({
  page,
}) => {
  const seed = buildLegacySeed();
  storage.seed(seed);
  const legacyText = storage.readText(LEGACY_PATH);

  await page.goto("/p/capoeira");

  // Mesmo número que `project-credit-dashboard.spec.js` confere depois de
  // importar esta fixture: a soma dos 10 créditos, todos conciliados — a
  // conciliação gravada no arquivo antigo foi ignorada e refeita.
  await expect(accumulatedCredit(page).getByText("R$ 1.385,00")).toBeVisible({
    timeout: 60_000,
  });

  // A migração acontece sozinha, sem esperar o usuário gravar nada, e
  // termina com o registro do bloqueio no índice.
  await expect
    .poll(() => storage.readManifest()?.legacy?.archivedAs ?? null, {
      timeout: 60_000,
    })
    .toBe("dados-formato-antigo.json");

  // 1. O arquivo antigo foi guardado byte a byte.
  expect(storage.readText(LEGACY_ARCHIVE_PATH)).toBe(legacyText);

  // 2. No lugar dele ficou um aviso que NÃO é JSON nem está vazio: é o que
  //    faz uma versão antiga do sistema acusar erro ao abrir, em vez de
  //    abrir com dados velhos (ou vazia) e gravar por cima.
  const tombstone = storage.readText(LEGACY_PATH);
  expect(tombstone.trim()).not.toBe("");
  expect(() => JSON.parse(tombstone)).toThrow();
  expect(tombstone).toContain("dados-formato-antigo.json");

  // 3. O que está no formato novo é o que estava no arquivo antigo, tabela
  //    por tabela (a conciliação, derivada, não viaja).
  const stored = storage.readStoredSnapshot().data;
  for (const key of [
    "projects",
    "donors",
    "donorCpfLinks",
    "imports",
    "donationNotes",
    "creditImports",
    "creditNotes",
  ]) {
    expect(
      (stored[key] ?? []).map((row) => row.id).sort(),
      `tabela ${key}`,
    ).toEqual(seed.data[key].map((row) => row.id).sort());
  }
  expect(Object.keys(stored)).not.toContain("creditReconciliation");

  // 4. As notas viraram uma parte por importação.
  const manifest = storage.readManifest();
  const noteParts = manifest.parts.filter((part) => part.key === "donationNotes");
  expect(noteParts.length).toBe(
    new Set(seed.data.donationNotes.map((note) => note.import_id)).size,
  );

  // Reabrir já é pelo formato novo — e abrir não é gravar: nada sobe.
  const uploadsBeforeReload = storage.attempts.length;
  await page.reload();
  await expect(accumulatedCredit(page).getByText("R$ 1.385,00")).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(5_000);
  expect(storage.attempts.length).toBe(uploadsBeforeReload);
});

test("depois de migrada, uma alteração sobe só as partes que mudaram", async ({
  page,
}) => {
  storage.seed(buildLegacySeed());
  await page.goto("/p/demandas-de-moradia");
  await expect
    .poll(() => storage.readManifest()?.legacy?.archivedAs ?? null, {
      timeout: 90_000,
    })
    .toBe("dados-formato-antigo.json");

  const manifestBefore = storage.readManifest();
  const uploadsBefore = storage.uploadedPaths.length;
  const manifestsBefore = storage.manifestUploads;
  const fileOf = (manifest, id) =>
    manifest.parts.find((part) => part.id === id)?.file;

  await addDemand(page, "Demanda nova");

  await expect
    .poll(() => storage.manifestUploads, { timeout: 30_000 })
    .toBeGreaterThan(manifestsBefore);
  await expect.poll(storedDemandNames, { timeout: 30_000 }).toContain("DEMANDA NOVA");

  // As notas — quase todo o volume do banco — NÃO subiram de novo.
  const newUploads = storage.uploadedPaths.slice(uploadsBefore);
  expect(newUploads.some((path) => path.includes("/parts/demands."))).toBe(true);
  expect(
    newUploads.filter((path) => /\/parts\/(donationNotes|creditNotes)\./.test(path)),
  ).toEqual([]);

  // E continuam sendo os MESMOS arquivos no índice novo.
  const manifestAfter = storage.readManifest();
  for (const part of manifestBefore.parts.filter((item) =>
    ["donationNotes", "creditNotes"].includes(item.key),
  )) {
    expect(fileOf(manifestAfter, part.id)).toBe(part.file);
  }

  // O arquivo antigo das demandas saiu do índice mas continua guardado: quem
  // começou a abrir o sistema pelo índice anterior ainda vai baixá-lo.
  const oldDemandsFile = fileOf(manifestBefore, "demands");
  expect(fileOf(manifestAfter, "demands")).not.toBe(oldDemandsFile);
  expect(manifestAfter.retired.map((entry) => entry.file)).toContain(oldDemandsFile);
  expect(storage.listPaths()).toContain(`${FAKE_USER_ID}/parts/${oldDemandsFile}`);
  expect(storage.removals).toEqual([]);
});

test("índice gravado por uma versão mais nova do sistema não é aberto nem sobrescrito", async ({
  page,
}) => {
  storage.putObject(
    MANIFEST_PATH,
    JSON.stringify({ format: "notar-snapshot", version: 99, parts: [] }),
  );

  await page.goto("/p/demandas-de-moradia");

  // Abrir assim mesmo perderia o que esta versão não entende, na primeira
  // gravação. O sistema para e diz o que fazer.
  await expect(
    page.getByText(/gravados por uma versão mais nova do sistema/),
  ).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(4_000);
  expect(storage.attempts).toHaveLength(0);
});

test("uma falha de upload não entra em laço, e a nova tentativa entrega", async ({
  page,
}) => {
  // Como o armazenamento responde quando o arquivo passa do limite.
  storage.rejectUploads(413);

  await page.goto("/p/demandas-de-moradia");
  await addDemand(page, "Demanda teimosa");

  await expect
    .poll(() => storage.attempts.length, { timeout: 30_000 })
    .toBeGreaterThan(0);

  // UMA alteração, e depois ninguém mexe em nada por 12 s.
  //
  // Antes da correção o registro do erro contava como alteração e agendava
  // outro envio: cabiam cinco ou seis nesse intervalo (um a cada ~2 s). Com
  // espera crescente cabem dois — o original e a primeira nova tentativa,
  // 5 s depois.
  await page.waitForTimeout(12_000);
  expect(storage.uploadBursts).toBeLessThanOrEqual(3);
  expect(storage.manifestUploads).toBe(0);

  // O armazenamento volta a aceitar: a alteração tem de chegar sozinha, sem
  // o usuário precisar mexer em mais nada.
  storage.acceptUploads();
  await expect
    .poll(() => storage.manifestUploads, { timeout: 45_000 })
    .toBeGreaterThan(0);
  expect(storedDemandNames()).toContain("DEMANDA TEIMOSA");
});

test("o que é gravado durante um envio em andamento também sobe", async ({
  page,
}) => {
  // O servidor demora 6 s para concluir a gravação do índice: tempo de sobra
  // para o usuário gravar outra coisa com o primeiro envio ainda no ar.
  storage.delayUploads(6_000, { onlyManifest: true });

  await page.goto("/p/demandas-de-moradia");
  await addDemand(page, "Primeira demanda");

  // O primeiro envio chegou ao índice — com as partes exportadas ANTES da
  // segunda demanda.
  await expect
    .poll(() => storage.manifestAttempts, { timeout: 30_000 })
    .toBe(1);

  await page.getByRole("button", { name: "Adicionar demanda" }).click();
  const dialog = page.getByRole("dialog", { name: "Adicionar demanda" });
  await dialog.getByPlaceholder("Nome da demanda").fill("Segunda demanda");
  await dialog.getByRole("button", { name: "Adicionar demanda" }).click();
  await expect(page.getByText("SEGUNDA DEMANDA")).toBeVisible();

  // Antes da correção parava aqui: o envio em andamento terminava sem a
  // segunda demanda, o app se dizia sincronizado e nada mais subia.
  await expect
    .poll(storedDemandNames, { timeout: 45_000 })
    .toContain("SEGUNDA DEMANDA");
  expect(storedDemandNames()).toContain("PRIMEIRA DEMANDA");
});

test("\"Manter minhas alterações\" sobe o que está aqui por cima do outro dispositivo", async ({
  page,
}) => {
  await page.goto("/p/demandas-de-moradia");
  await addDemand(page, "Demanda inicial");
  await expect
    .poll(() => storage.manifestUploads, { timeout: 30_000 })
    .toBe(1);

  // Outro dispositivo grava na nuvem. A próxima gravação daqui esbarra nisso.
  storage.touchFromAnotherDevice();

  await page.getByRole("button", { name: "Adicionar demanda" }).click();
  const dialog = page.getByRole("dialog", { name: "Adicionar demanda" });
  await dialog.getByPlaceholder("Nome da demanda").fill("Demanda local");
  await dialog.getByRole("button", { name: "Adicionar demanda" }).click();
  await expect(page.getByText("DEMANDA LOCAL")).toBeVisible();

  const banner = page.getByRole("alert").filter({
    hasText: "Os dados foram atualizados em outro dispositivo",
  });
  await expect(banner).toBeVisible({ timeout: 30_000 });
  // Enquanto o aviso está na tela, nada sobe.
  expect(storage.manifestUploads).toBe(1);

  await banner.getByRole("button", { name: "Manter minhas alterações" }).click();

  // Antes da correção o aviso sumia e voltava, e o upload nunca acontecia.
  await expect
    .poll(storedDemandNames, { timeout: 30_000 })
    .toContain("DEMANDA LOCAL");
  await expect(banner).toHaveCount(0);
});
