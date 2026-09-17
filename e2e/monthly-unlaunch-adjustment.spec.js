import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Deslançar um acumulado pela Gestão Mensal.
 *
 * Lançar um acumulado consolida vários meses num só lançamento e deixa os
 * meses cobertos como "Via acumulado", sem toggle. Até aqui, desfazer isso só
 * era possível pelo perfil do doador — quem lançou pela Gestão Mensal ficava
 * sem caminho de volta na mesma tela.
 *
 * O teste prova pelo ESTADO: depois de deslançar, os meses voltam a ser
 * pendentes e o próprio botão some do card.
 *
 * "Lançar acumulado" é trecho de "Deslançar acumulado de ...", então os nomes
 * exatos importam aqui.
 *
 * ATENÇÃO: o e2e roda com `VITE_NOTAR_AUTH_MODE=local`, em que o DuckDB é só
 * memória. Um `page.goto()` no meio do teste APAGA tudo — navegue por clique.
 */
test("deslançar devolve os meses do acumulado para pendente", async ({
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

  await page.getByRole("link", { name: "Gestão Mensal" }).click();
  await expect(
    page.getByRole("button", { name: "ALICE MORADIA", exact: true }),
  ).toHaveCount(1, { timeout: 60000 });

  // Sem mês selecionado aparece a visão por doador, que é onde o acumulado é
  // lançado e agora também desfeito.
  await page
    .getByRole("listitem", { name: "Limpar seleção de Março de 2026" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Abatimentos por doador" }),
  ).toBeVisible({ timeout: 60000 });

  const aliceCard = page
    .locator("article")
    .filter({ hasText: "ALICE MORADIA" })
    .first();

  await aliceCard
    .getByRole("button", { name: "Lançar acumulado", exact: true })
    .click();

  const catchUp = page.getByRole("dialog", { name: "Lançar acumulado" });
  await catchUp.getByLabel("Lançar acumulado em").fill("03/2026");
  await catchUp.getByLabel("Acumular a partir de").fill("01/2026");
  await catchUp.getByLabel("Até o mês de").fill("02/2026");
  await catchUp
    .getByRole("button", { name: "Lançar acumulado", exact: true })
    .click();

  await expect(page.getByText("Acumulado lançado com sucesso.")).toBeVisible({
    timeout: 60000,
  });

  const unlaunchButton = aliceCard.getByRole("button", {
    name: /Deslançar acumulado de Março de 2026/,
  });
  await expect(unlaunchButton).toBeVisible({ timeout: 60000 });
  await unlaunchButton.click();

  const confirm = page.getByRole("dialog", { name: "Deslançar acumulado" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Deslançar", exact: true }).click();

  await expect(
    page.getByText("Acumulado de Março de 2026 deslançado", { exact: false }),
  ).toBeVisible({ timeout: 60000 });

  // O estado voltou: sem acumulado, o botão de deslançar não existe mais e os
  // meses cobertos voltam a ser pendentes (o card volta a oferecer lançar).
  await expect(
    aliceCard.getByRole("button", { name: /Deslançar acumulado/ }),
  ).toHaveCount(0, { timeout: 60000 });
  await expect(
    aliceCard.getByRole("button", { name: "Lançar acumulado", exact: true }),
  ).toBeVisible();
});
