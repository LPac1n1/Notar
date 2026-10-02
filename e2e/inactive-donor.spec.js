import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Desativar um doador tira as doações dele da apuração DO MÊS DA DESATIVAÇÃO
 * EM DIANTE; os meses anteriores continuam contando; reativar devolve tudo.
 *
 * A fixture tem Alice e Bruno de janeiro a março, tudo pendente, e a Gestão
 * Mensal abre ancorada em março. O teste abate março dos dois, desativa o
 * Bruno a partir de março e confere que ele some de março na Gestão Mensal
 * E no painel — antes ele sumia só da lista — e que continua em fevereiro,
 * quando ainda era ativo. Depois reativa e confere que março volta JÁ
 * ABATIDO: o status não pode se perder no caminho, senão a mesma doação
 * seria abatida duas vezes.
 *
 * ATENÇÃO: o e2e roda com `VITE_NOTAR_AUTH_MODE=local`, em que o DuckDB é só
 * memória. Um `page.goto()` no meio do teste APAGA tudo — navegue por clique.
 */

async function selectOption(page, name, label) {
  const select = page.locator(`[data-select-name="${name}"]`);
  await select.getByRole("button").first().click();
  const listbox = page.getByRole("listbox").last();
  await expect(listbox).toBeVisible();
  await listbox.getByRole("option", { name: label }).first().click();
}

const donorRow = (page, name) => page.locator("li").filter({ hasText: name });
const monthBlock = (page) =>
  page.getByRole("region", { name: /Resumo de Março de 2026/ });
const donorInMonthly = (page, name) =>
  page.getByRole("button", { name, exact: true });

test("doador inativo sai da apuração e volta inteiro ao ser reativado", async ({
  page,
}) => {
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

  // Março dos dois vira "realizado".
  await page.getByRole("link", { name: "Gestão Mensal" }).click();
  await expect(donorInMonthly(page, "BRUNO MORADIA")).toHaveCount(1, {
    timeout: 60000,
  });
  await page.getByRole("button", { name: "Abater em massa", exact: true }).click();
  const abateDialog = page.getByRole("dialog", {
    name: "Abatimento em massa",
    exact: true,
  });
  await abateDialog.getByRole("button", { name: /Março de 2026/ }).click();
  await abateDialog
    .getByRole("button", { name: "Abater 2 selecionado(s)", exact: true })
    .click();
  await expect(page.getByText("2 abatimento(s) realizado(s)")).toBeVisible();

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(monthBlock(page)).toContainText("2 de 2 doador(es) já marcados", {
    timeout: 60000,
  });

  // Desativa o Bruno a partir de março.
  await page.getByRole("link", { name: "Doadores", exact: true }).click();
  await donorRow(page, "BRUNO MORADIA")
    .getByRole("button", { name: "Desativar" })
    .click();
  const deactivateDialog = page.getByRole("dialog", { name: "Desativar doador" });
  await deactivateDialog.getByLabel("Inativo a partir de").fill("03/2026");
  await deactivateDialog.getByRole("button", { name: "Desativar doador" }).click();
  await expect(deactivateDialog).toHaveCount(0);

  // Some de março na Gestão Mensal…
  await page.getByRole("link", { name: "Gestão Mensal" }).click();
  await expect(donorInMonthly(page, "ALICE MORADIA")).toHaveCount(1, {
    timeout: 60000,
  });
  await expect(donorInMonthly(page, "BRUNO MORADIA")).toHaveCount(0);

  // …mas continua em fevereiro: ele era ativo, e desativar não reescreve o
  // que já foi apurado.
  await page
    .getByRole("listitem", { name: "Selecionar Fevereiro de 2026" })
    .click();
  await expect(donorInMonthly(page, "BRUNO MORADIA")).toHaveCount(1, {
    timeout: 60000,
  });
  await expect(donorInMonthly(page, "ALICE MORADIA")).toHaveCount(1);

  // No painel, março conta só a Alice — antes ele continuava contando o Bruno.
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(monthBlock(page)).toContainText("1 de 1 doador(es) já marcados", {
    timeout: 60000,
  });

  // Reativa.
  await page.getByRole("link", { name: "Doadores", exact: true }).click();
  await selectOption(page, "activeStatus", "Apenas inativos");
  await donorRow(page, "BRUNO MORADIA")
    .getByRole("button", { name: "Reativar" })
    .click();
  const reactivateDialog = page.getByRole("dialog", { name: "Reativar doador" });
  await reactivateDialog.getByLabel("Ativo a partir de").fill("04/2026");
  await reactivateDialog.getByRole("button", { name: "Reativar doador" }).click();
  await expect(reactivateDialog).toHaveCount(0);

  // Volta à Gestão Mensal, e março continua ABATIDO para os dois: o modal de
  // desabater oferece março com dois doadores.
  await page.getByRole("link", { name: "Gestão Mensal" }).click();
  await expect(donorInMonthly(page, "BRUNO MORADIA")).toHaveCount(1, {
    timeout: 60000,
  });
  await page
    .getByRole("button", { name: "Desabater em massa", exact: true })
    .click();
  const unabateDialog = page.getByRole("dialog", {
    name: "Desabatimento em massa",
    exact: true,
  });
  await expect(
    unabateDialog.getByRole("button", { name: /Março de 2026/ }),
  ).toContainText("2 doador(es)");
  await page.keyboard.press("Escape");
  await expect(unabateDialog).toHaveCount(0);

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(monthBlock(page)).toContainText("2 de 2 doador(es) já marcados", {
    timeout: 60000,
  });
});
