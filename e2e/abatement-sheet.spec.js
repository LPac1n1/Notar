import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import { expect, test } from "@playwright/test";

/**
 * A planilha de abatimento baixada pelo app abre no formato que o sistema de
 * baixa espera.
 *
 * O teste de unidade já compara o gerador com o modelo real, mas ele exercita a
 * função direto. Aqui o arquivo passa pelo caminho completo — consulta no
 * DuckDB do navegador, montagem do .xlsx e download — e é aberto de volta. É a
 * diferença entre "a função monta certo" e "o arquivo que a pessoa baixa está
 * certo".
 *
 * ATENÇÃO: o e2e roda com `VITE_NOTAR_AUTH_MODE=local`, em que o DuckDB é só
 * memória. Um `page.goto()` no meio do teste APAGA tudo — navegue por clique.
 */
test("o arquivo baixado tem o cabeçalho do modelo e uma linha por doador", async ({
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
  const dialog = page.getByRole("dialog", { name: "Restaurar backup" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Restaurar backup" })
    .click({ force: true });
  await expect(page.getByText("Backup importado:")).toBeVisible({
    timeout: 120000,
  });

  await page.getByRole("link", { name: "Gestão Mensal" }).click();
  const secao = page
    .getByRole("heading", { name: "Resumo mensal" })
    .locator("xpath=ancestor::section[1]");
  await secao.locator('input[name="referenceMonth"]').fill("01/2026");

  const download = page.waitForEvent("download", { timeout: 120000 });
  await page.getByRole("button", { name: "Planilha de abatimento" }).click();
  const arquivo = await download;

  // A fixture tem uma demanda só, então baixa a planilha direta em vez do zip.
  expect(arquivo.suggestedFilename()).toMatch(/\.xlsx$/);

  const destino = path.join(os.tmpdir(), "notar-abatimento-e2e.xlsx");
  await arquivo.saveAs(destino);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(destino);
  const planilha = workbook.worksheets[0];

  // Bloco de parâmetros do modelo.
  expect(planilha.name).toBe("Planilha1");
  expect(planilha.getCell("A1").value).toBe("AGENCA");
  // O gabarito traz 0, mas o sistema de baixa espera 1. Como agência e conta
  // entram na chave única do destino, o valor é verificado aqui no arquivo
  // realmente baixado, e não só no gerador.
  expect(planilha.getCell("B1").value).toBe(1);
  expect(planilha.getCell("B2").value).toBe(1);
  expect(planilha.getCell("A3").value).toBe("COD. BANCO");
  expect(planilha.getCell("B3").value).toBe("NFP2607");

  // Cabeçalho na linha 6, dados a partir da 7.
  expect(planilha.getCell("A6").value).toBe("DATA");
  expect(planilha.getCell("B6").value).toBe("VALOR");
  expect(planilha.getCell("C6").value).toBe("DESCRIÇÃO");
  expect(planilha.getCell("D6").value).toBe("NOME");
  expect(planilha.getCell("E6").value).toBe("CPF");

  const primeira = planilha.getRow(7);
  expect(primeira.getCell(4).value).toBeTruthy();
  // VALOR é a quantidade de doações — número, para o destino somar, com
  // formato de moeda na exibição.
  expect(typeof primeira.getCell(2).value).toBe("number");
  expect(primeira.getCell(2).value).toBeGreaterThan(0);
  expect(primeira.getCell(2).numFmt).toBe("[$R$-416] #,##0.00");

  // As linhas de dado saem emolduradas como o cabeçalho. Faltava borda na
  // primeira versão, porque o modelo de referência é um gabarito vazio.
  expect(Object.keys(primeira.getCell(1).border ?? {}).sort()).toEqual([
    "bottom",
    "left",
    "right",
    "top",
  ]);
  // A data é derivada da competência, não do dia da geração: último dia do
  // terceiro mês seguinte. Janeiro lança em 30/04 — abril tem 30 dias, o que
  // distingue "último dia do mês" de um dia 31 fixo.
  expect(primeira.getCell(1).value instanceof Date).toBe(true);
  expect(primeira.getCell(1).value.toISOString().slice(0, 10)).toBe("2026-04-30");
  // A descrição já sai pronta no texto que o destino espera.
  expect(String(primeira.getCell(3).value)).toContain("Doações NFP");
});

/**
 * Sem mês selecionado, o mesmo botão gera a planilha de TODOS os meses
 * pendentes, somados por CPF.
 *
 * A fixture tem janeiro a março para os dois doadores, e nenhum mês marcado —
 * então tudo está pendente: Alice 8 + 12 + 18 = 38, Bruno 4 + 5 + 3 = 12. A
 * soma e o "até" só batem se os três meses tiverem entrado na mesma linha.
 */
test("sem mês selecionado, a planilha soma os meses pendentes de cada CPF", async ({
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
  const dialog = page.getByRole("dialog", { name: "Restaurar backup" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Restaurar backup" })
    .click({ force: true });
  await expect(page.getByText("Backup importado:")).toBeVisible({
    timeout: 120000,
  });

  await page.getByRole("link", { name: "Gestão Mensal" }).click();

  // A Gestão Mensal abre ancorada no mês mais recente. Desmarcar o card dele
  // no carrossel é o caminho da interface para "nenhum mês".
  await page
    .getByRole("listitem", { name: "Limpar seleção de Março de 2026" })
    .click();

  const download = page.waitForEvent("download", { timeout: 120000 });
  await page.getByRole("button", { name: "Planilha dos pendentes" }).click();
  const arquivo = await download;

  expect(arquivo.suggestedFilename()).toBe(
    "notar-abatimento-cestas-basicas-pendentes.xlsx",
  );

  const destino = path.join(os.tmpdir(), "notar-abatimento-pendentes-e2e.xlsx");
  await arquivo.saveAs(destino);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(destino);
  const planilha = workbook.worksheets[0];

  // Mesmo cabeçalho do modelo: é a mesma importação no destino.
  expect(planilha.getCell("A6").value).toBe("DATA");
  expect(planilha.getCell("B1").value).toBe(1);

  const alice = planilha.getRow(7);
  expect(alice.getCell(4).value).toBe("ALICE MORADIA");
  expect(alice.getCell(2).value).toBe(38);
  expect(alice.getCell(3).value).toBe("Doações NFP - Jan/2026 até Mar/2026");
  // A data sai do mês mais recente somado: março lança em 30/06.
  expect(alice.getCell(1).value.toISOString().slice(0, 10)).toBe("2026-06-30");

  const bruno = planilha.getRow(8);
  expect(bruno.getCell(4).value).toBe("BRUNO MORADIA");
  expect(bruno.getCell(2).value).toBe(12);
  expect(bruno.getCell(3).value).toBe("Doações NFP - Jan/2026 até Mar/2026");

  // Uma linha por CPF, não uma por mês.
  expect(planilha.getCell(9, 4).value ?? null).toBeNull();

  // Agora fevereiro é abatido para os dois. Fevereiro TEVE doação, então ele
  // parte o intervalo: "até" diria que ele está no total da planilha.
  const secao = page
    .getByRole("heading", { name: "Resumo mensal" })
    .locator("xpath=ancestor::section[1]");
  await secao.locator('input[name="referenceMonth"]').fill("02/2026");
  await page.getByRole("button", { name: "Abater em massa", exact: true }).click();
  const abate = page.getByRole("dialog", {
    name: "Abatimento em massa",
    exact: true,
  });
  await abate.getByRole("button", { name: /Fevereiro de 2026/ }).click();
  await abate
    .getByRole("button", { name: "Abater 2 selecionado(s)", exact: true })
    .click();
  await expect(abate).toHaveCount(0);

  await secao.locator('input[name="referenceMonth"]').fill("");
  const segundoDownload = page.waitForEvent("download", { timeout: 120000 });
  await page.getByRole("button", { name: "Planilha dos pendentes" }).click();
  const segundoArquivo = await segundoDownload;

  const segundoDestino = path.join(
    os.tmpdir(),
    "notar-abatimento-pendentes-sem-fevereiro-e2e.xlsx",
  );
  await segundoArquivo.saveAs(segundoDestino);
  const segundoWorkbook = new ExcelJS.Workbook();
  await segundoWorkbook.xlsx.readFile(segundoDestino);
  const semFevereiro = segundoWorkbook.worksheets[0];

  // Alice 8 + 18, Bruno 4 + 3: fevereiro saiu da soma e da descrição.
  expect(semFevereiro.getRow(7).getCell(2).value).toBe(26);
  expect(semFevereiro.getRow(7).getCell(3).value).toBe(
    "Doações NFP - Jan/2026; Mar/2026",
  );
  expect(semFevereiro.getRow(8).getCell(2).value).toBe(7);
  expect(semFevereiro.getRow(8).getCell(3).value).toBe(
    "Doações NFP - Jan/2026; Mar/2026",
  );
});
