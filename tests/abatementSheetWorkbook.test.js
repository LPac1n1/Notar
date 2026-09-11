import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import {
  ABATEMENT_TEMPLATE,
  buildAbatementWorkbookBytes,
  toAbatementDate,
} from "../src/services/monthly/abatementSheetWorkbook.js";

/**
 * A planilha de abatimento tem de sair no formato que o sistema de baixa lê.
 *
 * O modelo real está em `tests/fixtures/base-extrato-modelo.xlsx` — é o arquivo
 * que o usuário forneceu. Os testes comparam o que geramos CONTRA ELE, em vez
 * de contra uma descrição do formato: uma descrição pode estar errada desde o
 * começo, e o arquivo não.
 *
 * A estrutura não é uma tabela simples. São três parâmetros no topo, uma nota
 * mesclada em D1:E3, duas linhas em branco e só então o cabeçalho das colunas
 * na linha 6. Errar qualquer uma dessas posições faz o destino ler a planilha
 * inteira deslocada.
 *
 * O modelo é um gabarito VAZIO: não tem nenhuma linha de dado. Tudo que diz
 * respeito às linhas de doador — borda, formato de moeda, data — veio de como o
 * sistema de destino trata a planilha, e não de cópia. É justamente onde a
 * primeira versão errou, e por isso esses pontos têm teste próprio.
 */

const MODELO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "base-extrato-modelo.xlsx",
);

const LINHAS = [
  {
    cpf: "529.982.247-25",
    donorName: "ANA MARIA DE SOUZA",
    notesCount: 12,
    description: "Doações NFP - Abr/2026",
  },
  {
    cpf: "011.444.777-35",
    donorName: "BRUNO SILVA",
    notesCount: 5,
    description: "Doações NFP - BRUNO SILVA - Abr/2026",
  },
];

async function carregarModelo() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(MODELO);
  return workbook.worksheets[0];
}

async function gerar(options = {}) {
  const bytes = await buildAbatementWorkbookBytes({
    rows: LINHAS,
    referenceMonth: "2026-04-01",
    ...options,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook.worksheets[0];
}

function textoDe(valor) {
  if (valor && typeof valor === "object" && Array.isArray(valor.richText)) {
    return valor.richText.map((parte) => parte.text).join("");
  }

  return valor;
}

function ladosDaBorda(cell) {
  return Object.keys(cell.border ?? {}).sort().join(",");
}

test("o bloco de cabeçalho reproduz o modelo célula a célula", async () => {
  const modelo = await carregarModelo();
  const gerado = await gerar();

  // Endereços conferidos contra o modelo: mudar qualquer um desloca a leitura
  // do sistema de destino.
  //
  // B1 e B2 (agência e conta) ficam de FORA desta comparação de propósito: o
  // gabarito traz 0 nos dois, e o valor que o sistema de baixa espera é 1.
  // São os únicos pontos em que divergimos do modelo, e a divergência é
  // deliberada — por isso têm asserção própria logo abaixo, em vez de
  // simplesmente não serem verificados.
  const enderecos = ["A1", "A2", "A3", "B3", "D1"];

  for (const endereco of enderecos) {
    assert.deepEqual(
      textoDe(gerado.getCell(endereco).value),
      textoDe(modelo.getCell(endereco).value),
      `${endereco} divergiu do modelo`,
    );
  }

  assert.equal(gerado.getCell("B1").value, 1, "AGENCA sai como 1, não 0");
  assert.equal(gerado.getCell("B2").value, 1, "CONTA sai como 1, não 0");

  // O marcador escondido na coluna 235 da linha 3. Não é decoração conhecida —
  // é reproduzido porque o destino pode consultá-lo, e removê-lo faria a
  // importação falhar sem explicação visível.
  assert.equal(
    gerado.getCell(3, ABATEMENT_TEMPLATE.markerColumn).value,
    modelo.getCell(3, ABATEMENT_TEMPLATE.markerColumn).value,
  );
});

test("o cabeçalho das colunas fica na linha 6, com os mesmos rótulos", async () => {
  const modelo = await carregarModelo();
  const gerado = await gerar();

  for (let coluna = 1; coluna <= ABATEMENT_TEMPLATE.columns.length; coluna += 1) {
    assert.equal(
      gerado.getCell(ABATEMENT_TEMPLATE.headerRow, coluna).value,
      modelo.getCell(ABATEMENT_TEMPLATE.headerRow, coluna).value,
      `coluna ${coluna} do cabeçalho divergiu`,
    );
  }

  // As linhas 4 e 5 existem em branco no modelo. Preenchê-las empurraria os
  // dados uma linha e o destino leria o cabeçalho como registro.
  for (const linha of [4, 5]) {
    for (let coluna = 1; coluna <= 5; coluna += 1) {
      assert.equal(
        gerado.getCell(linha, coluna).value ?? null,
        null,
        `L${linha}C${coluna} deveria estar vazia`,
      );
    }
  }
});

test("a planilha, a mesclagem e as larguras são as do modelo", async () => {
  const modelo = await carregarModelo();
  const gerado = await gerar();

  assert.equal(gerado.name, modelo.name);
  assert.deepEqual(gerado.model.merges, modelo.model.merges);

  for (let coluna = 1; coluna <= ABATEMENT_TEMPLATE.columns.length; coluna += 1) {
    assert.equal(
      gerado.getColumn(coluna).width,
      modelo.getColumn(coluna).width,
      `largura da coluna ${coluna} divergiu`,
    );
  }
});

test("cada doador vira uma linha a partir da 7", async () => {
  const gerado = await gerar();

  const primeira = gerado.getRow(7);
  assert.equal(primeira.getCell(2).value, 12, "VALOR é a quantidade de doações");
  assert.equal(primeira.getCell(3).value, "Doações NFP - Abr/2026");
  assert.equal(primeira.getCell(4).value, "ANA MARIA DE SOUZA");
  assert.equal(primeira.getCell(5).value, "529.982.247-25");

  const segunda = gerado.getRow(8);
  assert.equal(segunda.getCell(2).value, 5);
  assert.equal(segunda.getCell(4).value, "BRUNO SILVA");

  // Nada além das duas linhas de dado.
  assert.equal(gerado.getCell(9, 4).value ?? null, null);
});

test("as linhas de doador têm a mesma borda do cabeçalho", async () => {
  const modelo = await carregarModelo();
  const gerado = await gerar();

  // A primeira versão saiu sem borda nenhuma nas linhas de dado, porque o
  // modelo é um gabarito vazio e não havia o que copiar.
  const bordaDoCabecalho = ladosDaBorda(modelo.getCell("A6"));
  assert.equal(bordaDoCabecalho, "bottom,left,right,top");

  for (const linha of [7, 8]) {
    for (let coluna = 1; coluna <= ABATEMENT_TEMPLATE.columns.length; coluna += 1) {
      assert.equal(
        ladosDaBorda(gerado.getCell(linha, coluna)),
        bordaDoCabecalho,
        `L${linha}C${coluna} está sem os quatro lados da borda`,
      );
    }
  }

  // E a moldura para onde os dados param — senão a tabela desceria pela
  // planilha inteira.
  assert.equal(ladosDaBorda(gerado.getCell(9, 1)), "");
});

test("VALOR sai formatado em reais, com a região fixada", async () => {
  const gerado = await gerar();
  const celula = gerado.getCell(7, 2);

  // `[$R$-416]` fixa o pt-BR. Sem isso os separadores seguem a máquina de quem
  // abre, e o mesmo número sai `R$ 1.234,00` num lugar e `R$ 1,234.00` noutro.
  assert.equal(celula.numFmt, "[$R$-416] #,##0.00");
  // O valor continua sendo a quantidade de doações — o formato é de exibição.
  assert.equal(celula.value, 12);
  assert.equal(typeof celula.value, "number");
});

test("a data é o último dia do terceiro mês após a competência", async () => {
  const gerado = await gerar();
  const celula = gerado.getCell(7, 1);

  // Precisa ser data de verdade, não texto: a coluna se chama DATA e entra na
  // chave única do destino.
  assert.ok(celula.value instanceof Date, "a célula deveria conter uma data");
  // Competência de abril lança em 31/07.
  assert.equal(celula.value.toISOString().slice(0, 10), "2026-07-31");
  assert.equal(celula.numFmt, "dd/mm/yyyy");
});

test("o último dia acompanha o tamanho do mês e a virada de ano", () => {
  // Os dois exemplos conhecidos caem em meses de 31 dias e não distinguiriam
  // "último dia do mês" de "dia 31 fixo".
  assert.equal(toAbatementDate("2026-04-01").toISOString().slice(0, 10), "2026-07-31");
  assert.equal(toAbatementDate("2026-05-01").toISOString().slice(0, 10), "2026-08-31");

  // Estes distinguem.
  assert.equal(toAbatementDate("2026-01-01").toISOString().slice(0, 10), "2026-04-30");
  assert.equal(toAbatementDate("2025-11-01").toISOString().slice(0, 10), "2026-02-28");
  assert.equal(toAbatementDate("2023-11-01").toISOString().slice(0, 10), "2024-02-29");
  assert.equal(toAbatementDate("2025-10-01").toISOString().slice(0, 10), "2026-01-31");

  assert.equal(toAbatementDate(""), null);
  assert.equal(toAbatementDate("qualquer coisa"), null);
});

test("a data não desliza de dia por causa do fuso", () => {
  // Construir a data em horário local faria, em UTC-3, o valor cair no dia
  // anterior. É o mesmo defeito que já apareceu na formatação de datas da
  // interface.
  const data = toAbatementDate("2026-04-01");

  assert.equal(data.getUTCDate(), 31);
  assert.equal(data.getUTCMonth(), 6, "julho é o mês de índice 6");
  assert.equal(data.getUTCHours(), 0);
});

test("gerar duas vezes o mesmo mês produz a mesma chave única", async () => {
  // A chave do destino é (Agencia, Conta, Cod. Banco, Data, Valor, Nome). Se a
  // data viesse do dia da geração, reexportar o mesmo mês criaria lançamentos
  // novos em vez de o destino reconhecer os mesmos.
  const primeira = await gerar();
  const segunda = await gerar();

  const chave = (planilha) =>
    [7, 8]
      .map((linha) =>
        [1, 2, 4]
          .map((coluna) => {
            const valor = planilha.getCell(linha, coluna).value;
            return valor instanceof Date ? valor.toISOString() : valor;
          })
          .join("|"),
      )
      .join("\n");

  assert.equal(chave(primeira), chave(segunda));
});

test("sem doador nenhum, a planilha sai só com o cabeçalho", async () => {
  const gerado = await gerar({ rows: [] });

  assert.equal(gerado.getCell(ABATEMENT_TEMPLATE.headerRow, 1).value, "DATA");
  assert.equal(gerado.getCell(7, 1).value ?? null, null);
});

test("a linha de um auxiliar sai com o nome e o CPF do titular", async () => {
  // A planilha é importada num sistema que abate na conta de quem responde
  // pelo grupo. Por isso NOME e CPF são os do titular, enquanto a DESCRIÇÃO
  // continua nomeando a pessoa que de fato mandou as notas — sem ela, não
  // haveria como saber a quem pertence cada lançamento do mesmo titular.
  const gerado = await gerar({
    rows: [
      {
        cpf: "222.333.444-56",
        donorName: "JOAO AUXILIAR",
        sheetName: "MARIA SILVA",
        sheetCpf: "111.444.777-35",
        notesCount: 5,
        description: "Doações NFP - JOAO AUXILIAR - Abr/2026",
      },
    ],
  });

  const linha = gerado.getRow(7);
  assert.equal(linha.getCell(4).value, "MARIA SILVA");
  assert.equal(linha.getCell(5).value, "111.444.777-35");
  // O auxiliar não some: é ele que a descrição identifica.
  assert.equal(linha.getCell(3).value, "Doações NFP - JOAO AUXILIAR - Abr/2026");
  assert.equal(linha.getCell(2).value, 5);
});

test("sem identidade de planilha, a linha vale por si", async () => {
  // Titular comum não tem `sheetName`/`sheetCpf` vindos de um join — e uma
  // linha órfã (auxiliar cuja pessoa de referência não resolve) também não.
  // Nos dois casos a linha precisa continuar saindo com a própria identidade
  // em vez de vir em branco.
  const gerado = await gerar({
    rows: [
      {
        cpf: "529.982.247-25",
        donorName: "ANA MARIA DE SOUZA",
        notesCount: 3,
        description: "Doações NFP - Abr/2026",
      },
    ],
  });

  const linha = gerado.getRow(7);
  assert.equal(linha.getCell(4).value, "ANA MARIA DE SOUZA");
  assert.equal(linha.getCell(5).value, "529.982.247-25");
});

test("na planilha de pendentes, cada linha tira a data do próprio mês mais recente", async () => {
  // Não existe "mês do arquivo" quando a planilha soma pendências: um CPF pode
  // estar devendo janeiro e fevereiro, outro janeiro a março. Uma data única
  // para o arquivo inteiro daria a um deles a chave única do outro ciclo.
  const gerado = await gerar({
    referenceMonth: undefined,
    rows: [
      {
        cpf: "529.982.247-25",
        donorName: "ANA MARIA DE SOUZA",
        notesCount: 20,
        description: "Doações NFP - Jan/2026 e Fev/2026",
        referenceMonth: "2026-02-01",
      },
      {
        cpf: "011.444.777-35",
        donorName: "BRUNO SILVA",
        notesCount: 9,
        description: "Doações NFP - Jan/2026 até Mar/2026",
        referenceMonth: "2026-03-01",
      },
    ],
  });

  // Fevereiro lança em 31/05; março, em 30/06.
  assert.equal(gerado.getCell(7, 1).value.toISOString().slice(0, 10), "2026-05-31");
  assert.equal(gerado.getCell(8, 1).value.toISOString().slice(0, 10), "2026-06-30");
  assert.equal(gerado.getCell(7, 2).value, 20);
  assert.equal(gerado.getCell(8, 3).value, "Doações NFP - Jan/2026 até Mar/2026");
});
