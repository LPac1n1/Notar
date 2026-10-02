import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import { expect, test } from "@playwright/test";

/**
 * A planilha de abatimento segue o acumulado.
 *
 * Lançar em março um acumulado de janeiro a março faz a Gestão Mensal mostrar,
 * na linha de março, o total dos três meses. A planilha de março tem de sair
 * com esse mesmo total — ela somava só as notas de março, e janeiro e
 * fevereiro não saíam em planilha nenhuma.
 *
 * A fixture tem Alice com 8, 12 e 18 notas e Bruno com 4, 5 e 3, de janeiro a
 * março. O acumulado é lançado pela interface e o arquivo é aberto de volta:
 * o teste de integração confere a consulta; este confere o que a pessoa baixa.
 *
 * ATENÇÃO: o e2e roda com `VITE_NOTAR_AUTH_MODE=local`, em que o DuckDB é só
 * memória. Um `page.goto()` no meio do teste APAGA tudo — navegue por clique.
 */

async function downloadSheet(page, fileLabel) {
  const download = page.waitForEvent("download", { timeout: 120000 });
  await page
    .getByRole("button", { name: "Planilha de abatimento", exact: true })
    .click();
  const file = await download;
  const target = path.join(os.tmpdir(), `notar-abatimento-acumulado-${fileLabel}.xlsx`);
  await file.saveAs(target);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(target);
  return { fileName: file.suggestedFilename(), sheet: workbook.worksheets[0] };
}

test("a planilha do mês do acumulado leva o total; os meses cobertos saem da deles", async ({
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

  // O acumulado é lançado na visão por doador (sem mês selecionado).
  await page
    .getByRole("listitem", { name: "Limpar seleção de Março de 2026" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Abatimentos por doador" }),
  ).toBeVisible({ timeout: 60000 });

  await page
    .locator("article")
    .filter({ hasText: "ALICE MORADIA" })
    .first()
    .getByRole("button", { name: "Lançar acumulado", exact: true })
    .click();

  const catchUp = page.getByRole("dialog", { name: "Lançar acumulado" });
  await catchUp.getByLabel("Lançar acumulado em").fill("03/2026");
  await catchUp.getByLabel("Acumular a partir de").fill("01/2026");
  await catchUp.getByLabel("Até o mês de").fill("03/2026");
  await catchUp
    .getByRole("button", { name: "Lançar acumulado", exact: true })
    .click();
  await expect(page.getByText("Acumulado lançado com sucesso.")).toBeVisible({
    timeout: 60000,
  });

  // Março: a linha da Alice é o acumulado inteiro, 8 + 12 + 18.
  await page
    .getByRole("listitem", { name: "Selecionar Março de 2026" })
    .click();
  await expect(
    page.getByRole("button", { name: "BRUNO MORADIA", exact: true }),
  ).toHaveCount(1, { timeout: 60000 });

  const march = await downloadSheet(page, "marco");
  expect(march.fileName).toBe("notar-abatimento-cestas-basicas-2026-03.xlsx");

  const alice = march.sheet.getRow(7);
  expect(alice.getCell(4).value).toBe("ALICE MORADIA");
  expect(alice.getCell(2).value).toBe(38);
  expect(alice.getCell(3).value).toBe("Doações NFP - Jan/2026 até Mar/2026");
  // A data sai do mês do lançamento: março lança em 30/06.
  expect(alice.getCell(1).value.toISOString().slice(0, 10)).toBe("2026-06-30");

  // Quem não tem acumulado continua com as notas do mês.
  const bruno = march.sheet.getRow(8);
  expect(bruno.getCell(4).value).toBe("BRUNO MORADIA");
  expect(bruno.getCell(2).value).toBe(3);
  expect(bruno.getCell(3).value).toBe("Doações NFP - Mar/2026");
  expect(march.sheet.getCell(9, 4).value ?? null).toBeNull();

  // Fevereiro: as notas da Alice já foram no acumulado de março. Se saíssem
  // aqui também, o sistema de baixa as abateria duas vezes.
  await page
    .getByRole("listitem", { name: "Selecionar Fevereiro de 2026" })
    .click();
  await expect(
    page.getByRole("button", { name: "BRUNO MORADIA", exact: true }),
  ).toHaveCount(1, { timeout: 60000 });

  const february = await downloadSheet(page, "fevereiro");
  expect(february.fileName).toBe("notar-abatimento-cestas-basicas-2026-02.xlsx");

  const onlyRow = february.sheet.getRow(7);
  expect(onlyRow.getCell(4).value).toBe("BRUNO MORADIA");
  expect(onlyRow.getCell(2).value).toBe(5);
  expect(onlyRow.getCell(3).value).toBe("Doações NFP - Fev/2026");
  expect(february.sheet.getCell(8, 4).value ?? null).toBeNull();
});
