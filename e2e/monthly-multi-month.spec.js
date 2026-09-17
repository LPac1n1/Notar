import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import { expect, test } from "@playwright/test";

/**
 * Seleção de vários meses na Gestão Mensal.
 *
 * A fixture tem Alice (8, 12 e 18 notas em jan, fev e mar) e Bruno (4, 5 e 3),
 * com R$ 2,00 por nota. Marcando fevereiro e março, tudo que a tela e os
 * arquivos mostram tem de ser a SOMA dos dois meses — e só deles: janeiro
 * existe na base e não pode aparecer em lugar nenhum.
 *
 * Nomes com `exact: true` onde um rótulo é trecho do outro ("Abater em massa"
 * casa com "Desabater em massa").
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

// A página abre ancorada em março. Ligando a seleção múltipla e marcando
// fevereiro, ficam os dois — e a tela cai na visão por doador.
async function selectFebruaryAndMarch(page) {
  await page
    .getByRole("button", { name: "Selecionar vários", exact: true })
    .click();
  await page
    .getByRole("listitem", { name: "Marcar Fevereiro de 2026" })
    .click();

  await expect(
    page.getByRole("heading", { name: "Abatimentos por doador" }),
  ).toBeVisible({ timeout: 60000 });
}

test("dois meses marcados somam os valores no card do doador", async ({
  page,
}) => {
  await openMonthlyWithFixture(page);
  await selectFebruaryAndMarch(page);

  await expect(
    page.getByText("Valores somados de Fev/2026 e Mar/2026", { exact: false }),
  ).toBeVisible();

  const aliceCard = page
    .locator("article")
    .filter({ hasText: "ALICE MORADIA" })
    .first();

  // Só os meses marcados aparecem, e o pendente é a soma dos dois:
  // fevereiro 12 × R$ 2,00 + março 18 × R$ 2,00 = R$ 60,00.
  await expect(aliceCard.getByText("Fevereiro de 2026")).toBeVisible();
  await expect(aliceCard.getByText("Março de 2026")).toBeVisible();
  await expect(aliceCard.getByText("Janeiro de 2026")).toHaveCount(0);
  await expect(aliceCard.getByText("R$ 60,00")).toBeVisible();

  const brunoCard = page
    .locator("article")
    .filter({ hasText: "BRUNO MORADIA" })
    .first();
  // 5 × R$ 2,00 + 3 × R$ 2,00 = R$ 16,00.
  await expect(brunoCard.getByText("R$ 16,00")).toBeVisible();
});

test("a planilha dos meses marcados sai somada, com os dois meses na descrição", async ({
  page,
}) => {
  await openMonthlyWithFixture(page);
  await selectFebruaryAndMarch(page);

  const download = page.waitForEvent("download", { timeout: 120000 });
  await page
    .getByRole("button", { name: "Planilha de abatimento", exact: true })
    .click();
  const arquivo = await download;

  // O período entra no nome do arquivo: reexportar o mesmo recorte sobrescreve
  // o anterior em vez de virar um segundo arquivo parecido.
  expect(arquivo.suggestedFilename()).toBe(
    "notar-abatimento-cestas-basicas-2026-02-a-2026-03.xlsx",
  );

  const destino = path.join(os.tmpdir(), "notar-abatimento-meses-e2e.xlsx");
  await arquivo.saveAs(destino);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(destino);
  const planilha = workbook.worksheets[0];

  const alice = planilha.getRow(7);
  expect(alice.getCell(4).value).toBe("ALICE MORADIA");
  // 12 + 18 notas somadas numa linha só.
  expect(alice.getCell(2).value).toBe(30);
  expect(alice.getCell(3).value).toBe("Doações NFP - Fev/2026 e Mar/2026");
  // A data sai do mês mais recente somado: março lança em 30/06.
  expect(alice.getCell(1).value.toISOString().slice(0, 10)).toBe("2026-06-30");

  const bruno = planilha.getRow(8);
  expect(bruno.getCell(4).value).toBe("BRUNO MORADIA");
  expect(bruno.getCell(2).value).toBe(8);

  // Uma linha por CPF, não uma por mês.
  expect(planilha.getCell(9, 4).value ?? null).toBeNull();
});

test("o relatório por demanda leva o período dos meses marcados", async ({
  page,
}) => {
  await openMonthlyWithFixture(page);
  await selectFebruaryAndMarch(page);

  const download = page.waitForEvent("download", { timeout: 120000 });
  await page.getByRole("button", { name: "JPEGs por demanda" }).click();
  const arquivo = await download;

  // Uma demanda só na fixture, então baixa a imagem direta em vez do zip.
  expect(arquivo.suggestedFilename()).toBe(
    "relatorio-doacoes-cestas-basicas-2026-02-a-2026-03.jpg",
  );
});
