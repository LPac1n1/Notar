import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Transferência de doador entre projetos.
 *
 * O que precisa ser provado não é que o botão funciona: é que o histórico NÃO
 * se move. A fixture tem crédito em março e abril para o mesmo doador; depois
 * de transferir a partir de abril, março tem de continuar somando para o
 * projeto antigo. Se a transferência reescrevesse o vínculo em vez de fechar a
 * janela, o crédito de março migraria junto e o teste pegaria.
 *
 * ATENÇÃO: o e2e roda com `VITE_NOTAR_AUTH_MODE=local`, em que o DuckDB é só
 * memória. Um `page.goto()` no meio do teste APAGA tudo — navegue por clique.
 */

async function restoreFixture(page) {
  const backupPath = fileURLToPath(
    new URL("./fixtures/project-credit-backup.json", import.meta.url),
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
  await expect(page.getByText("Backup importado:")).toBeVisible();
}

async function openCarlaTransfer(page) {
  // Carla está em Capoeira, com R$45 em março e R$150 em abril.
  await page.locator("aside").first().getByRole("button").first().click();
  await page.getByText("Capoeira").first().click();
  await expect(page).toHaveURL(/\/p\/capoeira$/);

  await page.getByRole("link", { name: "Doadores", exact: true }).click();
  await page.getByRole("button", { name: /CARLA CAPOEIRA/ }).first().click();

  const projectSection = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Projeto", exact: true }) });
  await expect(projectSection.getByText("Capoeira")).toBeVisible();

  await projectSection.getByRole("button", { name: "Transferir de projeto" }).click();
  const dialog = page.getByRole("dialog", { name: "Transferir de projeto" });

  return { dialog, projectSection };
}

async function pickOption(page, dialog, selectName, optionName) {
  await dialog
    .locator(`[data-select-name="${selectName}"]`)
    .getByRole("button")
    .first()
    .click();
  await page
    .getByRole("listbox")
    .last()
    .getByRole("option", { name: optionName })
    .click();
}

test("transferir doador move o crédito futuro e preserva o passado", async ({
  page,
}) => {
  await restoreFixture(page);
  const { dialog, projectSection } = await openCarlaTransfer(page);

  await pickOption(page, dialog, "projectId", "Demandas de Moradia");
  await pickOption(page, dialog, "demand", "CESTAS BASICAS");

  await dialog.locator('input[name="effectiveMonth"]').fill("04/2026");
  // O texto tem de anunciar o mês que o banco realmente grava: a janela fecha
  // em março, não em abril.
  await expect(
    dialog.getByText("Continuam em Capoeira as doações até Março de 2026", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Passam para Demandas de Moradia: 1 mês com doação (Abr/2026)."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Transferir" }).click();

  await expect(page.getByText("Doador transferido para Demandas de Moradia.")).toBeVisible();
  await expect(projectSection.getByText("Vínculos anteriores")).toBeVisible();
  await expect(projectSection.getByText("Capoeira")).toBeVisible();
  await expect(projectSection.getByText("Encerrado")).toBeVisible();

  // O crédito de março continua em Capoeira; abril saiu.
  await page.locator("aside").first().getByRole("button").first().click();
  await expect(page.getByRole("heading", { name: "Projetos" })).toBeVisible();
  await page.getByRole("button", { name: /Capoeira/ }).first().click();
  await expect(page).toHaveURL(/\/p\/capoeira$/);

  const accumulated = page.getByText("Crédito acumulado").locator("xpath=..");
  // 2 + 45 = 47 (Ana e Bruno de março/abril seguem intactos; some só o abril
  // de Carla, R$150). Total anterior: R$1.385.
  await expect(accumulated.getByText("R$ 1.235,00")).toBeVisible();
});

/**
 * O caso relatado: transferir para Moradia e o doador não aparecer na Gestão
 * Mensal — nem o nome, nem as pendências.
 *
 * Eram duas falhas somadas. O mês sugerido era o do calendário, e como a
 * planilha chega meses depois, nenhuma doação mudava de projeto. E a demanda,
 * que Moradia usa para agrupar tudo, não era pedida: quem acertava o mês via o
 * doador como "Demanda: Não informada".
 */
test("destino com demandas exige a demanda e o doador chega à Gestão Mensal com ela", async ({
  page,
}) => {
  await restoreFixture(page);
  const { dialog } = await openCarlaTransfer(page);

  await pickOption(page, dialog, "projectId", "Demandas de Moradia");

  // A sugestão é o primeiro mês com doação, não o do calendário. Carla doou em
  // março e abril, então os dois vão juntos.
  await expect(dialog.locator('input[name="effectiveMonth"]')).toHaveValue("03/2026");
  await expect(
    dialog.getByText(
      "Passam para Demandas de Moradia: 2 meses com doação (Mar/2026 e Abr/2026).",
    ),
  ).toBeVisible();
  await expect(dialog.getByText("Nenhuma doação fica em Capoeira.")).toBeVisible();

  // Sem demanda, não transfere.
  await dialog.getByRole("button", { name: "Transferir" }).click();
  await expect(
    dialog.getByText("Selecione a demanda do doador em Demandas de Moradia."),
  ).toBeVisible();

  await pickOption(page, dialog, "demand", "CESTAS BASICAS");
  await dialog.getByRole("button", { name: "Transferir" }).click();
  await expect(page.getByText("Doador transferido para Demandas de Moradia.")).toBeVisible();

  await page.locator("aside").first().getByRole("button").first().click();
  await expect(page.getByRole("heading", { name: "Projetos" })).toBeVisible();
  await page.getByRole("button", { name: /Demandas de Moradia/ }).first().click();
  await expect(page).toHaveURL(/\/p\/demandas-de-moradia$/);

  await page.getByRole("link", { name: "Gestão Mensal", exact: true }).click();
  const monthlySection = page
    .getByRole("heading", { name: "Resumo mensal" })
    .locator("xpath=ancestor::section[1]");
  await monthlySection.locator('input[name="referenceMonth"]').fill("03/2026");

  // Março é justamente o mês que o padrão antigo deixava em Capoeira.
  //
  // Contagem em vez de visibilidade: a lista abre ancorada em abril e, ao
  // trocar para março, a linha de abril ainda sai animada por um instante — as
  // duas coexistem no DOM. Esperar exatamente uma também pega um resumo mensal
  // duplicado, que é o que a reconciliação feita na transferência poderia
  // produzir se estivesse errada.
  await expect(
    page.getByRole("button", { name: "CARLA CAPOEIRA", exact: true }),
  ).toHaveCount(1, { timeout: 60000 });
  await expect(
    page
      .getByText("Demanda: CESTAS BASICAS")
      .and(page.locator(":visible"))
      .first(),
  ).toBeVisible();
});

/**
 * O card de doadores sem projeto não oferece ação quando não há o que
 * resolver.
 *
 * A resolução em si (o modal de vínculo) NÃO é exercitada aqui de propósito:
 * nenhum caminho da interface produz um doador órfão — criar já vincula,
 * transferir sempre deixa uma janela aberta, e o restore de backup reexecuta
 * o backfill. O card é rede de segurança para dado que chegue por fora, e a
 * consulta que o alimenta é coberta por teste de integração contra o banco.
 */
test("card de doadores sem projeto não oferece ação quando não há órfão", async ({
  page,
}) => {
  await restoreFixture(page);

  await page.locator("aside").first().getByRole("button").first().click();
  await expect(page.getByRole("heading", { name: "Projetos" })).toBeVisible();

  const orphanCard = page
    .getByText("Doadores sem projeto")
    .locator("xpath=..");
  await expect(orphanCard.getByText("0")).toBeVisible();
  await expect(orphanCard.getByRole("button", { name: "Ver e vincular" })).toHaveCount(0);
});
