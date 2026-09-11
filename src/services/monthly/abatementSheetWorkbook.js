/**
 * Planilha de abatimento no formato que o sistema de baixa espera.
 *
 * O modelo (`base_extrato.xlsx`) não é uma tabela simples: tem um bloco de
 * cabeçalho com três parâmetros fixos, uma nota explicativa mesclada, duas
 * linhas em branco e só então o cabeçalho das colunas. O sistema de destino lê
 * essa estrutura, então ela é reproduzida na íntegra — inclusive o que parece
 * decoração.
 *
 * A chave única do destino é `Agencia, Conta, Cod. Banco, Data, Valor, Nome`
 * (está escrita na própria nota do modelo). Como os três primeiros são
 * constantes, o que de fato distingue uma linha é (Data, Valor, Nome) — e é
 * por isso que a data tem de ser derivada da COMPETÊNCIA e não do dia em que o
 * arquivo foi gerado: gerar a mesma planilha duas vezes tem de produzir a
 * mesma chave, senão o destino trataria a segunda importação como lançamentos
 * novos em vez de reconhecer os mesmos. Ver `toAbatementDate`.
 *
 * Não importa banco nem DuckDB: recebe as linhas prontas. Assim o teste
 * consegue gerar o arquivo e lê-lo de volta, comparando com o modelo real.
 */

/**
 * Valores fixos do modelo, copiados do arquivo de referência.
 *
 * `MARCADOR` é uma cadeia de 40 caracteres hexadecimais (SHA-1) que vive na
 * coluna 235 da linha 3 do modelo, fora do campo de visão. Não corresponde a
 * nenhum hash óbvio do conteúdo, e o modelo de referência não tem linha de
 * dado alguma — então não pode ser soma de verificação do que foi preenchido.
 * É reproduzido tal e qual porque o custo de mantê-lo é zero e o de removê-lo,
 * caso o destino o utilize, seria a importação falhar sem explicação.
 */
export const ABATEMENT_TEMPLATE = {
  sheetName: "Planilha1",
  // O gabarito vem com 0 nos dois, mas o valor que o sistema de baixa espera
  // é 1. Como agência e conta entram na chave única do destino, mudá-los
  // altera a chave de TODAS as linhas: uma competência já exportada com 0
  // precisa ser reexportada para casar com o que for enviado daqui em diante.
  agencia: 1,
  conta: 1,
  bankCode: "NFP2607",
  noteIntro: "Campos que irão compor a chave única:\n",
  noteFields: "Agencia, Conta, Cod. Banco, Data, Valor, Nome",
  marker: "863ed26b1a7fa9475a9d56fdc99b357dca790cf6",
  markerColumn: 235,
  headerRow: 6,
  columns: ["DATA", "VALOR", "DESCRIÇÃO", "NOME", "CPF"],
  columnWidths: [14.93, 14.79, 68.21, 58.85, 49.11],
  headerFill: "FF729FCF",
  fontName: "Arial",
  fontSize: 12,
  dateFormat: "dd/mm/yyyy",
  /**
   * Formato de moeda da coluna VALOR.
   *
   * O modelo de referência não traz exemplo — ele é um gabarito sem linha de
   * dado —, então o formato veio de como o sistema de baixa trata a coluna.
   *
   * `[$R$-416]` fixa a região brasileira (416 é o identificador do pt-BR). Sem
   * ela, os separadores do código `#,##0.00` seguem a configuração de quem
   * abre o arquivo, e o mesmo valor sai `R$ 1.234,00` numa máquina e
   * `R$ 1,234.00` em outra — verificado ao renderizar a planilha num ambiente
   * de locale inglês.
   */
  currencyFormat: "[$R$-416] #,##0.00",
};

/**
 * Quantos meses separam a competência da data que vai na planilha.
 *
 * A nota de abril é lançada em julho; a de maio, em agosto. É o intervalo do
 * ciclo de crédito da NFP, não uma escolha nossa.
 */
export const ABATEMENT_MONTHS_AHEAD = 3;

const BORDER = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

function applyLabelStyle(cell) {
  cell.font = {
    name: ABATEMENT_TEMPLATE.fontName,
    size: ABATEMENT_TEMPLATE.fontSize,
    bold: true,
  };
  cell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: ABATEMENT_TEMPLATE.headerFill },
  };
  cell.border = BORDER;
}

function applyValueStyle(cell) {
  cell.font = {
    name: ABATEMENT_TEMPLATE.fontName,
    size: ABATEMENT_TEMPLATE.fontSize,
  };
  cell.border = BORDER;
}

/**
 * Estilo das linhas de doador.
 *
 * A borda é a mesma do cabeçalho. O modelo de referência não tem linha de dado
 * para copiar — ele é um gabarito vazio —, então a primeira versão saiu sem
 * borda alguma e a tabela ficava solta na tela abaixo de um cabeçalho
 * emoldurado.
 */
function applyRowStyle(cell) {
  cell.font = {
    name: ABATEMENT_TEMPLATE.fontName,
    size: ABATEMENT_TEMPLATE.fontSize,
  };
  cell.border = BORDER;
}

/**
 * A data que vai na planilha, a partir da competência.
 *
 * É o ÚLTIMO DIA do mês três meses à frente da competência: a nota de abril
 * sai com 31/07, a de maio com 31/08. Não é o dia da geração — se fosse,
 * reexportar o mesmo mês produziria uma chave única diferente e o sistema de
 * baixa trataria os mesmos lançamentos como novos.
 *
 * O último dia sai de `Date.UTC(ano, mêsAlvo, 0)`: o dia 0 de um mês é o
 * último do anterior. Assim fevereiro fecha em 28 ou 29 conforme o ano, e
 * abril em 30, sem tabela de dias por mês. Os dois exemplos conhecidos caem em
 * meses de 31 dias e não distinguem "último dia" de "dia 31" — vale conferir
 * uma competência de novembro, que cai em fevereiro.
 *
 * Construída em UTC de propósito. O ExcelJS converte `Date` para o serial do
 * Excel pelo valor UTC; uma data local, em UTC-3, viraria as 21:00 do dia
 * anterior e a planilha mostraria o dia errado — o mesmo defeito de fuso que
 * já apareceu na formatação de datas da interface.
 */
export function toAbatementDate(referenceMonth) {
  const match = /^(\d{4})-(\d{2})/.exec(String(referenceMonth ?? ""));

  if (!match) {
    return null;
  }

  const [, year, month] = match;

  return new Date(
    Date.UTC(Number(year), Number(month) + ABATEMENT_MONTHS_AHEAD, 0),
  );
}

/**
 * Monta o arquivo .xlsx com o bloco de cabeçalho do modelo e uma linha por
 * doador.
 *
 * `ExcelJS` entra por import dinâmico, como nos pipelines de importação: são
 * centenas de KB que só fazem sentido no momento em que alguém exporta.
 */
export async function buildAbatementWorkbookBytes({ rows = [], referenceMonth }) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(ABATEMENT_TEMPLATE.sheetName, {
    views: [{ zoomScale: 75, zoomScaleNormal: 75 }],
  });

  ABATEMENT_TEMPLATE.columnWidths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  const parameters = [
    ["AGENCA", ABATEMENT_TEMPLATE.agencia],
    ["CONTA", ABATEMENT_TEMPLATE.conta],
    ["COD. BANCO", ABATEMENT_TEMPLATE.bankCode],
  ];

  parameters.forEach(([label, value], index) => {
    const rowNumber = index + 1;
    const labelCell = sheet.getCell(rowNumber, 1);
    labelCell.value = label;
    applyLabelStyle(labelCell);

    const valueCell = sheet.getCell(rowNumber, 2);
    valueCell.value = value;
    applyValueStyle(valueCell);
  });

  // A nota explicativa ocupa D1:E3 no modelo, com a segunda linha em negrito.
  sheet.mergeCells("D1:E3");
  const noteCell = sheet.getCell("D1");
  noteCell.value = {
    richText: [
      {
        font: { name: ABATEMENT_TEMPLATE.fontName, size: ABATEMENT_TEMPLATE.fontSize },
        text: ABATEMENT_TEMPLATE.noteIntro,
      },
      {
        font: {
          name: ABATEMENT_TEMPLATE.fontName,
          size: ABATEMENT_TEMPLATE.fontSize,
          bold: true,
        },
        text: ABATEMENT_TEMPLATE.noteFields,
      },
    ],
  };
  noteCell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };

  const markerCell = sheet.getCell(3, ABATEMENT_TEMPLATE.markerColumn);
  markerCell.value = ABATEMENT_TEMPLATE.marker;
  markerCell.font = { name: ABATEMENT_TEMPLATE.fontName, size: 10 };

  // Linhas 4 e 5 ficam em branco, como no modelo.
  ABATEMENT_TEMPLATE.columns.forEach((label, index) => {
    const cell = sheet.getCell(ABATEMENT_TEMPLATE.headerRow, index + 1);
    cell.value = label;
    applyLabelStyle(cell);
  });

  const abatementDate = toAbatementDate(referenceMonth);

  rows.forEach((row, index) => {
    const rowNumber = ABATEMENT_TEMPLATE.headerRow + 1 + index;

    const dateCell = sheet.getCell(rowNumber, 1);
    // Na planilha de pendentes cada linha junta meses diferentes, então a
    // data sai do ÚLTIMO mês daquela linha (`row.referenceMonth`). Na planilha
    // de um mês só, as linhas não trazem mês e todas usam o do arquivo.
    dateCell.value = row.referenceMonth
      ? toAbatementDate(row.referenceMonth)
      : abatementDate;
    dateCell.numFmt = ABATEMENT_TEMPLATE.dateFormat;

    // "Quantidade de doações" é o VALOR do modelo — número, não texto, para o
    // destino somar sem depender de conversão, e em formato de moeda porque é
    // como o sistema de baixa trata a coluna.
    const valueCell = sheet.getCell(rowNumber, 2);
    valueCell.value = Number(row.notesCount ?? 0);
    valueCell.numFmt = ABATEMENT_TEMPLATE.currencyFormat;

    sheet.getCell(rowNumber, 3).value = row.description ?? "";
    // Identidade do TITULAR quando a linha é de um auxiliar — o abatimento é
    // lançado na conta de quem responde pelo grupo. Quem distingue as linhas
    // é a descrição, que traz o nome de cada pessoa do grupo.
    sheet.getCell(rowNumber, 4).value = row.sheetName ?? row.donorName ?? "";
    // CPF como TEXTO: como número perderia o zero à esquerda de quem tem CPF
    // começando em zero.
    sheet.getCell(rowNumber, 5).value = row.sheetCpf ?? row.cpf ?? "";

    for (let column = 1; column <= ABATEMENT_TEMPLATE.columns.length; column += 1) {
      applyRowStyle(sheet.getCell(rowNumber, column));
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}
