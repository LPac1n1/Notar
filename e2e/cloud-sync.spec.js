import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  CLOUD_APP_URL,
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
 * Os testes dividem um servidor de storage numa porta fixa, por isso rodam
 * em série e todos neste arquivo.
 */
test.describe.configure({ mode: "serial" });
test.use({ baseURL: CLOUD_APP_URL });

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

test("o que é gravado sobe para a nuvem e volta ao recarregar", async ({
  page,
}) => {
  await page.goto("/p/demandas-de-moradia");
  await addDemand(page, "Demanda sincronizada");

  // O envio acontece sozinho, 2 s depois da gravação.
  await expect
    .poll(() => storage.acceptedUploads, { timeout: 30_000 })
    .toBeGreaterThan(0);

  const snapshot = storage.readStoredSnapshot();
  expect(snapshot.data.demands.map((demand) => demand.name)).toContain(
    "DEMANDA SINCRONIZADA",
  );
  // A conciliação é derivada das notas: não viaja no arquivo.
  expect(Object.keys(snapshot.data)).not.toContain("creditReconciliation");

  // Recarregar zera o banco em memória; o que aparece depois veio da nuvem.
  await page.reload();
  await expect(page.getByText("DEMANDA SINCRONIZADA")).toBeVisible({
    timeout: 60_000,
  });
});

test("arquivo antigo: a conciliação gravada é ignorada e refeita ao abrir", async ({
  page,
}) => {
  const fixture = JSON.parse(
    fs.readFileSync(
      fileURLToPath(
        new URL("./fixtures/project-credit-backup.json", import.meta.url),
      ),
      "utf8",
    ),
  );
  const data = fixture.data ?? fixture;

  // Como outro dispositivo teria deixado na nuvem antes desta mudança: a
  // tabela vem gravada — aqui com TODAS as notas marcadas como sem par. Se
  // o app restaurasse essas linhas, o projeto abriria sem crédito nenhum.
  storage.seed({
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      ...data,
      creditReconciliation: data.creditNotes.map((note, index) => ({
        id: `gravada-${index}`,
        credit_note_id: note.id,
        donation_note_id: null,
        match_status: "credit_only",
        created_at: "2026-01-01 00:00:00",
      })),
    },
  });

  await page.goto("/p/capoeira");

  // Mesmo número que `project-credit-dashboard.spec.js` confere depois de
  // importar esta fixture: a soma dos 10 créditos, todos conciliados.
  const accumulated = page.getByText("Crédito acumulado").locator("xpath=..");
  await expect(accumulated.getByText("R$ 1.385,00")).toBeVisible({
    timeout: 60_000,
  });

  // Abrir não é gravar: nada pode ter subido.
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
  // outro upload: cabiam cinco ou seis tentativas nesse intervalo (uma a
  // cada ~2 s), cada uma exportando o banco inteiro. Com espera crescente
  // cabem duas — a original e a primeira nova tentativa, 5 s depois.
  await page.waitForTimeout(12_000);
  expect(storage.attempts.length).toBeLessThanOrEqual(3);
  expect(storage.acceptedUploads).toBe(0);

  // O armazenamento volta a aceitar: a alteração tem de chegar sozinha, sem
  // o usuário precisar mexer em mais nada.
  storage.acceptUploads();
  await expect
    .poll(() => storage.acceptedUploads, { timeout: 45_000 })
    .toBeGreaterThan(0);
  expect(
    storage.readStoredSnapshot().data.demands.map((demand) => demand.name),
  ).toContain("DEMANDA TEIMOSA");
});
