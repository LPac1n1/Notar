import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Desabater em massa na Gestão Mensal.
 *
 * A fixture tem Alice e Bruno de janeiro a março, tudo pendente, e a página
 * abre ancorada em março. O teste abate março em massa e depois desfaz pelo
 * caminho novo. A prova de que o status voltou não é a mensagem: é o modal de
 * desabater ficar vazio e o de abater voltar a oferecer março.
 *
 * Nomes com `exact: true` de propósito: sem isso "Abater em massa" também casa
 * com "Desabater em massa", e "Abatimento em massa" com "Desabatimento em
 * massa" — a busca por nome é por trecho.
 *
 * ATENÇÃO: o e2e roda com `VITE_NOTAR_AUTH_MODE=local`, em que o DuckDB é só
 * memória. Um `page.goto()` no meio do teste APAGA tudo — navegue por clique.
 */

async function openMonthlyWithFixture(page) {
  const backupPath = fileURLToPath(
    new URL("./fixtures/moradia-credit-backup.json", import.meta.url),
  );

  await page.goto("/p/demandas-de-moradia");
  await page.getByRole("link", { name: "Configurações" }).click();
  await page.getByRole("heading", { name: "Cópia de segurança" }).click();
  await page.locator('input[type="file"]').setInputFiles(backupPath);
  await page.getByRole("button", { name: "Importar", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Restaurar backup" })
    .getByRole("button", { name: "Restaurar backup" })
    .click({ force: true });
  await expect(page.getByText("Backup importado:")).toBeVisible({
    timeout: 120000,
  });

  await page.getByRole("link", { name: "Gestão Mensal" }).click();
  await expect(
    page.getByRole("button", { name: "ALICE MORADIA", exact: true }),
  ).toHaveCount(1, { timeout: 60000 });
}

const abateDialog = (page) =>
  page.getByRole("dialog", { name: "Abatimento em massa", exact: true });
const unabateDialog = (page) =>
  page.getByRole("dialog", { name: "Desabatimento em massa", exact: true });

async function openUnabate(page) {
  await page.getByRole("button", { name: "Desabater em massa", exact: true }).click();
  return unabateDialog(page);
}

// O modal tem dois "Fechar": o X do cabeçalho e o botão do rodapé.
async function closeEmptyDialog(dialog) {
  await dialog.getByRole("button", { name: "Fechar", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);
}

async function abateMarch(page) {
  await page.getByRole("button", { name: "Abater em massa", exact: true }).click();
  const dialog = abateDialog(page);
  await dialog.getByRole("button", { name: /Março de 2026/ }).click();
  await dialog
    .getByRole("button", { name: "Abater 2 selecionado(s)", exact: true })
    .click();
  await expect(page.getByText("2 abatimento(s) realizado(s)")).toBeVisible();
  await expect(dialog).toHaveCount(0);
}

async function unabateMarch(page) {
  const dialog = await openUnabate(page);
  const march = dialog.getByRole("button", { name: /Março de 2026/ });
  await expect(march).toContainText("2 doador(es)");
  await march.click();
  await dialog
    .getByRole("button", { name: "Desabater 2 selecionado(s)", exact: true })
    .click();
  await expect(page.getByText("2 abatimento(s) voltaram a pendente")).toBeVisible();
  await expect(dialog).toHaveCount(0);
}

test("desabater em massa devolve os meses realizados para pendente", async ({
  page,
}) => {
  await openMonthlyWithFixture(page);

  // Nada realizado ainda: o modal diz isso em vez de abrir uma lista vazia.
  const emptyDialog = await openUnabate(page);
  await expect(
    emptyDialog.getByText("Nenhum abatimento realizado encontrado para os filtros atuais."),
  ).toBeVisible();
  await closeEmptyDialog(emptyDialog);

  await abateMarch(page);
  await unabateMarch(page);

  // O status voltou de verdade: nada para desabater, março de novo para abater.
  const afterDialog = await openUnabate(page);
  await expect(
    afterDialog.getByText("Nenhum abatimento realizado encontrado para os filtros atuais."),
  ).toBeVisible();
  await closeEmptyDialog(afterDialog);

  await page.getByRole("button", { name: "Abater em massa", exact: true }).click();
  await expect(
    abateDialog(page).getByRole("button", { name: /Março de 2026/ }),
  ).toContainText("2 doador(es)");
});

test("desfazer depois de desabater restaura os abatimentos", async ({ page }) => {
  await openMonthlyWithFixture(page);
  await abateMarch(page);
  await unabateMarch(page);

  // O "Desfazer" do aviso de desabater — não o de um aviso anterior que ainda
  // esteja saindo da tela, que desfaria o abatimento.
  await page
    .getByRole("status")
    .filter({ hasText: "voltaram a pendente" })
    .getByRole("button", { name: "Desfazer", exact: true })
    .click();
  await expect(
    page.getByText("2 abatimento(s) restaurado(s) como realizado(s)."),
  ).toBeVisible();

  const dialog = await openUnabate(page);
  await expect(
    dialog.getByRole("button", { name: /Março de 2026/ }),
  ).toContainText("2 doador(es)");
});
