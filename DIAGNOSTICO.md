# Notar — diagnóstico

> 01/10/2026, commit 299 (`ee9d06e`). Nada no código foi alterado para produzir
> este documento. As medições e reproduções rodaram com scripts temporários
> fora do repositório, contra dados sintéticos e um storage falso local — o
> Supabase real e os dados reais não foram tocados.

**Legenda de confiança**

| Marca | Significa |
|---|---|
| **Reproduzido** | Vi acontecer rodando o código de produção. |
| **Medido** | Número obtido no navegador (Edge headless, servidor Vite de dev). |
| **Lido** | Conclusão de leitura do código; não executei o cenário. |
| **Suposição** | Inferência. Está repetida nas perguntas do fim. |

Impacto e esforço: **A**lto / **M**édio / **B**aixo.

---

## 1. Resumo

O sistema está em bom estado geral: 259/259 testes, lint limpo, build ok,
SQL parametrizado de ponta a ponta, sem segredo no histórico do git. A
documentação interna é incomumente boa.

> **Atualização com os dados reais (01/10/2026, fim do dia).** Analisei o
> `dados.json` baixado do Supabase — só agregados: contagens, tamanhos, datas.
> Os números abaixo são do banco de verdade, não de simulação. Detalhe na
> seção 3.0.

**O estado real, em uma tabela**

| | Hoje |
|---|---|
| Arquivo na nuvem | **45,6 MB** comprimido (294 MB de JSON), 866.871 linhas |
| Limite do plano gratuito | 50 MB por arquivo — **faltam ~4 MB; o próximo mês importado soma ~12 MB** |
| Última gravação bem-sucedida na nuvem | 27/09/2026 |
| Abrir em outro computador | **2,5 min** de reinserção + o download de 45 MB |
| A cada alteração | reenvia os 45 MB; tela congelada por **4,3 s** |
| Importar uma planilha | a conciliação sozinha leva **11,8 min** |

1. **A sincronização quebra na próxima importação.** O arquivo está a 4 MB do
   limite de 50 MB do plano gratuito. Importar junho/2026 leva o arquivo a
   ~57 MB e todo upload passa a ser recusado. O limite de string do navegador
   (item S0) viria uns três meses depois.
2. **A lentidão ao importar tem uma causa só, e a correção é de poucas
   linhas.** Uma condição com `OR` na conciliação faz o banco comparar tudo
   contra tudo. Reescrita de forma logicamente equivalente, a conciliação
   inteira caiu de **707 s para 9,7 s** no banco real, com resultado
   **idêntico** nos seis status (item I1).
3. **23% das notas válidas estão fora da conciliação, provavelmente por
   engano.** 57.432 notas de doação caem em "Repetidas" porque a checagem de
   repetição olha só CNPJ + número. Em 24.040 dos 24.066 grupos os **valores
   são diferentes** — parecem ser notas distintas. Com o valor na chave,
   57.345 delas pareariam uma a uma. São **R$ 28,7 mil de crédito (9% do
   total)** que hoje não aparecem para nenhum doador, e a fatia cresce:
   21.300 só em maio (item R1).
4. **Abrir em outro computador:** 2,5 min hoje; 17 s no protótipo com os
   dados reais.
5. **Dois bugs fazem a sincronização mentir** (S1, S2), reproduzidos. Com
   uploads de 45 MB, a janela do primeiro é de dezenas de segundos a cada
   alteração.
6. O histórico de erros do próprio banco registra **46 falhas de
   sincronização**, 4 a 5 por mês desde julho, quase todas "Failed to fetch"
   — o esperado para um envio único de 45 MB.

---

## 2. O que foi executado

| Verificação | Resultado |
|---|---|
| `npm test` | **259/259** em ~105 s |
| `npm run lint` | 0 erros, 0 avisos |
| `npm run build` | ok em 1,5 s; 1 aviso (`INEFFECTIVE_DYNAMIC_IMPORT`) |
| `npm run test:e2e` | não rodava: o Playwright 1.59.1 pede o Chromium build 1217 e só havia o 1243. Instalado depois, com autorização — resultado na linha abaixo |
| e2e, config oficial (Chromium) | 96 testes: **94 passaram, 2 falharam** em paralelo; os 2 **passaram** rodados sozinhos (`--workers=1`) |
| e2e com Edge (antes de instalar o Chromium) | 93 passaram, 3 falharam — **outros** 3, que também passaram sozinhos. Falha diferente a cada rodada = instabilidade por carga, não defeito (item T4) |
| Cópia local × GitHub | idênticas, exceto 4 arquivos órfãos só na cópia local (item C2) |
| `npm audit` | 4 vulnerabilidades (1 alta, 3 moderadas), todas em dependência transitiva |

**A pasta de trabalho não é um repositório git.** `C:\...\Desktop\Notar` não tem
`.git`; li o histórico clonando o GitHub para uma pasta temporária. Isso
bloqueia a regra "um commit por mudança" — ver pergunta 1.

---

## 3. Sincronização — o achado principal

### 3.0 Dados reais

Fonte: `dados.json` baixado do bucket em 01/10/2026 (`exportedAt`
27/09/2026). Tudo rodou localmente; nada foi enviado à nuvem. Os scripts
imprimem só agregados. **Ressalva:** as mensagens de erro guardadas no
histórico trazem nomes de doadores, e dois apareceram na saída do script antes
de eu filtrar — não os reproduzo aqui (item SEC11).

**Conteúdo**

| Tabela | Linhas | JSON |
|---|---|---|
| `donation_notes` | 304.057 | 130 MB |
| `credit_notes` | 249.455 | 98 MB |
| `credit_reconciliation` | 306.895 | 63 MB |
| todas as outras 15 | 6.464 | 2,5 MB |

185 doadores (167 titulares ativos, 16 auxiliares, 2 inativos), 4 projetos, 8
demandas, 29 acumulados. 32 importações de doações e 32 de créditos, **todas
`.csv`**, todas `processed`, valor por nota sempre 1. Nenhum valor absurdo
(I3 não afetou estes dados).

**O volume não é constante — ele explodiu em outubro de 2025**

| Período | Notas de doação por mês |
|---|---|
| out/2023 – set/2025 | de 2 a 1.467 |
| out/2025 | 7.193 |
| nov/2025 – abr/2026 | 22 mil a 47 mil |
| mai/2026 | **87.332** |

Maio sozinho tem mais notas que os primeiros 25 meses somados. O sistema foi
dimensionado para o primeiro período.

**Tempos, com o banco real**

| Operação | Caminho atual | Alternativa medida |
|---|---|---|
| Abrir: descomprimir + interpretar | 4,3 s | 3,8 s (sem `JSON.parse`) |
| Abrir: reinserir as linhas | **142,8 s** | **12,8 s** (carga 3,2 s + fatiar/registrar 3,3 s + índices 6,3 s) |
| Salvar: exportar + comprimir | 5,9 s + 7,5 s, **tela congelada 4,3 s** | — |
| Conciliar créditos | **707 s** | **9,7 s**, resultado idêntico |

A conciliação original rodou parte do tempo em paralelo com outra medição; o
número tem margem de dezenas de segundos, não de ordem de grandeza.

**Tamanho por desenho** (calculado sobre o arquivo real)

| | JSON | Comprimido |
|---|---|---|
| Como está | 294 MB | 43,4 MiB |
| Sem `credit_reconciliation` (tabela derivada, reconstruível) | 231 MB | 26,8 MiB |
| Maior arquivo se fosse um por tabela **e por mês** (doações de mai/2026) | 37 MB | 3,8 MiB |

**Achados novos**

| # | Achado | Conf. | Impacto | Esforço |
|---|---|---|---|---|
| **I1** | **Uma condição `OR` torna a conciliação quadrática.** Em `creditReconcileEngine.js`, os passos `matched` e `divergent` usam `NOT EXISTS (… WHERE credit_note_id = X OR donation_note_id = Y)`. Com 115 mil linhas de "repetidas" já na tabela, o banco não consegue usar junção por igualdade. Trocar por dois `NOT EXISTS` ligados por `AND` é a mesma lógica (`NÃO (A OU B)` = `NÃO A E NÃO B`). Medido no banco real: **707 s → 9,7 s**, e as contagens dos seis status bateram exatamente com as gravadas no arquivo. Roda em toda importação, reimportação e exclusão. | Reproduzido (dados reais) | **A** | **B** |
| **R1** | **A checagem de repetição ignora o valor.** A documentação diz que a chave é CNPJ + número + valor, mas os passos `duplicate_*` agrupam só por `match_key` (CNPJ + número). Resultado no banco real: 57.432 doações e 57.432 créditos em "Repetidas", em 24.066 grupos — e em 24.040 deles os valores **diferem**. Com o valor na chave, 57.345 pareariam uma a uma. Só 19 grupos são linhas realmente idênticas. Crédito parado ali: **R$ 28.749** contra R$ 289.998 conciliados. Por mês: 1.214 em out/2025, 13.237 em abr/2026, 21.300 em mai/2026. | Medido (dados reais) | **A** — é regra de negócio; precisa da sua confirmação | **M** |
| **S12** | **O limite de 50 MB do plano gratuito chega antes do limite de string.** Arquivo em 45,6 MB; maio/2026 sozinho acrescentou ~12 MB. | Medido / Suposição sobre o limite exato do plano | **Crítico** | — |
| **S13** | **`credit_reconciliation` vai no snapshot sem precisar.** É tabela derivada, reconstruída inteira pela conciliação, e responde por 21% do JSON e **38% do arquivo comprimido** (são três UUIDs aleatórios por linha, que não comprimem). Tirá-la e reconstruir ao abrir — o que só é viável depois de I1 — leva o arquivo de 43,4 para 26,8 MiB. | Medido | **A** como fôlego imediato | **B–M** |
| **SEC11** | As mensagens de erro gravadas em `action_history` incluem o nome do doador (ex.: "Este CPF já está vinculado a …"). O log de erros exportável em Configurações carrega esses nomes. | Medido | B | B |

### 3.0b Simulação a 80 mil notas por mês (projeção)

Dados sintéticos gerados por SQL dentro do DuckDB, com o mesmo formato das
linhas reais (ids `uuid()`, chave de conciliação, 1.500 doadores, 4.000 CPFs
por planilha). Cada mês tem 80 mil notas de doação, 80 mil de crédito e 80 mil
linhas de conciliação. Cada cenário rodou numa aba nova; a hidratação foi
medida num banco vazio, como acontece ao trocar de computador.

**Salvar (acontece 2 s depois de qualquer alteração)**

| Meses de dados | JSON | Arquivo enviado | Export | gzip | Tela congelada |
|---|---|---|---|---|---|
| 1 | 83 MB | 13 MB | 2,3 s | 2,0 s | 1,4 s |
| 4 | 329 MB | **52 MB** | 6,3 s | 8,2 s | 5,2 s |
| 6 | 493 MB | 78 MB | 9,2 s | 11,9 s | 7,6 s |
| 7 | — | — | **falha: `Invalid string length`** | — | — |

**Abrir em outro computador (1 mês de dados)**

| | Tempo |
|---|---|
| Boot do banco + migrations | 2,3 s |
| Descomprimir + interpretar o JSON | 0,9 s |
| **Reinserir (caminho atual)** | **59,5 s** — notas de doação 18 s, de crédito 17 s, conciliação 22 s |
| Protótipo: `read_json` + índices recriados depois + normalizações | **3,9 s** |

Não medi a hidratação atual com mais meses porque ela não cabe no tempo de
teste; pelos números da seção 3.2 ela cresce mais rápido que o volume.

**Importar o mês seguinte (CSV de 80 mil linhas, sem contar o upload depois)**

| | Banco vazio | Com 5 meses de histórico |
|---|---|---|
| Planilha de doações | 4,2 s | **15,5 s** |
| → conciliação de créditos | 0,4 s | 5,5 s |
| → finalizar (COMMIT) | 1,0 s | 7,9 s |
| Planilha de créditos | 3,7 s | **14,7 s** |
| Mesma planilha em **XLSX** — só a prévia | 5,5 s, com 5 s de tela congelada | |

O que cresce é `reconcileCredits()`, que apaga e reconstrói a tabela de
conciliação **inteira** a cada importação, e o COMMIT dessa reconstrução. Ler
o arquivo e inserir as notas do mês leva menos de 1 s e não cresce.

**Limites de plataforma que esses números cruzam** *(suposição — depende do
plano contratado; conferir no painel)*: o Supabase limita o tamanho de arquivo
por upload (50 MB no plano gratuito), e o upload simples é recomendado só
para arquivos pequenos. O limite do navegador (string de ~512 MB) não depende
de plano.

| # | Achado | Conf. | Impacto | Esforço |
|---|---|---|---|---|
| **S0** | **O snapshot em JSON único deixa de funcionar com ~7 meses de dados** no volume atual. `exportSnapshotText` (`backup.js:256-281`) concatena tudo numa string; ao estourar o limite do V8 lança `Invalid string length`. Quebra o upload **e** o backup manual (`exportDatabaseBackup` chama a mesma função). O estado então só existe na memória da aba. | Reproduzido | **Crítico** | **A** |
| **I1b** | **A conciliação é refeita por inteiro a cada importação**, reimportação e exclusão (`creditReconcileEngine.js`, chamado em `importProcess.js:255`). Mesmo com I1 corrigido, o custo continua proporcional ao histórico todo (9,7 s hoje), não ao mês importado. | Medido | M | M |
| **I2** | **Prévia de XLSX roda na thread principal** (`import/spreadsheetSource.js`: exceljs carrega o arquivo e reescreve como CSV). 80 mil linhas congelam a tela por ~5 s. | Medido | M | M |
| **I3** | **Número com mais de 2 casas decimais numa célula numérica de XLSX vira um valor absurdo.** O exceljs escreve o double como está (`41.989999999999995`); `brOrUsDoubleSqlExpression` (`import/sqlExpressions.js`) só reconhece decimal com 1–2 casas e, no resto, **remove o ponto** — o valor vira `41989999999999995`. Na planilha sintética, 2.080 de 20.000 linhas ficaram com `valor_nf` na casa de 10^16. Depende de como o arquivo de origem grava os números: um `41.99` literal passa certo. | Reproduzido (planilha sintética) | A se a planilha real tiver esse padrão | **B** |

### 3.1 Como medi (primeira rodada, volume suposto)

App rodando em modo local, banco preenchido com dados sintéticos pelo mesmo
`restoreDatabaseSnapshot` que a hidratação usa. Volume: 400 doadores, 600 CPFs
por planilha, **2.500 notas/mês** de doação, o mesmo de crédito e de
conciliação.

**Esse volume é uma suposição minha.** O README estima 0,34 MB comprimido por
ano; meu cenário de um ano deu 1,85 MB, então provavelmente exagerei o volume
ou a largura das linhas. Os números absolutos valem para o meu cenário; a
**proporção** entre os caminhos (15–20×) é o que importa. Com o volume real
(pergunta 3) refaço a conta em minutos.

### 3.2 Números

| Etapa | 1 ano (104 mil linhas) | 3 anos (308 mil linhas) |
|---|---|---|
| Boot do DuckDB + 16 migrations | ~1,1–1,6 s | ~1,1 s |
| **Restore atual** (INSERT em blocos de 500, parâmetros, índices ativos) | **9,2 s e 14,9 s** (duas execuções) | **46,8 s** |
| → só `donation_notes` | 3,3 s | 13,5 s |
| → só `credit_notes` | 2,8 s | 13,6 s |
| → só `credit_reconciliation` | 1,3 s | 14,0 s |
| Normalizações pós-restore | 0,1–0,2 s | 0,1 s |
| Protótipo A: `read_json` com índices ativos | 1,2 s e 6,6 s | 25,2 s |
| **Protótipo B: `read_json`, índices recriados depois** | **0,62 s** | **2,29 s** |
| Export do snapshot (a cada gravação) | 1,1 s e 4,6 s | 1,5 s |
| Tamanho do JSON | 33,5 MB | 99,6 MB |
| gzip | 0,4–0,5 s → **1,85 MB** | 1,1 s → **5,5 MB** |
| gunzip + `JSON.parse` | 0,13 s | 0,36 s |

Leituras:

- O restore **não é linear**: 3× mais dados custaram 3–5× mais tempo. É
  manutenção de índice (60 índices no banco; `donation_notes` e `credit_notes`
  têm 6 cada). No protótipo B, as mesmas três tabelas grandes carregaram em
  0,2 s e 0,8 s.
- Baixar e interpretar o arquivo é desprezível (décimos de segundo). O tempo
  está inteiro em reinserir.
- O export não trava a interface (0 ms de tarefa longa), como o commit 264
  buscava. Mas o gzip trava: o `TextEncoder.encode` de 33 MB gerou **uma
  tarefa de 312 ms** na thread principal.
- Variação entre execuções é alta (máquina de uso geral, navegador headless).
  Trate cada número como ordem de grandeza.

### 3.3 Achados

| # | Achado | Conf. | Impacto | Esforço |
|---|---|---|---|---|
| **S1** | **Escrita durante um upload em andamento nunca sobe.** `uploadSnapshotImmediate` devolve a promessa do upload em voo quando `isUploading` é verdadeiro e **não reagenda** (`cloudStorage.js:261-265`; o comentário diz "schedule another flush right after", o código não faz). O snapshot em voo foi montado antes da escrita. Resultado: status "Sincronizado", `hasPendingCloudWork()` falso, nenhum aviso ao fechar a aba. O dado só sobe na próxima alteração; se o usuário fechar antes, perde. | Reproduzido | **A** | **B** |
| **S2** | **"Manter minhas alterações" não funciona.** `acknowledgeRemoteConflict` (`cloudStorage.js:189-196`) limpa a flag e chama `uploadSnapshotImmediate`, que roda `checkForRemoteChanges()` de novo (`:272`). Como `lastKnownServerVersion` não foi atualizado, o conflito é detectado outra vez e o upload é bloqueado. O banner some e volta; nada sobe, nem nas alterações seguintes. Única saída: "Recarregar", que descarta o trabalho local. | Reproduzido | **A** | **B** |
| **S3** | **Hidratação lenta e superlinear** (`backup.js:282-442`): INSERT de 500 linhas por vez, cada valor trafegando como parâmetro pelo worker, com todos os índices ativos. Acontece em **todo** carregamento de página. Ver 3.2. | Medido | **A** | **M** |
| **S4** | **Não há cache local**: recarregar a aba, abrir segunda aba ou clicar "Recarregar" no aviso de conflito refaz download + restore completos, mesmo que nada tenha mudado. | Lido | **A** (percepção) | **M–A** |
| **S5** | **Cada alteração reenvia o banco inteiro** e faz 3 requisições (`list` antes, `upload`, `list` depois — `cloudStorage.js:272`, `:308`, `:323`). No meu cenário de 3 anos já são 5,5 MB por gravação, o limiar que o projeto definiu para a sync incremental. | Medido | **M** (cresce) | **B** (cortar requisições) / **A** (incremental) |
| **S6** | **O snapshot pode sair inconsistente.** `exportSnapshotText` faz 18 SELECTs em sequência, fora de transação, na mesma conexão que as escritas (`backup.js:256-281`). Se o temporizador disparar no meio de uma `runInTransaction` longa (uma importação), o export lê estado parcial e não confirmado, e sobe. Se a transação depois falhar, a nuvem fica com dado que nunca existiu, até o próximo upload. | Lido | **M** | **B–M** |
| **S7** | **Âncora de versão com janela de corrida.** A versão conhecida vem de um `list` separado do download (`:458-460`) e do upload (`:323`). Se outro dispositivo gravar entre as duas chamadas, adoto a versão dele como minha e o próximo upload sobrescreve o trabalho dele sem aviso. Janela curta, consequência grave. | Lido | **M** | **M** |
| **S8** | **Dependência de `extensions.duckdb.org` em tempo de execução.** Toda sessão baixa `json.duckdb_extension.wasm` de lá (requisição observada). O export do snapshot usa `json_group_array`. Se o domínio estiver bloqueado ou fora do ar, a sincronização provavelmente para. O README afirma que a rede é usada "em três momentos apenas". | Medido (requisição) / Suposição (efeito da falha) | **M** | **B–M** |
| **S9** | **Índices redundantes** encarecem toda carga e toda importação: `idx_donation_notes_match_key (cnpj, numero, data_nota)` e o equivalente em créditos são da chave antiga, que incluía data (`migrations.js:581-585`, `:655-659`); `idx_*_match_key_v2 (match_key)` é prefixo de `idx_*_match_full (match_key, valor_cents)` (`:809-826`). | Lido | **B–M** | **B** |
| **S10** | **As normalizações reescrevem tabelas inteiras a cada boot**, incluindo `updated_at = CURRENT_TIMESTAMP` em todas as linhas de `import_cpf_summary` e de `donors` (`schema.js:361-385`, `:253-270`). Custo medido baixo (0,1 s), mas o snapshot nunca é idêntico entre duas sessões — o que inviabiliza qualquer sync por diferença sem tratar isso antes. | Medido / Lido | **B** hoje | **B** |
| **S11** | Sync é "último a gravar vence", sem merge. Limitação documentada; registro aqui porque S1, S2 e S7 a tornam mais perigosa do que o README descreve. | Lido | — | **A** |

### 3.4 Como S1 e S2 foram reproduzidos

Um servidor HTTP local imitou os três endpoints do Storage (`list`, download,
upload) e o app rodou com uma sessão falsa apontando para ele.

- **S1:** upload com 4 s de atraso. Gravei a nota A, esperei o upload chegar
  ao servidor, gravei a nota B. Depois de 7 s de folga: 1 upload, contendo A e
  **não B**; app com status `idle`, sem trabalho pendente.
- **S2:** depois de um upload normal, mudei a versão no servidor (simulando
  outro dispositivo). `checkForRemoteChanges()` → conflito. Chamei
  `acknowledgeRemoteConflict()`. Eventos de conflito observados:
  `true → false → true`. Zero uploads. Uma gravação seguinte também não subiu.

O script vira teste e2e permanente com pouco trabalho — é a peça que faltava
para cobrir essa camada (item T1).

---

## 4. Demais achados

### 4.1 Bugs e riscos de correção

| # | Achado | Conf. | Impacto | Esforço |
|---|---|---|---|---|
| B1 | `runInTransaction` com transação já aberta **entra na transação alheia** (`connection.js:300-302`). É intencional, mas significa que uma leitura de tela pode ver dado não confirmado, e que um erro numa chamada "de carona" derruba a transação da outra. Sem fila. | Lido | M | M |
| B2 | `LegacyProjectRedirect` manda rotas antigas para `projects[0]`, que pode não ser o projeto certo quando há mais de um. O próprio comentário admite. | Lido | B | B |
| B3 | `donors.demand` guarda o **nome** da demanda, e `monthly_donor_summary.demand` guarda uma **cópia** desse nome. Renomear ou trocar demanda depende de cascata em código; já gerou o bug "Demanda: Não informada" (commit 295). | Lido | M | A |
| B4 | Sem PK/FK: integridade só por índice único e código. Um backup adulterado ou antigo pode entrar com referências quebradas; as normalizações cobrem os casos conhecidos, não os desconhecidos. | Lido | M | A |
| B5 | Aviso de build `INEFFECTIVE_DYNAMIC_IMPORT`: o `import()` dinâmico de `creditReconciliationService` em `connection.js:125` não separa chunk nenhum porque o módulo também é importado estaticamente. Só serve para quebrar o ciclo de módulos; o aviso é ruído. | Medido | B | B |

### 4.2 Segurança

| # | Achado | Conf. | Impacto | Esforço |
|---|---|---|---|---|
| SEC1 | **Sem segredo no git.** `.env` nunca foi commitado; busca por URL de projeto Supabase e por JWT em todo o histórico não achou nada. | Medido | ok | — |
| SEC2 | **SQL injetável: praticamente fechado.** Sobram dois pontos que interpolam `projectId` sem `safeProjectId` (`dashboardService.js:168` e `:239`). O id vem do banco; só seria explorável por um backup adulterado importado pelo próprio usuário. | Lido | B | B |
| SEC3 | **XSS nas anotações: ok.** `normalizeNoteContentHtml` reconstrói o HTML por lista fechada de tags e não repassa atributo nenhum (`features/notes/utils/noteContent.js`). | Lido | ok | — |
| SEC4 | **O único controle de acesso são as policies do bucket**, configuradas no painel do Supabase e fora do repositório. Não tenho como verificá-las daqui. | Suposição | A se estiverem erradas | B (conferir) |
| SEC5 | **Qualquer pessoa com a URL do app cria uma conta.** `signInWithOtp` cria usuário por padrão e a confirmação de e-mail está desligada (README). Ela não enxerga dados de ninguém, mas ocupa cota do projeto. | Lido / Suposição | B–M | B |
| SEC6 | **Não existe compartilhamento entre usuários.** Os dados ficam em `{userId}/dados.json`. Para a equipe ver os mesmos dados, todos precisam entrar com o **mesmo e-mail**. Se é isso que acontece, não há trilha de quem fez o quê e a caixa de e-mail vira a chave do sistema. | Suposição | M–A | A |
| SEC7 | **Dados pessoais (nome, CPF, compras) em um blob sem criptografia do lado do cliente**, e em backups JSON baixados em claro. Relevante para LGPD. | Lido | M | M–A |
| SEC8 | `VITE_NOTAR_AUTH_MODE=local` num build de produção desliga login e persistência. É erro de configuração, mas não há trava. | Lido | B | B |
| SEC9 | `npm audit`: `brace-expansion` (alta, ferramental), `uuid` via `exceljs` (moderada), `@humanfs/node` (moderada). Nenhuma alcançável com entrada de usuário no navegador. | Medido | B | B |
| SEC10 | Scripts de terceiros sem SRI: Google Fonts e a extensão do DuckDB (S8). | Medido | B | B |

### 4.3 Desempenho (além da sync)

| # | Achado | Conf. | Impacto | Esforço |
|---|---|---|---|---|
| P1 | Primeiro acesso baixa 35,7 MB de WASM (8,2 MB com gzip) + 760 kB de JS num chunk só (199 kB gzip). Sem divisão por rota. Depende de o servidor comprimir e cachear — não sei onde está hospedado (pergunta 5). | Medido | M | M |
| P2 | Gestão Mensal, Demandas e Sorteio paginam no cliente. Já documentado, com gatilho em 5 mil linhas/mês. | Lido | B hoje | A |
| P3 | Durante o export do snapshot (1–5 s no cenário de um ano) o worker único fica ocupado; consultas de tela esperam atrás dele. | Medido | B–M | junto com S5 |

### 4.4 Código duplicado, morto ou acoplado

| # | Achado | Conf. | Impacto | Esforço |
|---|---|---|---|---|
| C1 | `createEmptySnapshot` existe duas vezes e **já divergiu**: a de `cloudStorage.js:505-524` não tem `projects` nem `donorProjectAssignments`; a de `utils/backup.js` tem. Inofensivo hoje porque `normalizeSnapshotPayload` completa. | Lido | B | B |
| C2 | **4 arquivos órfãos só na cópia local**, removidos do git nos commits 249, 259 e 274: `DashboardCurrentMonthBanner.jsx`, `DashboardDemandBreakdownSection.jsx`, `DashboardLatestMonthSection.jsx` e `MetricCard.jsx` em `src/features/dashboard/components/`. Ninguém os importa. Sinal de que a pasta foi atualizada copiando arquivos por cima. | Medido | B | B |
| C3 | `services/calculationService.js` (`calculateValue`) só é usado pelo próprio teste. | Medido | B | B |
| C4 | `Monthly.jsx` (993 linhas) e `Donors.jsx` (863) seguem grandes. Decisão já registrada e justificada. | Medido | B | A |
| C5 | Estado global em módulo (`activeProject`, `activeCloudUser`, `queryCache`, flags de sync). Funciona, mas esconde dependência e é o que impede testar `cloudStorage.js` no Node. | Lido | M | M |
| C6 | `execute`/`executePrepared` usam `{ source, domains }`; `runInTransaction` usa `{ changeSource, changeDomains }`. Opção com nome errado é ignorada em silêncio — já causou bug (commit 295). | Lido | B–M | B |

### 4.5 Testes e documentação

| # | Achado | Conf. | Impacto | Esforço |
|---|---|---|---|---|
| T1 | **`cloudStorage.js` (597 linhas) não tem teste de orquestração.** Os testes existentes cobrem só as funções puras extraídas. S1 e S2 estão exatamente na parte descoberta. | Medido | **A** | M |
| T2 | O e2e roda só em modo local: nunca passa por hidratação, upload, conflito ou tela de login. | Lido | A | M |
| T3 | **Importação da planilha de créditos por arquivo não tem teste e2e.** Não há CSV de créditos em `e2e/fixtures`; os dados de crédito entram só por backup. `creditImportPipeline.js` tem 778 linhas. | Medido | M–A | M |
| T4 | e2e instável em paralelo nesta máquina (2 a 3 de 96 por rodada, testes diferentes a cada vez, todos passam sozinhos). `playwright.config.js` não limita `workers`, e localmente `retries` é 0. | Reproduzido | B–M | B |
| T5 | Nenhum teste protege desempenho. A hidratação pode piorar sem ninguém notar. | Lido | M | B–M |
| D1 | **Documentos se contradizem.** Agência/conta da planilha de abatimento: o código usa **1** (`abatementSheetWorkbook.js:38-39`), o README diz 1, o CLAUDE.md diz 0. Selo do README: "235 unit + 88 e2e"; real: 259 e 96. CLAUDE.md manda coassinar como "Claude Sonnet 4.6". | Medido | B | B |
| D2 | **O CLAUDE.md tem 118 kB** e é carregado inteiro em toda sessão. Boa parte é histórico de fases que descrevem código já removido (OPFS, CommandPalette, `escapeSqlString`). Custa contexto e mistura o que vale hoje com o que valeu. | Medido | M | B–M |
| D3 | Comentário de cabeçalho de `cloudStorage.js:39-42` diz que a base tem "<2k rows"; o próprio projeto fala em 30 mil notas. | Lido | B | B |
| D4 | README: "a rede é usada em três momentos apenas" — falso por S8 e Google Fonts. | Medido | B | B |
| D5 | Sem `LICENSE`. O README já avisa. | Medido | B | B |

### 4.6 Dependências

| # | Achado | Impacto | Esforço |
|---|---|---|---|
| DEP1 | `@duckdb/duckdb-wasm` está numa versão **de desenvolvimento** (`1.33.1-dev45.0`; a mais recente é `dev57`). É o coração do sistema, tem um bug conhecido no bundle MVP e um worker de 773 kB versionado no repo. Atualizar exige rodar tudo. | M | M |
| DEP2 | `exceljs` 4.4.0: sem versão nova há anos, traz `uuid` vulnerável, pesa 930 kB (já carregado sob demanda). | B–M | A (trocar) |
| DEP3 | Defasagens menores: `@supabase/supabase-js` 2.105→2.117, `lucide-react` 1.9→1.49, `@playwright/test` 1.59→1.63, `vite` 8.2→8.3, `tailwindcss` 4.2→4.3. Majors disponíveis: `eslint` 10, `framer-motion` 13, `nanoid` 6. | B | B |
| DEP4 | Versão do Node não fixada: README pede ≥20, CI usa 22, esta máquina tem 24. Sem `engines` nem `.nvmrc`. | B | B |

---

## 5. Roteiro proposto

Reordenado depois das medições no volume real. A lógica passou a ser:
**garantir que o dado existe em algum lugar seguro → impedir a quebra → resolver
a lentidão → higiene.** Cada etapa é pequena, tem teste antes e número depois.

**Etapa 0 — Rede de segurança e ambiente** — feita
- Cópia do `dados.json` baixada pelo usuário em 01/10/2026 (guardar esse
  arquivo fora do app; é a única cópia que não depende do código).
- Pasta ligada ao git; Chromium do Playwright instalado.
- **Pendente do lado de quem usa:** no computador que mostra "Falha ao
  sincronizar", exportar um backup em Configurações **antes** de fechar ou
  recarregar a aba — o que não subiu só existe ali.

**Etapa 1 — Conciliação rápida** (I1) — *a mudança de melhor custo-benefício*
- Trocar o `OR` por dois `NOT EXISTS` em `creditReconcileEngine.js` (dois
  trechos, poucas linhas cada).
- Antes: teste de integração que fixa o resultado atual da conciliação num
  conjunto com repetidas, divergentes e órfãs. O teste precisa passar antes e
  depois.
- Evidência já obtida: resultado idêntico nos seis status sobre o banco real.
- Risco: baixo. É uma identidade lógica; o que pode quebrar é erro de
  transcrição — o teste e a comparação com os dados reais cobrem isso.

**Etapa 1b — Fôlego antes do limite de 50 MB** (S12, S13)
- Parar de gravar `credit_reconciliation` no snapshot e reconstruí-la ao
  abrir. Arquivo cai de 43,4 para 26,8 MiB — uns dois meses de folga.
- Depende da etapa 1 (sem ela, abrir custaria 12 minutos a mais).
- Snapshots antigos, que trazem a tabela, continuam abrindo.
- Alternativa sem código: subir o plano do Supabase. Resolve o limite, não a
  lentidão.

**Etapa 1c — Parar de perder sincronização** (S1, S2, T1)
- Transformar o storage falso em teste e2e que falha hoje pelos dois motivos.
- S1: registrar "houve alteração depois do snapshot em voo" e disparar novo
  upload ao terminar.
- S2: ao aceitar o conflito, adotar a versão remota como conhecida antes de
  subir.
- Risco baixo: ~30 linhas de um arquivo. O teste criado aqui é o que vai
  proteger a troca de formato da etapa 2.

**Decisão sua, antes da etapa 3 — regra das "Repetidas"** (R1)
- Confirmar se nota com mesmo CNPJ e número, mas valor diferente, é mesmo
  outra nota. Se for, a repetição passa a ser checada por CNPJ + número +
  valor e ~57 mil notas entram na conciliação. Muda números que aparecem para
  o usuário (crédito real por doador), então não faço sem o seu sim.

**Etapa 2 — Trocar o formato do snapshot** (S0, S3, S5, S9 — a etapa que importa)
- Sair de "um JSON com tudo" para **um arquivo por tabela** (e, nas três
  tabelas grandes, **por mês de referência**), com um manifesto pequeno que
  lista os arquivos e suas versões.
- Medido no banco real: o maior arquivo ficaria em 3,8 MiB (doações de
  mai/2026), contra os 43,4 MiB de hoje.
- Efeitos, todos de uma vez:
  - some o limite de string (S0): nenhum arquivo passa de alguns MB;
  - salvar reenvia só o que mudou — marcar um abatimento sobe poucos kB em
    vez dos 45 MB de hoje (S5);
  - abrir carrega cada arquivo direto no DuckDB, com índices criados depois
    (S3): no banco real, 12,8 s contra 142,8 s;
  - a tela deixa de congelar a cada gravação.
- Formato do arquivo: começar pelo JSON por tabela que o export já produz (é
  o caminho mais curto e o protótipo já prova a leitura). Parquet seria menor e
  mais rápido, mas exige outra extensão do DuckDB — fica para depois, medido.
- **Compatibilidade:** quem tem só o `dados.json` antigo precisa continuar
  abrindo. Leitura dos dois formatos; escrita só no novo; o arquivo antigo
  fica intacto como cópia até você mandar apagar.
- Remover os índices redundantes (migration v17) e gravar um teste de tempo
  de hidratação.
- Risco: **alto** — é o coração da persistência. Por isso: etapa 0 feita,
  teste da etapa 1 no lugar, formato antigo preservado, e validação contra os
  dados reais (contagem por tabela antes e depois) antes de valer para você.

**Etapa 3 — Importar sem refazer tudo** (I1b, I2, I3)
- Conciliar só as chaves do mês importado, em vez de reconstruir a tabela
  inteira. Precisa de teste que prove resultado idêntico ao da reconstrução
  completa (o botão "Re-rodar conciliação" continua fazendo a completa).
- I3: corrigir a leitura de número com mais de duas casas vindo de XLSX.
- I2: tirar a conversão de XLSX da thread principal.

**Etapa 4 — Endurecer a sincronização** (S6, S7, S8, S10)
- Não exportar com transação aberta; fechar a janela de corrida da versão;
  servir a extensão JSON junto com o app; parar de reescrever `updated_at` a
  cada boot (com o formato novo isso faria tabelas inteiras subirem à toa).

**Etapa 5 — Não hidratar o que não mudou** (S4)
- Guardar os arquivos baixados no navegador e, ao abrir, baixar só os que o
  manifesto disser que mudaram. Com a etapa 2 feita, isto é barato.

**Etapa 6 — Higiene** (em paralelo, itens soltos)
- T3 (e2e de créditos por arquivo), T4, C1, C3, C6, SEC2, D1–D4, DEP3, DEP4.
- D2: enxugar o CLAUDE.md, movendo o histórico para um arquivo à parte.

**Fora do roteiro até você decidir:** SEC5–SEC7 (modelo de acesso e LGPD — com
conta compartilhada por e-mail, é uma conversa à parte), B3 e B4 (modelo de
dados), DEP1 e DEP2.

**Sobre a escala, com franqueza.** 80 mil notas por mês são ~1 milhão de notas
por ano, mais o mesmo em créditos e em conciliação. O DuckDB no navegador
aguenta esse volume em memória por alguns anos (limite de 4 GB do WebAssembly),
mas não indefinidamente, e cada dispositivo precisa baixar e carregar tudo. As
etapas 2 e 5 dão fôlego real. Se o crescimento continuar, a pergunta seguinte é
se o histórico antigo precisa estar sempre carregado, ou se pode ser arquivado
por ano — decisão de produto, não de código.

---

## 6. Perguntas

O que o código não responde. Onde eu tinha um palpite, está marcado.

**Já respondidas (01/10/2026)**

- Volume: ~80 mil notas no último mês importado, crescendo (conferido no
  arquivo: 87.332 em mai/2026).
- Onde dói: principalmente ao trocar de computador e ao importar planilhas.
- A equipe usa o mesmo e-mail para entrar.
- Dados de out/2023 a mai/2026; plano gratuito do Supabase; status atual
  "Falha ao sincronizar".
- Git: nesta pasta, já criado e apontando para o GitHub.
- Formato das planilhas: as 64 importações gravadas são CSV.

**Em aberto**

1. **Nota com mesmo CNPJ e mesmo número, mas valor diferente, é outra nota?**
   (R1 — decide o destino de 57 mil notas e R$ 28,7 mil de crédito.)
2. No computador com "Falha ao sincronizar": houve alteração depois de
   27/09 (data da última gravação que chegou à nuvem)? Já importou junho?
3. Você disse que usa CSV e XLSX, mas todas as importações gravadas são CSV.
   O XLSX é convertido antes, ou era de planilhas que foram reimportadas?
4. **Onde o app está hospedado** em produção? Não há configuração de deploy no
   repositório.
5. Quantas pessoas usam ao mesmo tempo, em quantos computadores? O aviso
   "Os dados foram atualizados em outro dispositivo" aparece com frequência?
6. Subir o plano do Supabase é uma opção, ou o custo zero é requisito?

**Negócio**

8. *(Suposição)* O **abatimento** é um desconto que o doador recebe em algo
   que paga à entidade, e o "sistema de baixa" é onde essa cobrança vive.
   Confere? Que sistema é esse?
9. O **valor por nota** é digitado a cada importação. Quem define, e muda de
   mês para mês?
10. **Agência e conta** da planilha de abatimento: o código usa `1` e o
    CLAUDE.md diz `0`. Qual é o certo hoje?
11. Crédito com situação diferente de "Calculado"/"Liberado" é ignorado na
    conciliação. Existem outras situações que deveriam contar?
12. Nota com chave **repetida** não é pareada com nada. Na prática isso
    acontece muito? Vale uma regra de desempate?

**Código que parece abandonado ou provisório**

13. O módulo `credits` existe na lista de módulos de projeto, sempre `false`.
    É resquício ou algo planejado?
14. O caminho legado de importação (planilha sem `CNPJ Estabelecimento`, que
    só agrega por CPF) ainda é usado, ou toda planilha atual já vem no formato
    novo?
15. As normalizações que convertem o modelo antigo de auxiliares rodam em todo
    boot. Ainda existe backup ou conta nesse modelo, ou já pode virar uma
    migration única?
16. Posso propor enxugar o `CLAUDE.md` (D2)? Ele é seu diário de decisões e
    não quero mexer sem combinar.
