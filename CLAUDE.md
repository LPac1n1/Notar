# Notar — Memória do Claude

## Contexto do projeto

SPA local-first em React 19 + Vite + Tailwind 4 + DuckDB-WASM (OPFS / File System Access API). Sem backend, sem Docker, sem PostgreSQL. Persistência 100% no navegador.

## Roadmap técnico em execução

O usuário aprovou e quer executar **Fases 1, 2 e 3** do roadmap definido no diagnóstico técnico (ver histórico em `commit 62` e mensagem subsequente). Após terminar Fase 3, vamos refazer a análise técnica para reavaliar prioridades. As fases 4 e 5 ficam para depois dessa reanálise.

### Fase 1 — Estabilizar fundação ✅ CONCLUÍDA (commits 64-68)

Objetivo: corrigir os fundamentos do banco antes de qualquer feature nova mexer em schema.

- [x] **C2** — `services/db.js` (1.667 linhas) quebrado em 6 módulos: `events.js`, `sql.js`, `schema.js`, `migrations.js`, `connection.js`, `backup.js`, `storage.js`. O antigo `db.js` virou barrel re-exportador (36 linhas). [commit 64]
- [x] **C3** — Sistema versionado de migrations em `services/db/migrations.js`. Tabela `schema_version` cria stamp por migration aplicada. Migration v1 agrega todo o estado anterior (CREATE/ALTER/DROP/INDEX). `applyDataNormalizations` separado, sempre roda. [commit 65]
- [x] **C4** — Migration v2 ("unique-id-and-natural-key-indexes") cria `CREATE UNIQUE INDEX` em `id` de todas as tabelas + `people(cpf)`, `donors(cpf)`, `demands(name)`. DuckDB-WASM não aceita `ALTER TABLE ADD PRIMARY KEY` em tabelas com dados, mas UNIQUE INDEX dá a mesma garantia. [commit 66]
- [x] **M6** — `services/logger.js` com `logError(scope, error, context)` e `installGlobalErrorHandlers()` (window.error + unhandledrejection). Categoria "Erros do sistema" adicionada em `features/history/constants.js`. Instalado em `main.jsx`. Os 39 `console.error` espalhados nas pages NÃO foram migrados — eles ainda funcionam, e qualquer erro não-tratado é capturado pelo handler global. [commit 67]
- [x] Testes de integração com DuckDB-Node em `tests/migrations.test.js` (helper em `tests/helpers/duckdbHelper.js`). Usa o build node-blocking de `@duckdb/duckdb-wasm` (já instalado). Cobre: stamping de migrations, idempotência, criação de tabelas, criação de UNIQUE indexes (id + naturais). 5/5 passing. Total geral: 37/37 testes. [commit 68]

**Estado atual:** `db.js` é barrel limpo. Schema é versionado. Logger central instalado. Testes de migração reais rodando contra DuckDB no Node.

### Fase 2 — Limpar duplicação de UI ✅ CONCLUÍDA (commits 70-73)

Objetivo: parar de copiar boilerplate de loader/filtros entre páginas.

- [x] **P2** — Constantes compartilhadas movidas para `src/constants/filterOptions.js` (`DONOR_TYPE_OPTIONS`, `DONATION_START_DATE_OPTIONS`, `ACTIVE_STATUS_OPTIONS`). `features/donors/constants.js` removido. `features/monthly/constants.js` re-exporta do novo path. [commit 70]
- [x] **M2/M3** — `src/hooks/useDataResource.js` criado: hook genérico com race-safe loader, debounce de filtros, optionSource neutralizado, isLoading/isRefreshing/error/setError/reload, captura de erro via `logError`. Substitui ~150 linhas de boilerplate duplicado nas páginas. [commits 71-72]
- [x] **M1** — Decidi NÃO criar `useDonorsPage`/`usePeoplePage`/etc. porque o `useDataResource` já elimina a duplicação (a parte que era genérica). O resto do código de página (mutações, modais, navegação) é genuinamente page-specific — extrair daria só um wrapper sem reduzir complexidade. Resultado: páginas ficaram 56-150 linhas menores e o boilerplate sumiu. [commits 71-72]
- [x] **M4** — Auditoria de naming: `getPersonById` e `getHolderPersonContext` retornavam null mas usavam prefixo `get*`. Renomeados para `findPersonById` e `findHolderPersonContext`. Os outros `list*`/`get*` estão consistentes. [commit 73]
- [x] **Cleanup adicional**: removido `donorWhereClause` morto em `monthlyService.js` e import não-usado de `formatInteger` em `donationPdfReportService.js`. ESLint agora sai com 0 erros e 0 warnings em todo `src/`. [commit 73]

**Estado atual:** Pages: Demands 524→468 (-56), People 607→544 (-63), Donors 869→786 (-83), Imports 816→666 (-150), Monthly 1.038→1.010 (-28). Total: -380 linhas. Padrão de loader unificado. Naming `find*`/`get*` consistente. Lint limpo. Todos 37 testes passando, build OK.

### Fase 3 — Reduzir SQL injetável ✅ CONCLUÍDA (commits 75-77)

Objetivo: trocar `escapeSqlString` por prepared statements onde houver entrada do usuário.

- [x] **Helpers de prepared statements** — `queryPrepared(sql, params)` e `executePrepared(sql, params)` adicionados em `services/db/connection.js`. Wrappers do `connection.prepare(sql).query(...params)` da DuckDB-WASM, com `stmt.close()` automático no finally. [commit 75]
- [x] **C1** — Todas as 8 funções LIST/SELECT do plano migradas para `queryPrepared`:
  - `demandService.listDemands` ✅
  - `personService.listPeople`, `findPersonById`, `findPersonByCpf` (queryPersonRows refatorada para `{conditions, params}`) ✅
  - `donorService.listDonors` + `getDonorProfile` (5 queries internas) ✅
  - `monthlyService.listMonthlySummariesByMonth` (3 queries) + `listHistoricalMonthlySummaries` (`buildDonorConditions` retorna `{conditions, params}`) ✅
  - `importService.listImportCpfSummary` + `searchImportedCpfs` (`cpfPlaceholders` expande `?` por CPF) ✅
- [x] **escapeIdentifier hardening** — DuckDB não suporta `?` para identificadores, então `escapeIdentifier(cpfColumn)` continua. Adicionada verificação defensiva: `cpfColumn` deve estar em `fileColumnNames` (descobertos por `DESCRIBE`) antes de ser splicada no SQL — bloqueia injeção via payload manipulado. [commit 76]
- [x] **User-input checks também migrados** — `donorChecks.js` (ensureDonationCpfIsAvailable, ensureDemandExists, findActiveDonorByPersonId, ensurePersonCanBeAuxiliary, resolveHolderPersonIdInput, findHolderPersonContext) + `demandService` (createDemand/updateDemand uniqueness checks). [commit 77]
- [x] **Testes de prepared statements** — adicionados em `tests/migrations.test.js`:
  - "prepared statements bind parameters via ? placeholders" ✅
  - "prepared statements neutralize quote injection attempts" ✅ (assert que tentativa de injeção via `'; DROP TABLE demands; --` retorna 0 linhas e não destrói a tabela)
  - Helper `tests/helpers/duckdbHelper.js` estendido com `prepare()` no wrapper síncrono.
- [x] **Auditoria final** — `escapeSqlString` zero em queries SELECT que processam filtro do usuário. As ~191 ocorrências remanescentes estão em:
  - **WHERE id = '...'** com IDs gerados por nanoid no servidor (não-input direto do usuário): donorService:302/367/388/402/407/505/523/528/542/544, personService, noteService, trashService, etc.
  - **INSERT/UPDATE values** com strings já validadas (`normalizePersonName`, `normalizeCpf` valida 11 dígitos, `normalizeDemandName`, etc.).
  - ~~**buildCsvSource(registeredFileName)** — fileName é gerado internamente, não é input do usuário.~~ **ERRADO, corrigido no commit 282**: o nome incluía o `file.name` que o usuário deu ao arquivo. Ver a seção da auditoria, Fase 4.
  - Migrar essas para prepared seria refatoração mecânica, baixo retorno em segurança, médio em consistência. Pode ser feito em uma futura passada.

**Estado atual:** SELECT/filter paths blindados via prepared statements. Identifier injection mitigada com whitelist runtime. 39/39 testes passando (32 unit + 7 integração com DuckDB-Node real). Build OK. Lint 0 erros.

### Fase 4 — Estrutural ✅ CONCLUÍDA (commits 85-89)

Reanálise pós-Fase 3 (commit 84) gerou roadmap; usuário aprovou execução de Quick wins + Fase 4 + Fase 5 (sem TypeScript).

**Quick wins entregues** [commits 85-86]:
- Migration v4 (`performance-indexes`): `monthly_donor_summary(reference_month, donor_id)`, `monthly_donor_summary(donor_id)`, `donor_activity_history(donor_id, reference_month)`, `import_cpf_summary(reference_month)`.
- 4 `console.error` migrados para `logError` (Settings, DonorProfile, Dashboard, CpfListSearchSection).
- Dashboard e DonorProfile migrados para `useDataResource` (com novo `initialData` opt para single-object loaders).
- Bug `Monthly.handleExport` (set/zera `successMessage` na mesma síncrona) corrigido.
- Vars `--shadow-elevated`, `--shadow-popover`, `--shadow-toast` em `index.css`; Modal/SelectInput/FeedbackMessage usando-as.
- `useDataRefreshStatus` → `useDataRefreshIndicator` (renomeado em todos os 10 consumidores).
- `groupChangesByStatus`/`normalizeStatusForApply` extraídos para `features/monthly/utils/statusChanges.js` + 4 testes unitários.
- `DonorProfile` padronizado em `getErrorMessage`.
- `CopyButton` exibe toast de erro (`<FeedbackMessage tone="error" persistent={false}>`) quando `clipboard` falha.

**Estruturais entregues** [commits 87-89]:
- **donorService split**: `donor/donorWriter.js` + `donor/donorProfile.js` + `donor/donorActivity.js`. `donorService.js` virou barrel (32 linhas vs 1.063).
- **importService split**: `import/importPipeline.js` + `import/importQueries.js` + `import/importReconcile.js`. Barrel de 31 linhas vs 1.127.
- **monthlyService refator**: 3 constantes SQL compartilhadas (`MONTHLY_SOURCE_SUBSELECTS`, `MONTHLY_HOLDER_JOINS`, `MONTHLY_DONOR_PROJECTION`) eliminam ~140 linhas de duplicação entre `listMonthlySummariesByMonth` e `listHistoricalMonthlySummaries`.
- **Bulk INSERT em reconcileImport**: chunks de 200 rows via VALUES multilinha. Acabou com loop 1k+ INSERTs sequenciais. Teste DuckDB integration cobre o pattern.
- **Optimistic UI no `StatusToggle`**: `Monthly.jsx` mantém `optimisticStatusOverrides` que é overlaid em `summaries`; cleared quando `rawSummaries` reference muda. Reverte no catch.
- **Server-side pagination opt-in**: `listDonors`/`listPeople`/`listMonthlySummaries` aceitam `limit`/`offset`. Novos `countDonors`/`countPeople`/`countMonthlySummaries` para paginação completa. Default = retorna tudo (back-compat).
- **`escapeSqlString` user-input → prepared**: `createImportRecord(fileName, notes)`, `processImportedFile(errorMessage)`, `createAbatementAdjustment(description)`, `createTrashItem(label, payload)`. Resíduo de Fase 3 fechado.
- **`useStatusChangeAction` hook** em `features/monthly/hooks/`. Migrado `handleConsolidatedDonorStatusChange`; outros handlers podem adotar incrementalmente.
- **Undo em delete**: já presente em Donors/People/Demands/Imports. Auditado e confirmado.

### Fase 5 — Longo prazo (parcial) ✅ CONCLUÍDA (commit 90)

- **`useDatabaseChangeEffect({ sources })`**: opt-in para filtrar reloads por `event.detail.source`. Sem `sources` continua catch-all (back-compat).
- **Logger circular buffer + dump**: `services/loggerBuffer.js` (zero deps, testável) com `appendLogEntry`, `getLogBufferSnapshot`, `clearLogBuffer`, `exportLogBuffer`, `LOG_BUFFER_CAPACITY=200`. `logger.js` usa internamente; 4 testes unitários.
- **Auto-reconcile robustness**: novo teste de integração `reconcileImport SQL backfills matched_source_id for CPFs registered after the import landed` valida o SQL do `reconcileImport` direto contra DuckDB-Node.
- **Migração mecânica de `escapeSqlString` em INSERT/UPDATE**: `noteService` (title/content/color), `demandService` (name/color, update donors em cascade), `actionHistoryService` (label/description/payload + filtro listActionHistory). 5 services agora 100% prepared para qualquer string que toca SQL.

**Estado atual:** 58/58 testes passando, lint 0 erros, build OK. donorService 1.063→32, importService 1.127→31, monthlyService 935→850 (redução modesta + extração de fragments). Quase todo INSERT/UPDATE com texto vai por prepared statements; `escapeSqlString` restantes são para nanoid IDs gerados pelo servidor + identifiers já com whitelist.

### O que ficou para uma futura fase

- TypeScript incremental (excluído explicitamente nesta rodada).
- Migrar páginas de `usePagination` client-side para o novo `count*`/`limit`/`offset` (infraestrutura pronta, adoção pendente).
- Aplicar `useStatusChangeAction` aos 3 handlers restantes em Monthly.
- Virtualização de listas (`react-window`) — só se cargas reais ultrapassarem 5k linhas.
- NDJSON streaming export/import — só necessário >100k linhas.
- Filtrar `useDatabaseChangeEffect` por source nas páginas (infra pronta, adoção pendente).
- Fullstack/sync server (escopo separado).

### Fase 6 — Reuso + adoção do que ficou opt-in ✅ CONCLUÍDA (commits 92-96)

Diagnóstico no commit 91 listou 7 quick wins + 6 estruturais. Quase tudo entregue.

**Quick wins entregues** [commit 92]:
- `dashboardService.getDashboardOverview` paralelizado: 10 queries sequenciais → `Promise.all` em 2 grupos. Latência cai 3-5x.
- `Settings.jsx` 5 catches silenciosos agora chamam `logError` (createFile, openFile, disconnectFile, exportBackup, importBackup).
- Botão "Baixar log de erros" em nova SectionCard "Diagnóstico" em Settings consumindo `exportLogBuffer()` + `downloadFile`.
- Os 3 handlers restantes de `Monthly.jsx` (`handleStatusChange`, `handleBulkAbate`, `handleUndoStatusChanges`) agora usam `useStatusChangeAction` — o hook foi estendido com `onError` (rollback) e `setBusy` (per-call busy flag) para suportar optimistic UI.
- **Optimistic UI estendido** para `handleConsolidatedDonorStatusChange` e `handleBulkAbate` — ambos overlaiam `optimisticStatusOverrides` antes do round-trip e revertem no `onError`.
- **Source filtering**: `useDatabaseChangeEffect({ sources, ignoreSources })`. `noteService` writes tagged `source: "notes"`. Notes page subscribe a `["notes", "restore", "backup-import", "database-file-opened"]`; Monthly usa `ignoreSources: ["notes"]`.
- `SkeletonRows`/`SkeletonCard` agora têm `role="status"`/`aria-busy="true"`/`aria-live="polite"` + `<span className="sr-only">` com `loadingLabel` prop.

**Estruturais entregues** [commits 93-96]:
- **`useMutationAction` hook genérico** em `src/hooks/useMutationAction.js` — orquestrador de CRUD com `setError`/`setSuccessMessage`/`setSuccessAction`/`setBusy`/`reload`. Suporta `onStart`/`onSuccess`/`onError`, `undo` (callback) e `buildUndo: (result) => callback` (factory que recebe o retorno do `run` para construir a ação Desfazer com IDs gerados pela mutation). Adotado em Demands.jsx (3 handlers) e People.jsx (4 handlers). Cortou ~120 linhas de boilerplate.
- **monthlyService split**: 939 linhas → 91 (barrel) + `monthly/sharedFragments.js` (SQL constants + mappers + filters + `buildDonorConditions` + `isSyntheticSummaryId`) + `monthly/listByMonth.js` + `monthly/listHistorical.js` + `monthly/abatementUpdates.js`.
- **Dashboard modal split**: `Dashboard.jsx` 802 → 446 linhas via `features/dashboard/components/DashboardModals.jsx` (9 modais inline → 1 componente único parametrizado por `activeModal`).
- **Prepared para `JSON.stringify` payloads**: `importPipeline.deleteImport` agora usa `executePrepared` para o trash insert (era o último gigante string-built de Fase 3).

**Deferidos com justificativa** [não entregue intencionalmente]:
- **`useNoteAutoSave`**: extração requer reescrita das duas state machines paralelas (create + edit) que entrelaçam 14 refs em `Notes.jsx`. Sem testes de integração para auto-save, o risco de regressão (ex.: race entre flush-on-close e timer-fire, comportamento de fingerprint quando reabre nota intocada) é alto demais para um refactor cego. O comportamento atual funciona — adiar até que haja teste E2E ou cobertura adicional.
- **Migração para paginação server-side**: a infra (`countDonors`/`countPeople`/`countMonthlySummaries` + `limit`/`offset`) está pronta desde Fase 4. A adoção exige rework substancial de cada page (state de page/pageSize, count em paralelo, refresh em filter change, cuidado com `optionSource` que precisa de tudo). Para volumes atuais (≤2k linhas) o ganho é marginal; o custo é grande. Adiar até que volumes reais ultrapassem ~5k linhas, quando o ROI inverte.

**Estado atual:** 58/58 testes passando, lint 0 erros, build OK. Dashboard reduzido em -356 linhas; monthlyService 939→91 (barrel); useMutationAction adotado em 7 handlers entre Demands+People.

### Fase 7 — Sincronização multi-dispositivo via Supabase ✅ CONCLUÍDA (commits 98-100)

Usuário pediu poder usar o sistema em máquinas diferentes sem ter que ficar passando arquivo. Apresentei 3 opções (A: pasta sincronizada de nuvem, B: blob storage com sync no app, C: backend de verdade); ele escolheu B. Stack: **Supabase** (Storage + Magic Link auth).

**Setup no painel do Supabase** (usuário fez):
- Projeto criado, anon/publishable key copiada.
- Bucket privado `notar`. Policies via template "Give users access to own folder" — USING expr é `(bucket_id = 'notar' AND (storage.foldername(name))[1] = auth.uid()::text)`, aplicado a authenticated em SELECT/INSERT/UPDATE/DELETE.
- Auth → Email provider habilitado, Confirm email OFF, Site URL + Redirect URLs apontando pro dev local.

**Commit 98 — Scaffold de auth**:
- `@supabase/supabase-js` instalado. `.env` + `.env.example` com `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_STORAGE_BUCKET=notar`, `VITE_SUPABASE_STORAGE_OBJECT=dados.json`. `.env` já era gitignored.
- `services/supabaseClient.js` exporta o singleton client + `getUserStorageObjectPath(userId)` (retorna `{userId}/dados.json`).
- `contexts/AuthContext.jsx` provê session/user/status. `contexts/authContextValue.js` isola o `createContext` (Fast Refresh exige só componentes no .jsx). `hooks/useAuth.js` lê o contexto.
- `components/auth/SignInPanel.jsx` — formulário de magic link, redireciona pra `window.location.origin`.
- `App.jsx` é o gate: `loading` → LoadingScreen; `authenticated` → `<CloudSyncGate>`; senão `<SignInPanel>`.

**Commit 99 — Camada de storage migrada pra Supabase**:
- `services/db/cloudStorage.js` substitui o antigo `db/storage.js` (deletado). Responsabilidades:
  - `hydrateFromCloud(userId)`: pré-roteamento, baixa `{userId}/dados.json` e replaya em DuckDB via `restoreDatabaseSnapshot`. 404 → primeiro uso, segue vazio.
  - `scheduleCloudFlush()`: registrado via `setOnAfterTransaction`. Debounce de 2s — toda transaction reagenda; depois faz upload coalescido. Evita rajada de PUTs.
  - `flushPendingCloudSync()`: imediato, usado por `beforeunload` e botão "Sincronizar agora".
  - `setActiveCloudUser(userId)`: só passa a permitir uploads depois que a hidratação termina (evita upload acidental do estado vazio em pleno boot).
  - `onCloudSyncStatusChange(handler)` + `getCloudSyncStatus()` → status `idle`/`syncing`/`error` + `lastSyncedAt`. Espelhado em `storageInfo` pra Settings UI.
- `hooks/useCloudSync.js` — observa `useAuth`. Quando `authenticated`, chama `hydrateFromCloud` → `setActiveCloudUser`. Retorna `hydrationStatus` (`idle`/`hydrating`/`ready`/`error`) pro App.
- `App.jsx` → `<CloudSyncGate>`: mostra LoadingScreen enquanto hidrata; ErrorPanel com "Tentar novamente" em falha; routes em sucesso. Garante que nenhuma página monta antes da hidratação.
- `Settings.jsx` reescrito: seção "Armazenamento local" virou "Sincronização" com status + última sincronização + e-mail + botão "Sincronizar agora". Removidos handlers `createDatabaseFile`/`openDatabaseFile`/`disconnectDatabaseFile` (UI e barrel). Backup export/import continuam (rede de segurança offline). Nova seção "Conta" com "Sair desta conta".

**Commit 100 — Detecção de conflito entre dispositivos**:
- `cloudStorage.js` ganha `lastKnownServerVersion` (o `updated_at` do objeto que vimos por último). Atualizado depois de cada hydrate e de cada upload.
- `checkForRemoteChanges()`: chama `storage.list(userId)` (barato), compara `updated_at` com o anchor. Se diferente → `remoteConflict = true` → `notifyConflictListeners`.
- Disparado em `window.focus` e `document.visibilitychange === "visible"` (zero polling em background, só quando o usuário volta pra aba).
- `components/sync/RemoteConflictBanner.jsx`: banner fixo no topo (z-50) com "Recarregar" (window.location.reload) ou "Ignorar" (`acknowledgeRemoteConflict()`). Montado dentro do `CloudSyncGate` autenticado.
- `onRemoteConflict(handler)` + `acknowledgeRemoteConflict()` exportados via `services/db.js`.

**Estado atual:** 58/58 testes (suíte de migrations não cobre o cloud layer ainda — é tudo browser-only via fetch). Lint 0 erros, build OK. Persistência local-only foi removida; tudo passa pelo Supabase. Backup/import JSON continuam como recurso offline. `.env` no gitignore, anon key segura no frontend (policies do bucket são o gate de verdade).

### Fase 17–19 — Conciliação Doações × Créditos NFP ✅ CONCLUÍDA

Usuário pediu casar a planilha de doações (NFP) com a planilha de créditos. Match key originalmente era (CNPJ, Número, Data), depois refatorado para (CNPJ, Número, Valor em centavos) — datas são instáveis e geravam falsos divergentes.

**Modelo de dados** (migrations v5–v9):
- v5: `donation_notes` (uma linha por nota), `imports.cnpj_entidade_social`.
- v6: `credit_imports` + `credit_notes`.
- v7: `credit_imports.reference_month`.
- v8: `credit_reconciliation` (id, credit_note_id, donation_note_id, match_status, created_at).
- v9: `donation_notes.match_key`, `donation_notes.valor_cents`, `credit_notes.match_key`, `credit_notes.valor_cents` + índices. Backfill idempotente em `applyDataNormalizations`.

**Helpers de normalização** (`src/utils/reconciliationKey.js`):
- `normalizeCnpj`, `normalizeNumeroNota`, `normalizeValor` (retorna inteiro em centavos), `buildMatchKey`, `isCompleteMatchKey`. Testes em `tests/reconciliationKey.test.js`.

**Pipeline de doações** (`src/services/import/importPipeline.js`):
- Parser BR-format hardened: `regexp_replace('[^0-9,.\\-]', '', 'g')` antes do BR-format dance, senão prefixos `R$ ` e non-breaking spaces zeravam `valor_cents` → tudo virava divergente.
- Detecta `donationColumns` (CNPJ Estab., Nº Nota, Valor, Data, CNPJ Entidade, Data Pedido, Tipo) + `orderStatusColumn`. Pre-detecção exposta no preview pro `DetectedColumnsChecklist` (Sprint 1).

**Pipeline de créditos** (`src/services/credit/creditImportPipeline.js`):
- Mesmo modelo. Strict equality `lower(trim(replace BOM/NBSP)) = 'calculado'` para `is_valid`.
- `deleteCreditImport` pula `trash_items` (volumes 30k+ estouravam o bind limit do prepared statement). Donations idem.

**Service de conciliação** (`src/services/reconciliation/creditReconciliationService.js`):
- `reconcileCredits()`: rebuild full do `credit_reconciliation` por bucket: `duplicate_*` → `matched` → `divergent` → `credit_only` → `donation_only`.
- `completeKeyCondition(alias)`: factory pra evitar SQL ambiguity entre `donation_notes.match_key` e `credit_notes.match_key`.
- Helpers de consulta: `getCreditImportMatchStats`, `diagnoseCreditImportMatching`, `getDonorReconciliationSummary`, `listDonorReconciliationStatuses`, `countDonorReconciliationIssues`, `listReconciliationByDonor`, `listReconciliationPairs`.

**UI**:
- Página dedicada `pages/Credits.jsx` + nav.
- Colunas "Crédito real" + "Saldo" em `MonthlySummaryRow` + filtro de status de conciliação em Monthly (overlay no `summaries`).
- Cards de conciliação no Dashboard + linha de % casadas + `reconciliationLatestMonth`.
- Painel de conciliação por doador (`DashboardReconciliationSection`).
- Badge de inconsistências em Donors no Sidebar (`countDonorReconciliationIssues`).
- CSVs de conciliação por doador e pareamentos (com filtros respeitados).

**Estado:** 116/116 testes. Lint 0 erros.

### Fase 20 — UX audit + 3 sprints ✅ CONCLUÍDA (commits 142-151)

Auditoria de UX gerou 14+ pontos, priorizados em 3 sprints. Tudo entregue.

**Sprint 1 — Quick wins** [commits 142-146]:
- **P2.1**: toast pós-import de doações com stats de conciliação (matched/divergent/donation_only).
- **P3.1/P3.3**: colunas "Crédito real" e "Saldo" em `MonthlySummaryRow`. Saldo colorido por status (success/warning/danger).
- **P3.2**: filtro de status de conciliação em `MonthlyFiltersBar` (overlay client-side via `reconciliationByDonor.get(donorId).status`).
- **P7.1**: `hasDonationImportForMonth` checa antes de processar crédito; modal de confirmação se não houver doação do mês.
- **P2.2**: botão "Re-rodar conciliação" em Credits (chama `reconcileCredits` + toast de stats).
- **P10.2**: badge em "Doadores" no Sidebar com count de doadores com inconsistência. Refresh via `useDatabaseChangeEffect`.
- **P4.2**: link clicável no diagnose (clicar no nome do doador navega pro perfil).
- **P10.1**: cards "Última conciliação" no Dashboard.

**Sprint 2 — Estruturais** [commits 147-149]:
- **P1.2**: `DetectedColumnsChecklist` reutilizável; `prepareImportPreview` expõe `donationColumns` + `orderStatusColumn`; usado em `ImportUploadModal` e `CreditUploadModal`.
- **P5.1**: exports CSV de conciliação por doador e pareamentos respeitam filtros (`{ referenceMonth, statusFilter }`); filename inclui sufixo do filtro.

**Sprint 3 — Maior valor entregue** [commit 150-151]:
- **P8.1**: `restoreDatabaseSnapshot` emite `{ phase, currentTable, restoredRows, totalRows }`; `CloudSyncGate` renderiza barra de progresso real com tradução amigável dos nomes das tabelas ("Restaurando notas de doação (8.500 de 30.000 linhas)…").
- **P1.3**: progresso real em imports grandes. 4 pipelines (`processImportedFile`, `applyReimport`, `processCreditImport`, `applyReimportCredit`) aceitam `onProgress` e emitem etapas: `validating` → `inserting-notes` → `aggregating` → `reconciling-donors` → `reconciling-credits` → `finalizing` → `done`. Novo `ImportProgressIndicator` exibe label do step dentro dos 4 modais (upload + reimport, doações + créditos).
- **P4.1**: listagem filtrável de notas em Créditos. Novos `listCreditNotes` + `countCreditNotes` server-side. `buildCreditNotesFilters` whitelisteia opções de status. Nova `CreditNotesSection` com filtros (mês, status, busca CNPJ/nº), paginação server-side via `usePaginatedResource`, link clicável pro perfil do doador.
- **P1.1**: página unificada de importação por mês. `getMonthlyImportsOverview` faz 3 queries paralelas + merge em JS (1 row por mês). Nova `MonthlyImportsOverviewSection` no topo de Importações: tabela mostrando planilha de doações + planilha de créditos + estado da conciliação side-by-side.
- Bugfix [commit 151]: TDZ em `Credits.jsx` — `useMemo` para `creditNotesMonthOptions` lia `creditImports` antes do `useDataResource` declarar. Movido pra depois.

**Estado:** 116/116 testes, lint 0 erros, build OK. Cloud sync, conciliação, imports e UX de feedback todos em estado polido.

### O que ficou para uma futura fase (re-revisado)

- Migração para paginação server-side (infra pronta desde Fase 4, sem ROI até ~5k linhas — exceto `CreditNotesSection` que já usa).
- Extração de `useNoteAutoSave` (precisa de testes E2E antes).
- TypeScript incremental.
- Testes automatizados do fluxo de cloud sync (envolve mockar Supabase ou usar a [local CLI](https://supabase.com/docs/guides/cli/local-development) — escopo separado).
- Compressão do JSON antes do upload (se um dia o snapshot ficar grande; hoje é desprezível).
- Testes de integração para os pipelines de import com `onProgress` (hoje só lint+build cobrem).

## Simplificação de features + nova identidade visual ✅ CONCLUÍDA (commits 170-181)

Usuário pediu simplificação agressiva ("tirar muitas funções desnecessárias") e, na sequência, troca completa da identidade visual ("mais simples, moderno e intuitivo").

**Remoção de features** [commits 170-175]: busca universal (`CommandPalette`, `useCommandPalette`, `searchService`), atalhos de teclado (`useKeyboardNavigation`, `KeyboardShortcutsOverlay`), captura rápida de nota (`QuickNoteCapture`), painel lateral de doador (`DonorSidePanel` — `Donors.jsx` voltou a usar `navigate()` para o perfil, padrão anterior recuperado via `git show`), widgets de insight do Dashboard (`NextActionsInbox`, `DashboardAttentionZone`, `DashboardWorkflowChecklist`, `DashboardRecentReportsSection` + services `dashboardAttentionService`/`recentReportsService`), PWA/service worker (`public/sw.js`, manifest, ícone maskable). Bug real encontrado e corrigido de passagem: `MobileBottomNav` usava índices mágicos obsoletos em `MAIN_NAV_ITEMS` — corrigido para `WORKSPACE_NAV_ITEMS`. Nova confirmação + undo em `DonorAbatementAdjustmentsSection` (era a única ação destrutiva sem `ConfirmModal` no app). `Settings.jsx` perdeu as seções "Convenções de design" e "Atalhos de teclado" (jargão interno exposto ao usuário final).

**Identidade visual "Direção A — Neutro"** [commits ~176-181]: paleta cinza-grafite frio + acento único índigo (`--accent #818cf8` dark / `#4f46e5` light), tipografia reduzida a só Geist (tirou IBM Plex Mono e Fraunces de um refresh anterior não commitado, "Editorial Terminal"). Tokens de `radius` movidos para dentro do `@theme` do Tailwind 4 — bug real encontrado: estavam em `:root` mas fora do `@theme`, então `rounded-lg` etc. nunca pegavam o valor customizado. Bug de contraste WCAG recorrente: `--success` no tema claro mediu 3.77:1 (falha AA), o MESMO valor que uma auditoria anterior já tinha flagueado — corrigido para `#047857` (5.48:1), verificado ao vivo via `getComputedStyle`.

## Roadmap "melhoria completa do sistema" (pós-simplificação)

Depois da simplificação + identidade visual, usuário pediu um roadmap único consolidando tudo que falta e mandou executar do início ao fim. Numeração de fases reinicia em 1 aqui — não confundir com as Fases 1-20 acima, que são de um ciclo de trabalho anterior já concluído.

### Fase 1 — Cloud sync: correções de race condition e perda de dados ✅ CONCLUÍDA (commit 182)

- `beforeunload` agora tenta upload via `fetch(..., {keepalive:true})` direto (bypassa o SDK do Supabase, que nunca seta `keepalive`, confirmado lendo o bundle minificado) quando o snapshot cabe no limite de ~64KB do browser; acima disso cai pro fallback síncrono (`performUpload`, extraído do antigo `uploadSnapshotImmediate` para pular o gate de conflito nesse caminho de orçamento apertado).
- Upload normal (`uploadSnapshotImmediate`) passou a checar conflito remoto (`checkForRemoteChanges`) antes de subir — evita sobrescrever dado mais novo de outro dispositivo.
- Bug corrigido: `acknowledgeRemoteConflict()` ("Manter minhas alterações" no banner) limpava a flag de conflito mas nunca re-disparava o upload pendente — usuário clicava e nada subia até a próxima edição não relacionada.

### Fase 2 — CI/CD + e2e

- **2.1 — CI/CD (GitHub Actions)** ✅ CONCLUÍDA (commit 187). `.github/workflows/ci.yml` com 2 jobs paralelos: `checks` (lint + `npm test` + build) e `e2e` (Playwright, só Chromium — é o único browser configurado em `playwright.config.js`). Trigger em push pra `main` e em pull requests. `playwright.config.js` ganhou `retries: 2` e reporter HTML só em CI (`process.env.CI`), e `trace: "on-first-retry"` — sem isso não haveria artefato nenhum pra debugar uma falha de CI (o reporter default do Playwright não gera `playwright-report/`). Ainda não pushado pro remoto (16 commits locais à frente de `origin/main`, aguardando autorização explícita pra push).
- **2.2 — Corrigir specs e2e desatualizados** ✅ CONCLUÍDA (commits 183-185). 12 de 15 specs falhavam. Duas causas eram bugs reais de app, não só teste desatualizado:
  - **Race condition em `initDB()`** (`services/db/connection.js`): o módulo publicava `conn` (variável de módulo) logo após `db.connect()`, ANTES de `runSchemaBootstrap` (todas as migrations) terminar. Qualquer chamada concorrente a `initDB()` nessa janela caía no fast-path `if (conn) return conn` e recebia uma conexão com schema incompleto — reproduzido via `restoreDatabaseSnapshot` batendo em `DELETE FROM credit_reconciliation` (tabela da migration v8) e falhando com "table does not exist". A publicação de `conn` acontecia cedo de propósito, pra permitir que o reconcile pós-migration (`reconcileCredits`, disparado de dentro do próprio `initDB()` quando migrations 10/11 aplicam) não travasse esperando sua própria promise. Corrigido publicando `conn` só depois do `runSchemaBootstrap` completar, e movendo o reconcile pós-migration pra fora da IIFE que produz `initPromise` (roda depois que `initPromise` resolve, então as chamadas internas do reconcile pegam o fast-path legitimamente em vez de aguardar uma promise ainda pendente).
  - **Visão consolidada "Abatimentos por doador" inalcançável** depois da primeira importação: dois bugs se combinando.
    1. `ImportedMonthsCarousel.jsx` comparava `item.referenceMonth.slice(0, 7)` (7 chars) contra `selectedReferenceMonth` (data completa "YYYY-MM-DD", vinda do auto-anchor ou do `MonthSwitcher`) — nunca batia, então o card do mês ativo nunca aparecia como selecionado e clicar nele pra "fechar"/desmarcar na verdade re-selecionava o mesmo mês (no-op).
    2. Mesmo corrigindo a comparação, o `useEffect` de "mês implícito" (Sprint 2/P2, `Monthly.jsx`) re-disparava toda vez que `filters.referenceMonth` ficava vazio — inclusive quando o usuário limpava de propósito — e re-selecionava o mês mais recente imediatamente. O comentário original dizia "só roda uma vez" mas isso nunca foi de fato implementado. Corrigido com `hasAutoAnchoredRef`: desarma permanentemente assim que o auto-anchor roda uma vez OU quando já chega com um mês setado (deep-link).
  - Specs corrigidos (fixtures + assertions): CSVs de fixture ganharam as 4 colunas de conciliação (`CNPJ Estabelecimento`, `Número da Nota`, `Valor da Nota`, `Data da Nota`) exigidas desde a Fase 17-19; mensagem de sucesso do backup mudou de "Backup importado com sucesso" pra "Backup importado: {stats}." em algum commit anterior sem atualizar os specs; seção "CPFs encontrados" em Importações foi removida num refactor anterior (Sprint 3 / `MonthlyImportsOverviewSection` + `CpfListSearchSection` a substituíram) — `CpfSummaryItem.jsx` ficou como código morto (throw pra Fase 3.5); `MonthlySummaryRow` renderiza cada doador DUAS vezes no DOM (card mobile compacto + detalhe desktop, alternados via `md:hidden`/`md:block`) — `getByText(...).first()` pegava consistentemente o nó mobile (oculto no viewport padrão do Playwright) por ordem de DOM; trocado por `getByRole("button", ...)` (nome acessível não bate no card mobile, que concatena todo o texto do card) ou `.and(page.locator(":visible"))` quando precisa continuar sendo `getByText`.
  - 118/118 testes unitários/integração, 15/15 e2e (2 rodadas consecutivas), lint 0 erros, build OK.

### Fase 3 — Estrutural (SQL, cache, mutations, código morto) ✅ CONCLUÍDA (commits 189-193)

- **3.1 — Prepared statements restantes** (commit 189): `donorWriter.js`, `donorActivity.js`, `importReconcile.js` e `monthly/abatementUpdates.js` migrados de `escapeSqlString`/`execute`/`query` pra `executePrepared`/`queryPrepared` com `?`. O bulk-insert em `reconcileImport` (chunks de 200 rows) virou `(?, ?, ..., ?)` repetido + `params.flatMap(...)` em vez de interpolar cada valor no SQL. Os `escapeSqlString` que sobraram nos outros 14 arquivos são só nanoid IDs gerados no servidor — auditoria confirmou que já estavam assim antes.
- **3.2 — Drift de `normalizeCpfSqlExpression`** (commit 190): existiam DUAS definições idênticas — uma em `db/sql.js` (usada por `schema.js`), outra em `import/sqlExpressions.js` (usada por `importPipeline.js`). Hoje ainda eram byte-a-byte iguais (não tinha bug ativo), mas era uma duplicação esperando pra divergir. Consolidado: `import/sqlExpressions.js` agora importa de `../db` e re-exporta, só existe uma implementação.
- **3.3 — Invalidação do `queryCache`** (commit 191): bug real — `execute()` (o caminho de escrita não-prepared, em `connection.js`) nunca chamava `invalidateCache()`, só `executePrepared()` chamava. Qualquer mutação passando por `execute()` (ainda usado por ~14 arquivos) deixava o cache de leitura obsoleto até alguma chamada não relacionada via `executePrepared` limpar por acaso. Corrigido espelhando o mesmo `extractRowsAffected` + invalidação condicional que `executePrepared` já tinha.
- **3.4 — `Donors.jsx` → `useMutationAction`** (commit 192): os 5 handlers de mutação (create/update/delete/deactivate/reactivate) migrados pro hook genérico, igual `People.jsx`/`Demands.jsx`. `handleExport` ficou de fora de propósito (não recarrega dados, mensagem de sucesso depende do resultado — não encaixa no shape do hook). Dropped o check `isUserFacingError` antes de logar erro de criação/edição — o hook sempre loga, igual o padrão já estabelecido em People/Demands; Donors.jsx era o único lugar que ainda distinguia isso.
- **3.5 — Código morto** (commit 193): `Drawer.jsx`, `ImportHistoryItem.jsx`, `CpfSummaryItem.jsx` deletados (zero importadores — órfãos desde que `DonorSidePanel`/`ImportHistorySection`/`CpfSummarySection` foram removidos em ciclos anteriores). `imports/utils/options.js` podado de 8 exports pra 1 (`getPreviewColumnOptions` — o resto morreu junto com os mesmos componentes). `listCreditNotes`/`countCreditNotes`/`buildCreditNotesFilters` removidos de `creditImportPipeline.js` — o comentário de `CreditNotesSection` que os CLAUDE.md antigo descrevia como consumidor foi removido num commit posterior (158) que nunca atualizou essa entrada do changelog. `Imports.jsx:153-183` (deep-link effect "vindo do CommandPalette") também morto — nada mais seta esses `location.state` keys desde que o CommandPalette foi removido; `useLocation`/`useEffect`/`useRef` saíram dos imports junto.
- 118/118 testes, 15/15 e2e (múltiplas rodadas), lint 0 erros, build OK em cada commit.

### Fase 4 — Dashboard: severidade enxuta ✅ CONCLUÍDA (commit 195)

- **Texto de conciliação desatualizado**: `DashboardReconciliationSection` descrevia a chave de match como "(CNPJ, número da nota, data de emissão)" — mas a Fase 17-19 já tinha trocado data por valor (datas eram instáveis e geravam falso-divergente). Corrigido pra "(CNPJ, número da nota, valor)".
- **2 cards novos em "Pontos para revisar"**: "Importações com erro" (`imports.status = 'error'` — status real, setado em `importPipeline.js`/`creditImportPipeline.js` quando o processamento falha, mas que não tinha NENHUMA superfície visível antes — nem filtro, nem contagem, nem alerta) e "Abatimento acima do crédito" (doadores cujo total abatido com `abatement_status='applied'` supera o crédito real casado/divergente somado — mesmo conceito de "saldo negativo" que já existe por doador/mês em `MonthlySummaryRow`, agora agregado no dashboard). Grid de `xl:grid-cols-4` pra `xl:grid-cols-3` (6 cards, 2 linhas de 3 fica mais limpo que 4+2). Query nova de "abatimento acima do crédito" (CTE com `donor_applied`/`donor_credit`) verificada com um teste de integração real em `tests/migrations.test.js` reaproveitando a fixture `seedReconciliationFixtures` (Alice: R$1,00 abatido vs R$0,20 de crédito casado → aparece; Bruno: sem `monthly_donor_summary` aplicado → não aparece).
- **Aviso de mês desatualizado**: `DashboardCurrentMonthBanner` agora calcula quantos meses o "último mês com dados" está atrás do mês corrente (`monthsBehindCurrent`) e mostra um aviso se for 2+ meses (1 mês de atraso é normal — a planilha do mês corrente pode simplesmente não existir ainda).
- 119/119 testes (1 novo), 15/15 e2e, lint 0 erros, build OK.

### Fase 5 — Tabelas e escala ✅ CONCLUÍDA (commit 197) — Monthly pagination adiada de propósito

- **Bug real: opções recarregando a cada página** (`useDataResource.js`): `runLoad` refazia a query de `optionSource` (lista completa pra popular os dropdowns de filtro) toda vez que `filters` mudava de referência — inclusive quando só `limit`/`offset` mudaram (virar de página). `buildOptionFilters` já removia `limit`/`offset` do objeto, mas nada comparava o CONTEÚDO resultante contra a última carga — então paginar sem tocar em nenhum filtro real ainda refazia a query de "todas as opções" à toa. Corrigido com `lastOptionFiltersKeyRef` (assinatura JSON.stringify): só recarrega `optionSource` quando o conteúdo pós-neutralização realmente mudou.
- **Lixeira ganhou paginação server-side**: `listTrashItems` aceita `limit`/`offset` (0 = sem limite, mantém compat com chamadas antigas tipo `restoreTrashItem`'s internals). `countTrashItems` já existia (usado pro badge do Sidebar) e serviu de count-loader sem mudança. `Trash.jsx` migrado de `useDataResource` pra `usePaginatedResource`, com `PaginationControls` no topo e rodapé da lista.
- **Busca de Histórico era falsa em escala**: `ActionHistory.jsx` buscava com `listActionHistory({...filters, limit: 100})` — um hard-cap de 100 linhas MAIS RECENTES antes de qualquer paginação. Buscar por algo mais antigo que as últimas 100 ações simplesmente não encontrava nada, sem nenhuma forma de "ver mais". `actionHistoryService.js` ganhou `buildActionHistoryFilters` (extraído do WHERE compartilhado) + `countActionHistory`; `listActionHistory` passou a aceitar `offset` e usar `limit` como tamanho de página (25, igual as outras listas) em vez de "quantas linhas totais buscar". `ActionHistory.jsx` migrado pra `usePaginatedResource` — busca por texto agora alcança o histórico inteiro, paginado de verdade.
- **Paginação server-side do Monthly — adiada de propósito**: perguntei ao usuário antes de mexer, porque é o item de maior risco do roadmap (Monthly.jsx é a página mais complexa do app — filtros, overlay otimista, visão consolidada, ações em massa, a lógica de carrossel/âncora que corrigi hoje mesmo) e a análise anterior (Fase 4 do ciclo antigo, já documentada acima) já tinha concluído que o ROI é marginal abaixo de ~5k linhas. Usuário confirmou: manter client-side por agora, revisitar se os volumes reais passarem dessa marca.
- 119/119 testes, 15/15 e2e, lint 0 erros, build OK.

### Fase 6 — Consistência de componentes e acessibilidade ✅ CONCLUÍDA (commits 199-202) — 2 itens adiados de propósito

- **Skip-link** (commit 199): não existia nenhum "pular para o conteúdo principal" em lugar nenhum do app — usuário de teclado/leitor de tela tinha que passar pelo Sidebar inteiro (9+ links) em toda navegação entre páginas. `Layout.jsx` ganhou um link `sr-only focus:not-sr-only` como primeiro elemento focável, apontando pro `id={APP_SCROLL_CONTAINER_ID}` (que ganhou `tabIndex={-1}` pra ser um alvo de foco válido). Verificado ao vivo via Playwright: aparece no Tab, foco realmente move pro container ao clicar.
- **Hierarquia de headings** (commit 199): `PageHeader` usa h1, mas `SectionCard` usava h3 — pulava h2 em TODA página do sistema. Corrigido `SectionCard` h3→h2. Isso por sua vez quebraria `GroupSection` (Monthly, h4 direto dentro de SectionCard) e `NoteCard` (h3 direto sob o h1 de Notes.jsx, sem SectionCard no meio) — ambos corrigidos em cascata (h4→h3, h3→h2) pra manter a sequência válida. Outros usos de h2/h3 (`MonthlyImportsOverviewSection`, `CpfListSearchSection`, `CreditUploadModal`/`ImportUploadModal` dentro de `Modal`) já estavam corretos — auditados e confirmados, não precisaram de mudança.
- **`ErrorState` sem nenhum uso** (commit 200): componente existia pronto (ícone, título, descrição, ação, `role="alert"`) mas tinha zero importadores — `App.jsx`'s `CloudSyncGate` reinventava o mesmo painel à mão pro erro de hidratação do cloud sync. `ErrorState` ganhou `secondaryActionLabel`/`onSecondaryAction` (precisava de 2 ações: "Tentar novamente" + "Sair desta conta") e passou a ser usado ali, eliminando a duplicação.
- **Checklist de notas sem acesso por teclado** (commit 201): o toggle de check/uncheck era 100% via mouse — `handleMouseDown` só reagia a cliques dentro de 28px da borda esquerda do item (onde fica o glyph do `::before`). Nenhum `role`, `aria-checked` ou handler de teclado existia. Adicionado: `role="checkbox"` + `aria-checked` + `aria-keyshortcuts="Control+Enter"` em todo ponto de criação de checklist (3 no editor + o sanitizer em `noteContent.js`, que é o único caminho que sobrevive ao ciclo salvar/recarregar); `Ctrl+Enter` alterna o item sob o cursor (Enter sozinho continua quebrando linha — comportamento de texto normal preservado). Verificado com um teste e2e temporário cobrindo: criação via atalho de markdown, toggle por teclado nos dois sentidos, Enter simples não altera o estado, clique do mouse continua funcionando, e o ciclo salvar→reabrir preserva tanto `data-checked` quanto os atributos ARIA.
- **API de overlay inconsistente** (commit 202): `Modal` e `FormModal` usam `onClose`; `ConfirmModal` era o único com `onCancel` pro mesmo conceito. Renomeado pra `onClose` na definição + nos 11 call sites reais (`Demands`, `Trash`×2, `Settings`×2, `Donors`, `Notes`, `People`, `Imports`×2, `DonorAbatementAdjustmentsSection`). Os outros 2 `onCancel` em `Imports.jsx` (linhas do `ReimportModal`/`CreditReimportModal`) foram propositalmente deixados intactos — lá `onCancel` e `onClose` são conceitos genuinamente diferentes (cancelar a seleção de arquivo vs. fechar o modal).
- **Tokens de cor dentro de `@theme`**: investigado e descartado. Ao contrário do fix de `--radius-*` (que corrigia um bug real — `rounded-lg` não pegava o valor customizado), mover cores pra `@theme` sem also renomear pra `--color-*` (namespace exigido pelo Tailwind 4 pra gerar utilities) não muda nada. Fazer certo exigiria renomear ~30 tokens e atualizar toda referência `var(--x)` no código — uma mudança mecânica grande, sem ganho funcional visível, só para habilitar uma sintaxe de utility que nada usa hoje. Não fiz.
- **44px touch targets**: auditado — `Button`/`Modal`'s botão de fechar já usam 40px de forma consistente como baseline; `CopyButton` já tinha sido especificamente expandido pra 44×44 numa fase anterior. Não encontrei violação concreta além do que já estava corrigido.
- **Unificar hooks de import (`useDonationImportFlow`/`useCreditImportFlow`) e autosave de notas — adiados de propósito**: mesmo perfil de risco da paginação do Monthly (779 linhas de pipeline de import CRÍTICO, funcionando, sem teste de regressão dedicado). O autosave de notas já tinha sido adiado numa fase anterior pela mesma razão (duas máquinas de estado paralelas entrelaçadas, sem cobertura E2E). Mantive a mesma decisão sem reabrir a pergunta ao usuário, já que o precedente documentado é claro.
- 119/119 testes, 15/15 e2e (múltiplas rodadas), lint 0 erros, build OK em cada commit.

### Fase 7 — Polimento final ✅ CONCLUÍDA (commits 204-205) — 2 itens investigados e descartados

- **Breakpoint `lg:` ausente em grids de filtro/estatística** (commit 204): confirmado ao vivo por screenshot que grids pulando direto de `md:grid-cols-2` pra `xl:grid-cols-4`/`5` deixavam uma "zona morta" entre 1024-1279px onde a contagem de colunas não acompanhava a largura disponível — 2 colunas até 1280px, depois pulava direto pra 4/5. Adicionado `lg:grid-cols-3` em 6 grids: `MonthlyFiltersBar.jsx` (a versão com classe dinâmica por template literal + a estática), `DashboardOverviewCards.jsx` (2 grids), `DashboardLatestMonthSection.jsx`, `DashboardModals.jsx` (grid do modal de detalhe do último mês) e `DashboardReconciliationSection.jsx` (grid dos 5 cards de conciliação).
- **`inputMode="numeric"` em campos de CPF** (commit 204): teclado numérico em mobile pros 3 pontos de entrada de CPF restantes (`DonorForm.jsx`, compartilhado entre criar/editar doador; `People.jsx` criar + editar).
- **Distinção de empty state "sem cadastro" vs "filtro sem resultado"** (commit 205): `Donors.jsx`/`People.jsx`/`Demands.jsx` mostravam o MESMO empty state ("nada cadastrado, clique aqui pra criar o primeiro") tanto quando a lista estava genuinamente vazia quanto quando só os filtros aplicados não bateram com nada — usuário via um CTA de "cadastrar" quando só precisava limpar um filtro. Corrigido comparando `JSON.stringify(filters)` contra o `INITIAL_*_FILTERS` de cada página: se diferente, mostra "Nenhum X encontrado" + botão "Limpar filtros" (reusa o `handleClearFilters` que cada página já tinha); se igual (filtros no estado inicial), mantém o empty state original de "cadastre o primeiro".
- **Unificar `DonorListItem` com o padrão de `PersonListItem`/Demands/Trash — investigado e descartado**: `DonorListItem` usa um `DonorActionMenu` (dropdown mobile) porque expõe 5 ações; os outros usam botões sempre visíveis porque têm só 2-3 ações. A diferença de padrão é justificada pela diferença de contagem de ações, não é inconsistência acidental. Não fiz.
- **Máscara de moeda no campo `valuePerNote` — investigado e descartado**: ganho é cosmético (formatar dígitos como centavos enquanto digita); o risco é mexer em parsing de valor monetário que já funciona e já tem teste dedicado (`parseValuePerNote`). Custo/benefício não favorece a mudança agora.
- 119/119 testes (nenhum novo — mudanças são JSX condicional/classe CSS, sem lógica nova), 15/15 e2e, lint 0 erros, build OK em cada commit.

**Estado atual: as 7 fases do roadmap consolidado (pós-simplificação + identidade visual) estão completas.** Itens adiados intencionalmente ao longo do roadmap, cada um com justificativa na sua própria seção acima: paginação server-side do Monthly (Fase 5), tokens de cor dentro do namespace `@theme` do Tailwind (Fase 6), unificação dos hooks de import + autosave de notas (Fase 6), unificação de `DonorListItem` e máscara de moeda (Fase 7).

## Bug fix — CPF bloqueado permanentemente após excluir pessoa/doador (commit 207)

Usuário reportou: CPF de uma pessoa cadastrada e depois excluída continuava acusando "já existe"/"já está vinculado" tanto pra recriar a pessoa quanto pelo botão "Converter" (Pessoas → tornar em doador). Investigação por leitura de código + reprodução real contra DuckDB-Node (migrations reais, não só teoria) achou 3 causas concretas — nenhuma mutuamente exclusiva, os 3 fixes são complementares:

- **`deletePerson` só bloqueava por doador ATIVO** (`personService.js`): um doador DESATIVADO (não excluído, `donors.is_active = FALSE`) ainda referencia a pessoa via `person_id`, mas o guard de `deletePerson` só checava `is_active = TRUE`. Dava pra excluir a pessoa com um doador inativo ainda pendurado, deixando `donors`/`donor_cpf_links` órfãos (`person_id` apontando pra um registro que não existe mais) e o CPF bloqueado pra sempre. Corrigido: guard agora bloqueia por QUALQUER doador vinculado (ativo ou inativo), com mensagem distinta orientando a reativar/excluir o doador pela tela de Doadores antes de remover a pessoa.
- **`createDonor` não era atômico** (`donorWriter.js`): `resolveCreatePersonContext` podia criar (e commitar imediatamente, fora de qualquer transaction) uma pessoa nova ANTES de validações que ainda podiam falhar (demanda inexistente, auxiliar já vinculado, etc.). Se essas validações falhassem depois, a pessoa recém-criada não era desfeita — sobrava uma "pessoa fantasma" bloqueando aquele CPF pra sempre, com uma mensagem de erro que não tinha nada a ver com o efeito colateral real (ex.: "selecione uma demanda" não avisa que uma pessoa ficou órfã no banco). Corrigido: `resolveCreatePersonContext` + todas as validações + os 2 INSERTs finais agora rodam dentro de uma única `runInTransaction` — qualquer falha desfaz tudo, inclusive a pessoa. Mensagens de erro pro usuário continuam idênticas; só o estado do banco em caso de falha que mudou.
- **`ensureDonationCpfIsAvailable` usava LEFT JOIN** (`donorChecks.js`): uma linha órfã em `donor_cpf_links` (sem `donors` correspondente — por qualquer causa histórica, incluindo as duas acima) bloqueava o CPF pra sempre e era invisível na tela de Doadores (que só encontra por CPF via `EXISTS` contra um `donors.id` existente). Trocado pra INNER JOIN — link órfão deixa de contar como "CPF em uso". Esse é o fix que resolve retroativamente qualquer órfão pré-existente assim que o usuário atualizar o app, sem precisar de ação manual — não foi possível confirmar qual das 3 causas gerou o caso específico reportado (dado é local-first, sem acesso ao banco do usuário em produção).

2 testes de integração novos em `tests/migrations.test.js`, reproduzindo cada cenário contra DuckDB-Node real com as migrations reais (não SQL inventado). 121/121 testes, 15/15 e2e — incluindo `auxiliary-reference-person.spec.js`, que exercita "Converter pessoa em doador" ponta a ponta e confirma zero regressão no fluxo normal — lint 0 erros, build OK.

## Rodada de melhorias pedidas pelo usuário (commits 209-210)

Quatro pedidos diretos: auxiliares visíveis no titular, rastreio de quem parou de doar, crédito por mês, e correção de problemas visuais.

**Commit 209 — dados e features**:
- **Auxiliares no card do titular**: novo `MONTHLY_AUXILIARY_SUBSELECT` em `monthly/sharedFragments.js` (correlaciona `donors.person_id` ← `auxiliary_donors.holder_person_id`), embutido em `MONTHLY_DONOR_PROJECTION` (cobre `listByMonth` + `listHistorical`) e também na query de `donorRows` do `listByMonth` (o caminho "sem doação no mês", que não usa a projection). `parseAuxiliaries` + campo `auxiliaries` nos 3 mappers. Render: bloco "N auxiliar(es) vinculado(s)" com os nomes, espelhando o "Vinculado a:" que já existia no sentido oposto.
- **Crédito por mês** (era o total de TODOS os meses): `listDonorReconciliationStatuses` voltou a ser só o rollup all-time (consumido por `countDonorReconciliationIssues`); novo `listDonorMonthReconciliationStatuses()` agrega por `(doador, mês)` com CTEs `credit_by_month` (via `donation_notes.reference_month`) + `abated_by_month` (via `monthly_donor_summary.reference_month`) unidas por `UNION` das chaves. Os DOIS lados são escopados juntos — escopar só o crédito compararia um mês contra o abatimento all-time e geraria "excedido" falso. `buildDonorMonthKey()` exportado para o lookup não divergir entre o filtro de `Monthly.jsx` e o `MonthlySummaryList`. Corrige também a visão histórica, onde cada linha é um mês mas mostrava o total de vida do doador repetido.
- **Meses consecutivos sem doar**: `services/monthly/inactivityStreaks.js` + `inactivityStreaksSql.js` (SQL isolado, zero imports, para o teste rodar a query REAL contra DuckDB-Node em vez de espelhá-la e divergir). Grade de meses vem de `imports` processados (não do calendário — mês sem planilha não é evidência de que alguém parou). Atividade resolvida por CPF via `import_cpf_summary` → `donor_cpf_links`, NÃO por `monthly_donor_summary`: as linhas de summary são por titular (nota de auxiliar sobe pro titular), então usar summary reportaria todo auxiliar como "nunca doou" e esconderia um titular que parou enquanto o auxiliar continua. Meses anteriores ao `donation_start_date` são excluídos. Superfícies: badge no card da Gestão Mensal (só no mês mais recente — a métrica é "estado atual", exibi-la num mês antigo seria mentira) + card "Pararam de doar" e modal-lista de contato no Dashboard (lista completa, não amostra de 5). `describeInactivity()` compartilhado para o mesmo doador nunca aparecer vermelho num lugar e laranja no outro.
- 4 testes de integração novos (2 de streak incluindo o caso do auxiliar, cobrindo também que import `pending` não entra na grade e que `donation_start_date` limita os meses elegíveis).

**Commit 210 — visual**:
- **Colunas quebradas/sobrepostas no card de doador** (o problema mais grave, confirmado por screenshot): as 5-6 métricas viviam numa coluna `minmax(0,1fr)` do meio de um grid de 3 colunas — sobravam ~55px por métrica e "R$ 22.222,08" / "Crédito" / "Saldo" se sobrepunham literalmente. O grid virou 2 colunas (identidade | ações) e as métricas ganharam uma faixa de largura total separada por divisória, com ~180px cada.
- **Seleção verde com borda azul**: `--accent-2-soft` (verde) era usado como fundo de seleção junto de uma borda `--accent` (índigo) — dois matizes brigando, e o verde ainda colidia com o significado de "sucesso/realizado" dos badges do mesmo card. Novo token `--accent-selected` (índigo sutil, ambos os temas). Mesmo bug corrigido na aba ativa e na linha do mês corrente de `MonthlyImportsOverviewSection`.
- **Padronização do token de sucesso**: `--accent-2`/`--accent-2-soft` eram um alias legado com nome de "acento secundário" usado como "sucesso" em ~15 arquivos. Criado `--success-soft` semântico, os 15 usos migrados e os aliases legados removidos (auditado: zero consumidores de `var(--accent-2)` puro).
- **Overflow no Dashboard/toolbar**: `OverviewMetric` dividia largura com o ícone, deixando ~110px pro número — "R$ 1.938.259,20" vazava do card. Ícone movido pra linha do rótulo, valor usa a largura inteira. `MetricValue` ganhou tamanho responsivo (`text-[2rem] lg:text-[2.5rem]`) + `break-words` + `max-w-full`; `MetricField` idem. `MonthlySummaryToolbar` ganhou o `lg:grid-cols-3` que faltava.
- 123/123 testes, 15/15 e2e, lint 0 erros, build OK. Verificação visual antes/depois por screenshot com dataset semeado (nomes longos, R$ 1,9M, titular com 2 auxiliares, 4 meses com lacunas).

## Planilha de abatimento + contagem de registros (commit 212)

- **Planilha de abatimento** (`services/monthly/abatementSheet.js` + `abatementSheetSql.js` + `abatementSheetDescription.js`): CSV por mês para importar no sistema externo que dá baixa nas doações. Colunas: CPF, Nome completo, Demanda, Descrição, Quantidade de doações. Botão "Planilha de abatimento" no toolbar da Gestão Mensal; exige mês selecionado (a descrição carrega o mês, então "todos os meses" geraria descrição ambígua no destino).
  - **Uma linha por CPF de doador**, agrupando por `donor_cpf_links` e NÃO por `monthly_donor_summary` — as linhas de summary são por titular (nota de auxiliar sobe pro titular), mas o sistema de destino abate por CPF, então o auxiliar precisa da linha e da contagem dele. No teste: titular 12 + auxiliar 5 saem separados, não 17 somados.
  - **Descrição**: `Doações NFP - Abr/2026` para titular sem auxiliar; `Doações NFP - [Nome] - Abr/2026` para auxiliar e para titular QUE TEM auxiliar. O nome entra exatamente quando o grupo tem mais de uma pessoa doando pro mesmo titular — lá o titular recebe vários lançamentos no mês e sem o nome não se sabe de qual CPF é cada um. `group_has_auxiliaries` na query resolve os dois lados (TRUE para todo auxiliar; para titular, `EXISTS` de auxiliar ativo).
  - `formatMonthAbbrev` em `utils/date.js` com abreviações fixas (Jan..Dez) em vez de `Intl` com `month: "short"` — o pt-BR devolveria "abr." (minúsculo, com ponto) e a forma varia entre runtimes; o valor vai pra outro sistema, precisa ser estável.
  - Descrição isolada em `abatementSheetDescription.js` (sem import de banco) para o teste exercitar a função de produção em vez de reimplementar o formato. Idem `abatementSheetSql.js` pro SQL. Esses módulos usam import COM extensão `.js` — Node ESM não resolve sem, ao contrário do Vite.
- **Bug real: contagem de registros em Pessoas** (`People.jsx`): o `loader` era `listPeople({...filters, role: "reference"})` mas o `countLoader` era `countPeople` puro, SEM o `role`. A página lista só pessoas sem papel de doador, mas o contador tallyava toda pessoa ativa (doadores incluídos) — total inflado e últimas páginas vazias. Isso violava o invariante que o próprio `personService.js` documenta ("count and slice running against the exact same predicate"). Corrigido com `countReferencePeople`.
- **Bug de exibição em Pessoas e Doadores**: subtitle do `PageHeader` e "N resultado(s) na lista" usavam `people.length`/`donors.length` — o tamanho da PÁGINA (25), não o total. Trocado por `pagination.totalItems` nos 4 pontos. Verificado ao vivo: com 4 pessoas de referência + 3 doadores, Pessoas mostra "4" (antes contaria 7) e Doadores "3".
- 125/125 testes (2 novos de integração), 15/15 e2e, lint 0 erros, build OK. CSV conferido ao vivo por download real no Playwright.

## Busca por texto, planilha por demanda, reenquadramento da conciliação (commit 214)

- **Busca por texto livre nos filtros** (item que estava adiado desde o Sprint 9): `buildTextSearchCondition(term, columns)` em `db/sql.js`, usado por Doadores, Pessoas, Demandas e Gestão Mensal (as duas queries do `listByMonth` + `listHistorical`). Compara com `strip_accents(lower(...))` dos DOIS lados — nomes são gravados com acento (`normalizePersonName` só faz upper), então quem digita "joao" não acharia "JOÃO" sem isso. Colunas de CPF casam por dígitos (`529.982` = `529982`); termos com menos de 3 dígitos pulam a cláusula de CPF pra não arrastar CPF por causa de um dígito solto no nome. `search` entra em `neutralizedKeys` nas 4 páginas — senão digitar na busca encolheria também as opções dos dropdowns.
  - **Bug encontrado pelo e2e**: `listMonthlySummaries` (o dispatcher em `monthlyService.js`) destrutura uma lista EXPLÍCITA de filtros e descartava `search` em silêncio — a busca funcionava em Doadores/Pessoas/Demandas e não fazia nada na Gestão Mensal. Comentário adicionado no dispatcher avisando que filtro novo precisa entrar nos dois ramos.
  - **Teste é unitário, não de integração, de propósito**: o bundle node-blocking do harness é o MVP, que quebra com `_setThrew is not defined` em `LIKE '%' || ? || '%'` dentro de prepared statement — o MESMO bug de Emscripten que fez `connection.js` escolher o bundle EH pro browser. Isolei com 4 probes até confirmar que é do harness, não do SQL. Cobertura: `tests/textSearch.test.js` valida o SQL/params gerados, e o comportamento real foi verificado no navegador (bundle EH) com nomes acentuados, CPF pontuado, demanda e caso sem resultado, com zero erro de SQL no console.
- **Planilha de abatimento separada por demanda**: um CSV por demanda, `.zip` quando há mais de uma (mesmo padrão dos PDFs/JPEGs por demanda), CSV direto quando há só uma. Demanda sem doação no mês não gera arquivo — a query já só devolve CPF com nota, então o agrupamento nunca produz grupo vazio. `buildSlug` foi extraído de `donationReportRenderer.js` pra `utils/slug.js` e é compartilhado, pra mesma demanda gerar o mesmo nome de arquivo nos dois tipos de export. BOM por arquivo dentro do zip (cada CSV é aberto individualmente no Excel depois de descompactar). Verificado ao vivo: zip com `cestas-basicas` + `remedios`, descrição com nome só no grupo que tem auxiliar.
- **Métrica "abatimento acima do crédito" removida** (usuário: "não é importante"): badge amarelo do Sidebar, card e modal do Dashboard, a query CTE em `dashboardService` e `countDonorReconciliationIssues` inteira. Bug corrigido de passagem: o badge da Lixeira reusava o tooltip hardcoded "N doador(es) com conciliação fora do limite" — agora `NavItem` recebe `badgeTitle` e o da Lixeira diz o que realmente é. Badge também deixou de ser amarelo (era alerta pra algo que não é alerta).
- **"Pendências" da conciliação reenquadradas**: as planilhas vêm prontas da NFP e o usuário não pode corrigi-las, então a linguagem não pode sugerir tarefa. `N pendência(s)` → `N não conciliada(s)`, tom `danger`/`warning` → `info`, tooltip explicando a origem. Rótulos do detalhamento viraram descritivos e neutros (`Divergentes`→`Valor diferente`, `Sem doação`→`Só no crédito`, `Sem crédito`→`Só na doação`, `Duplicadas`→`Repetidas`), sem vermelho/laranja. O filtro de meses passou a ser sobre o trabalho do usuário — `Com pendências`→`Com abatimento pendente`, `Tudo conciliado`→`Tudo abatido` — e `rowHasPendingAbatement` só olha `abatement.pendingCount`, sem misturar divergência de conciliação. `StatusBadge` ganhou prop `title`.
- 132/132 testes (7 novos unitários de busca), 15/15 e2e, lint 0 erros, build OK.

## Borda dupla no foco + abatimento pendente fantasma (commit 216)

- **Borda dupla ao focar input**: `TextInput`, `Textarea` e o gatilho do `SelectInput` combinavam `focus:border-[var(--accent)]` COM `focus-visible:ring-2 ... ring-offset-2`. O anel deslocado desenha uma segunda linha azul separada da borda — daí as "duas bordas azuis". Extraído `components/ui/focusRing.js` com `FOCUS_RING` (borda accent + `ring-1` SEM offset, então os dois viram uma borda única de ~2px) e aplicado nos 4 controles (incluindo `MonthInput`, que já era só borda, pra ficarem iguais). O anel solto do campo de busca interno do `SelectInput` também saiu. Foco continua visível pra teclado — verificado por `getComputedStyle`: 1 camada de box-shadow, contra 2 antes.
- **Bug real: "abatimento pendente" em mês já fechado** (`monthlyOverviewService.js`). A visão por mês contava `abatement_status = 'pending'` cru, sem nenhuma das regras que a Gestão Mensal aplica na tela. Duas classes de linha ficavam pendentes pra sempre, sem o usuário ter como resolver:
  - **Linhas cobertas por um acumulado lançado em outro mês**. Na Gestão Mensal elas aparecem como "Via acumulado" com o toggle desabilitado (`markSubsumedRows`) — o valor já foi abatido junto do mês do acumulado, mas o `abatement_status` cru delas continua `'pending'` no banco. Era exatamente o caso relatado: mês impossível de fechar acusando pendência.
  - **Linhas sem nota no mês** (`notes_count = 0`), que a tela mostra como "Sem doações no mês" e nem oferece botão.
  - Corrigido com uma subquery `is_actionable` (`notes_count > 0 AND NOT EXISTS` acumulado cobrindo o mês) usada tanto no `pending_count` quanto no `total_pending`.
  - **Terceiro bug no mesmo trecho**: `total_applied` somava `abatement_amount` de TODAS as linhas, contrariando o próprio comentário ("Only counts rows the operator has actually marked") — inflava o "Abatido" na comparação com o crédito real. Agora filtra por `abatement_status = 'applied'`.
  - Reproduzido contra DuckDB real antes de corrigir (3 meses acusando pendência → 0) e verificado no navegador com o mesmo cenário; teste de regressão em `tests/migrations.test.js`.
- **`MonthlyImportsOverviewSection` passou a filtrar por domínio** (`["imports", "monthly"]`) em vez de allowlist de `sources`. Marcar abatimento roda dentro de `runInTransaction`, que emite o source genérico `"transaction"` quando o chamador não etiqueta — fora da allowlist antiga. O caminho principal da UI etiqueta `monthly-action-history` e funcionava, mas qualquer chamada não etiquetada deixava a seção desatualizada. Domínio cobre os dois casos (evento sem domínio passa por back-compat) e ainda filtra ruído de `notes`.
- 133/133 testes (1 novo), 15/15 e2e, lint 0 erros, build OK.

## Rótulo de campo capturando clique fora do input (commit 218)

Usuário relatou que "mesmo clicando fora do input de busca, ele é selecionado". O `<label>` dos controles de formulário era `block` — ou seja, ocupava a LARGURA INTEIRA da linha (960px no filtro de Doadores), não só a largura da palavra. Como `<label for=...>` foca o controle associado, clicar em qualquer ponto daquela faixa aparentemente vazia à direita do texto "Busca" focava o input.

Mapeado empiricamente antes de corrigir: uma varredura de cliques por coordenada na página inteira mostrou exatamente 2 pontos que focavam a busca, ambos resolvendo para `LABEL ... texto="Busca"` a centenas de pixels do texto visível. Depois do fix: nenhum.

Corrigido com `w-fit` no rótulo dos 4 controles (`TextInput`, `Textarea`, `SelectInput`, `MonthInput`) — a área clicável passa a coincidir com o texto visível (960px → 41px). O contrato de acessibilidade continua: clicar NO texto do rótulo ainda foca o campo (verificado nos dois sentidos no navegador).

Vale como regra pro projeto: rótulo de formulário nunca deve ser `block` puro, senão vira um alvo de clique invisível do tamanho da linha.

## Robustez do cloud sync: flush ao sair + testes (commit 222)

Partiu de uma auditoria pedida pelo usuário ("sugestões de melhoria"). **Correção de rumo importante:** minha primeira sugestão foi "comprimir o snapshot antes de subir" — a compressão gzip JÁ existia (`compressPayload`/`readSnapshotBlob`). O número que eu tinha apresentado (12 MB/upload em 1 ano) era do JSON cru; com gzip o upload real fica em ~340 KB. Medido depois com `gzipSync` sobre linhas no formato real de exportação:

| Volume | JSON | gzip | cabe no keepalive (60 KB)? |
|---|---|---|---|
| 1 mês (1,2k notas) | 0,99 MB | 0,03 MB | sim |
| 6 meses | 5,94 MB | 0,17 MB | não |
| 1 ano | 11,90 MB | 0,34 MB | não |
| 3 anos | 35,80 MB | 1,02 MB | não |

- **O risco real (esse sim confirmado)**: o único caminho que sobrevive ao fechamento da aba é `fetch(keepalive)`, limitado pelo navegador a ~64 KB. O snapshot comprimido passa disso em ~2 meses de uso, então o `beforeunload` caía sempre no fallback que o navegador costuma matar — a proteção contra perder trabalho parava de valer cedo e em silêncio.
- **Corrigido** adicionando flush em `visibilitychange → hidden` e `pagehide`: nesses eventos a página ainda está viva, então o upload normal roda **sem limite de tamanho**. Cobre os casos que dominam na prática (trocar de aba, trocar de app, background no mobile — onde `beforeunload` muitas vezes nem dispara). O `beforeunload` continua como última linha, com o prompt nativo.
- **Extração para testabilidade**: `db/cloudSyncDecisions.js` (decisões puras) e `db/snapshotCodec.js` (serialização/compressão) — nenhum dos dois importa Supabase ou DuckDB, então rodam em Node. `cloudStorage.js` passou a consumi-los, eliminando as duplicatas locais.
- **16 testes novos** onde antes havia só helpers de caminho/tradução de erro. O de maior valor: `isObjectNotFoundError` — classificar 401/403/500/"Failed to fetch"/JWT expirado como "não encontrado" faria o app hidratar vazio e, no flush seguinte, **subir o vazio por cima dos dados bons**. O teste trava os 7 casos perigosos. Também cobertos: gate de conflito exigir os dois lados conhecidos (senão usuário novo nunca sincroniza), limite do keepalive, round-trip de gzip incluindo compatibilidade com snapshots antigos em JSON puro, BigInt de `valor_cents` e acentuação.
- **Continua sem cobertura** (precisa de projeto Supabase de teste ou fake do cliente): a orquestração em si — debounce, coalescing e o upload de verdade. O e2e roda com `VITE_NOTAR_AUTH_MODE=local`, que desliga o Supabase inteiro, então não alcança essa camada.
- 149/149 testes, 15/15 e2e, lint 0 erros, build OK.

## Conceito de "abatimento excedido" removido por completo (commit 224)

Fechamento do resíduo apontado na auditoria: o commit 214 tinha removido o contador (badge do Sidebar, card e modal do Dashboard), mas o alerta continuava aparecendo em 4 lugares — badge vermelho "Crédito excedido" no card da Gestão Mensal, saldo em vermelho, opção "Abatimento excedido" no filtro de conciliação, status no perfil do doador e rótulo no CSV.

**Por que sai por inteiro, e não só o card:** `computeReconciliationStatus` marcava `exceeded` quando abatido > crédito casado. Sem a planilha de créditos do mês importada, o crédito casado é zero por definição — então qualquer abatimento já marcado acendia o alerta. Ou seja, o alarme disparava com mais força justamente no caso mais comum e menos problemático, apontando erro onde não havia nenhum.

- `computeReconciliationStatus` colapsou para `no-credit` | `ok` (tem ou não crédito casado). Sem `RECONCILIATION_EPSILON`, que só existia para a comparação removida.
- Rótulos passaram a ser descritivos: `Dentro do limite` → `Com crédito conciliado` (Gestão Mensal, perfil do doador e CSV).
- **Os números continuam à vista**: a coluna "Saldo" segue mostrando a diferença, agora em cor neutra, com a legenda descritiva "Abatido acima do crédito casado" quando negativa. O que saiu foi o julgamento automático, não o dado.
- Verificado no navegador com o cenário que antes disparava o alerta (abatido R$ 540 × crédito casado R$ 20): nenhum badge, saldo em `rgb(28,28,31)` (cor padrão, não vermelho), filtro só com "Com crédito conciliado"/"Sem crédito conciliado", perfil idem.
- 147/147 testes, 15/15 e2e, lint 0 erros, build OK.

## Dashboard: modais acionáveis, ranking filtrável e reorganização (commits 226-228)

Usuário pediu quatro coisas: ver TODOS os doadores nos cards de "Pontos para revisar" (não só uma amostra) e poder resolver dali mesmo; o mesmo para "Pararam de doar" e os demais; gestão melhor em "Maiores doadores" (filtro por demanda, mês); e reorganizar a página inteira, "talvez até colocar gráficos". Executado em três etapas.

**Commit 226 — modais que resolvem, não só listam**:
- Os 5 detalhamentos de inconsistência tinham `LIMIT 5` enquanto o card mostrava o total real: abrir "12" mostrava 5 linhas. Subiu para 500 e as chaves `*Samples` viraram `*Rows` (`latestMonthUnregisteredCpfSamples` continua amostra de propósito, LIMIT 10).
- `InconsistencyRow` + `InconsistencyFixes` + `useDashboardActions`. Correção inline por tipo: campo de mês em "Sem início", seletor de demandas em "Sem demanda", mês pré-preenchido em "Antes do início" (recua o início até cobrir a doação), mês de desativação em "Pararam de doar". Mais "Ver perfil", "Excluir" (com desfazer) e "Ir para Importações" nas linhas de importação.
- As correções recarregam o doador inteiro e chamam `updateDonor` trocando um campo. É onde moram CPF único, "início não pode ser posterior ao histórico de atividade" e o espelhamento em `donor_cpf_links`; um UPDATE parcial apagaria os outros campos e furaria as validações.
- Confirmação de exclusão é INLINE (botão vira "Confirmar/Cancelar"), não `ConfirmModal` sobre o modal — empilhar traria disputa de foco e de Esc.
- **Bug real no componente compartilhado**: `FeedbackMessage` no modo `persistent` cai no ramo `AlertBox`, que **descartava `actionLabel`/`onAction`** — nenhum "Desfazer" apareceria numa faixa inline. Não dava para usar toast: o viewport de toast é `z-[100]` e o modal `z-[110]`, então renderizaria atrás do overlay. `AlertBox` passou a aceitar a ação.
- `variant="secondary"` não existe no `Button` (só primary/danger/subtle/ghost) e cairia em primary pelo fallback; `min-h-9` conflitaria com o `min-h-10` base e furaria o alvo de toque de 40px da Fase 6.
- `e2e/dashboard-actions.spec.js` (2 testes). "Sem demanda" só é alcançável via auxiliar ligado a pessoa de referência — que não tem demanda para herdar; demanda é obrigatória para titular e demanda vinculada não pode ser excluída.

**Commit 227 — ranking com recorte próprio**:
- `listTopDonors({referenceMonth, demand, sort, limit})` + `getTopDonorFilterOptions()`. SQL em `services/dashboard/topDonorsSql.js` (módulo puro, padrão de `inactivityStreaksSql.js`) para o teste rodar a query de produção.
- **Recorte por mês corrige dado enganoso**: o ranking era sempre o total de vida do doador, inclusive na visão histórica.
- Saiu do payload de `getDashboardOverview` — trocar filtro não reprocessa as ~13 agregações. Opções em recurso separado, senão cada troca de mês refaria os dois `DISTINCT` (mesma classe do bug da Fase 5).
- "Mais meses doando" some com mês fixo, e o valor sai do filtro de verdade: escondê-lo mantendo `sort: "months"` deixaria a query ordenando por coluna constante.
- `ORDER BY` por whitelist e `LIMIT` por `Math.floor(Number())` — DuckDB não aceita `?` em nenhuma das duas posições. Teste cobre que ordenação inválida cai no padrão.
- 3 testes de integração + `e2e/dashboard-ranking.spec.js` com `fixtures/ranking-backup.json`, montada para as três ordenações darem resultados DIFERENTES (senão o teste passaria com o filtro inerte).
- **`monthly_donor_summary` é recalculado a partir de `import_cpf_summary` no restore** — semear a tabela de resumos direto num backup não tem efeito. A fixture semeia a origem.

**Commit 228 — reorganização + gráfico**:
- Quatro zonas: mês corrente → o que precisa de atenção → como está indo → consulta. "Pontos para revisar" subiu de quarta para segunda seção.
- **"Pontos para revisar" esconde os zeros.** O caso comum (um problema real) gastava uma tela inteira exibindo cinco zeros.
- **Gráfico de evolução mensal** (`MonthlyTrendChart`): barras em HTML/CSS, sem dependência nova. **Série única com alternância de métrica** (abatimento/notas/doadores) — reais e contagem em escalas incompatíveis no mesmo eixo é a comparação mais enganosa possível; a regra é um eixo só. Cada coluna é um `<button>`: alvo de toque cobre a altura inteira e o teclado alcança os valores. Tabela `sr-only` como alternativa acessível.
- **Tokens `--data-*` corrigidos por medição**: zero consumidores até aqui (criados na troca de identidade visual). O validador de paleta reprovou o dark — `#818cf8` (L 0.68) e `#34d399` (L 0.77) fora da faixa 0.48–0.67 exigida para marcas em fundo escuro. Trocados por `#6366f1` / `#059669`, que passam as seis checagens contra a superfície real do app nos dois temas.
- **`MetricValue` não quebra mais número no meio.** `break-words` partia "R$ 1,00" em "R$ 1," + "00" — que se lê como outro valor. Virou escada de tamanhos com `whitespace-nowrap`. Limiares calibrados MEDINDO no navegador: card de 113px úteis precisava de 169px para "R$ 70,00" a 40px.
- `DashboardLatestMonthSection` foi de `xl:grid-cols-5` para `lg:grid-cols-3` — cinco cards deixavam 113px por valor. Depois: 227px, todos os degraus cabem, zero estouros medidos.
- Card "Último mês importado" removido dos totais: o mês já aparecia no banner, no resumo, no detalhamento por demanda e nas importações recentes.
- `DashboardRankingsSection` dividido em `TopDonorsSection` + `DashboardDemandBreakdownSection` (deixaram de ser a mesma coisa). As duas seções do último mês ficaram adjacentes, mas **empilhadas** — lado a lado, o resumo de 5 métricas truncava rótulos e sobrepunha valores (confirmado por screenshot).

**Estado:** 151/151 testes (4 novos de integração), 18/18 e2e (3 novos), lint 0 erros, build OK. Verificação visual por screenshot em ambos os temas.

## Plataforma multiprojeto (commits 232-235)

Sistema evoluiu de projeto único para plataforma. Documento de arquitetura (v3) publicado como artifact; decisões fechadas lá: **Demanda subdivide Projeto**, **projeto como ambiente com Importações compartilhada**, **projeto novo com Dashboard, Doadores e Anotações**.

**Regra de negócio que define o modelo:** todos os projetos compartilham o MESMO CNPJ recebedor. Existe uma planilha só, uma importação, uma conciliação, uma base de doações. **O projeto não vem da planilha — vem do vínculo doador→projeto, com vigência em mês.** (Uma versão anterior da proposta assumia um CNPJ por projeto e roteava a importação por ele; estava errada e foi descartada.)

Consequência: nenhuma tabela de importação/doação/conciliação recebe `project_id`. O projeto é uma **dimensão de atribuição**, não uma partição de dados.

### Fase 1 — Vínculo e projeto (commit 232)

- **Migration v12**: `projects` + `donor_project_assignments`. Projeto padrão "Demandas de Moradia" com todos os módulos ligados; todo doador existente (inclusive inativo, que carrega histórico) ganha vínculo aberto desde sempre.
- **DuckDB não suporta índice único parcial** — verificado contra o build real: `CREATE UNIQUE INDEX ... WHERE valid_to IS NULL` falha. Por isso a vigência usa **datas-sentinela** (`1900-01-01` / `9999-12-01`) em vez de NULL: o invariante "um vínculo aberto por doador" passa a ser garantido por um índice comum em `(donor_id, valid_to)`, e a consulta por vigência vira `BETWEEN` sem ramo de NULL. As sentinelas são traduzidas para null no mapper.
- **A junção é pelo mês da NOTA**, nunca pela data da importação — planilha atrasada precisa cair no projeto vigente à época.
- **`LEFT JOIN` de propósito** em `CREDIT_BY_PROJECT_SQL`: crédito de doador sem vínculo precisa aparecer como "não atribuído". Com INNER, esse dinheiro sumiria da soma em silêncio.
- **Invariante central**: `Σ(por projeto) + Σ(não atribuído) = Σ(conciliado)`. 8 testes de integração em `tests/projectAssignments.test.js`.
- Restore de backup reexecuta `ENSURE_DEFAULT_PROJECT_SQL` + `BACKFILL_ASSIGNMENTS_SQL` — um arquivo anterior à v12 apaga projetos e vínculos sem repor.
- e2e `project-assignments.spec.js` exporta o backup pelo navegador para provar que o vínculo é criado no runtime real (passar nos outros testes só provaria que nada quebrou).

### Fase 2 — O projeto vira ambiente (commits 233-235)

- **Migration v13**: `demands.project_id` (caminho B). `uq_demands_name` global virou `uq_demands_project_name` — sem isso, dois projetos não poderiam ter uma demanda com o mesmo nome. `demandService` filtra/grava/checa duplicidade por projeto, e o **cache key inclui o projeto** (sem isso, trocar de projeto serviria a lista anterior).
- **Rotas**: `/` = escolha de projeto + painel; `/p/:slug/…` = ambiente do projeto; `/importacoes` fora de qualquer projeto. `LegacyProjectRedirect` mantém favoritos e links antigos funcionando.
- **`activeProject.js`** — holder do projeto ativo, padrão do `setActiveCloudUser`. A alternativa (passar `projectId` em centenas de chamadas) teria uma superfície de erro muito maior.
- **`ProjectProvider` fica ACIMA do Layout**: a barra lateral precisa do projeto tanto quanto as páginas. Sincroniza o holder **durante o render**, não em efeito — efeito roda depois da primeira pintura, e as páginas já teriam consultado com o projeto anterior.
- **Barra lateral com três blocos rotulados**: "Neste projeto" / "Plataforma" / conta. O rótulo "Plataforma" é o que impede a leitura de que Importações pertence ao projeto aberto.

**Cinco bugs reais encontrados (todos pelos testes, não por inspeção):**
1. Lateral não via o projeto — contexto estava dentro das rotas, abaixo do Layout.
2. Tela presa em "Abrindo projeto" ao ir para Configurações — o gate continua montado durante a animação de saída e comparava com o projeto ativo (já nulo). Passou a comparar com o projeto do **próprio slug**.
3. Sair do projeto apagava a navegação dele — usuário sem caminho de volta em Importações.
4. Memória do projeto se perdia em dois cenários: `useState` some no remount do restore de backup; e guardar o **id** falha se o usuário sai de `/p/:slug` antes de a lista carregar. A correção guarda o **slug**, que vem da URL e existe no primeiro render.
5. Restore com instruções de reparo FORA da transaction: `execute` emite evento de mudança, e as páginas consultavam um banco em estado intermediário. Falhava 2 de 3 rodadas.

**Código morto encontrado**: contador da lixeira era calculado e nunca exibido (`FooterNavItem` não tinha badge) — religado. `getNavigationItem` tinha zero consumidores — removido.

**Estado:** 161 testes, 24 e2e, lint 0, build OK. Fases 3 (segundo projeto utilizável) e 4 (reinvestimento) pendentes.

## Auditoria de consistência — itens 7 a 11 (commits 261-263)

Cinco itens de uma auditoria anterior. **Dois não sobreviveram à remedição**: paddings (7) e espaçamentos (8) pareciam divergentes num `grep` cru, mas por papel do container formam uma escala coerente — `p-3` linha compacta, `p-4` bloco aninhado, `p-5` card (via `SectionCard`/`MetricCard`), `p-6` painel de tela cheia. Nada mudado. O item 11 (~32 estados vazios à mão) estava muito inflado: quase tudo já passa por `EmptyState` ou `DetailList`; os reais eram 3.

- **Zona morta de breakpoint** (commit 261): 6 grades iam de `md:grid-cols-2` direto para `xl:`, ficando em 2 colunas até 1279px. Medido no navegador antes e depois.
- **Bug maior encontrado ao medir**: a escada de tamanho do `MetricValue` AUMENTAVA a fonte no `lg` — exatamente onde a grade ganha coluna e o card encolhe. Card com 156px úteis a 1024px e 167px a 1280px, contra 169px que "R$ 70,00" pede a 40px. **Já estourava em 1280 antes da minha mudança.** O degrau maior passou para `2xl`. `e2e/metric-card-fit.spec.js` MEDE em vez de inspecionar classe — a falha nasce da relação entre a largura que a grade concede e o tamanho que a escada escolhe, e nenhum lado sozinho a denuncia. Verificado que falha com o bug reintroduzido.
- **`DataTable`** (commit 262): 3 tabelas idênticas caractere por caractere viraram um primitivo. A divergência já tinha custado: a quarta tabela (pré-visualização de planilha) usava `border-[rgba(255,255,255,0.05)]` fixo — branco a 5% sobre `#ffffff`, ou seja, **sem nenhuma separação de linhas no tema claro**. Mesmo padrão no seletor de cor das anotações. Os dois agora usam token. A tabela de pré-visualização NÃO foi unificada de propósito: o cabeçalho dela é dado (nomes das colunas do arquivo do usuário) e o versalete do `DataTable` mostraria um nome diferente do que está no arquivo.

## Evolução da plataforma — 6 frentes (commits 264-267)

### Sincronização sem travar (commit 264)

Medido antes de mexer: exportar 60 mil linhas dava **552ms de thread principal travada**, em um bloco, a cada gravação (a nuvem regrava o snapshot inteiro a cada 2s de atividade). A causa não era o que parecia — as 16 consultas sequenciais não bloqueiam, quem bloqueia é `JSON.stringify` sobre o resultado materializado.

- O snapshot passou a ser serializado pelo **próprio DuckDB** (`json_group_array`), dentro do worker. **552ms → 0ms** de bloqueio, mesma medição.
- Fidelidade verificada campo a campo contra `JSON.stringify` — acento, aspas, barra, nulo, booleano, BIGINT e tabela vazia. Única diferença é textual (`2.0` vs `2`) e some no parse.
- `snapshotSources.js` isola o SQL (módulo puro) para o teste rodar a consulta real. `e2e/backup-roundtrip.spec.js` prova que o arquivo gerado volta pelo importador — comparando o que o arquivo DECLARA conter com o que é restaurado, porque o restore deriva resumos mensais e grava histórico, então comparar com a fixture original falharia por motivo legítimo.
- Duplicata removida: `bigintToNumberReplacer` existia em dois arquivos, com um comentário admitindo a cópia.
- Medida a contenção do worker (427ms livre × 479ms ocupado): desprezível, ao contrário do que eu supunha.

### Descoberta do início das doações (commit 265)

- `donationStartSql.js`: primeiro mês de um CPF, e preenchimento em massa. Ignora importação com `status='error'` e linha só com nota inválida — sem esses filtros, uma importação que falhou viraria data de início.
- `useDonationStartDiscovery`: busca ao digitar o CPF no cadastro. Preenche uma vez por CPF (apagar não faz voltar), nunca sobrescreve, descarta resposta atrasada. Estado DERIVADO do CPF atual, não zerado por efeito.
- Ao fim de cada importação, `backfillDonationStartDates` preenche quem ficou sem data. Roda sobre todos os nulos, não só sobre os CPFs da planilha nova: mesmo resultado no caso alvo e ainda recupera quem ficou para trás.

### Histórico do doador e estabelecimentos (commit 266)

- `credit_notes.emitente` é a ÚNICA fonte do nome do estabelecimento; a compra vem de `donation_notes`. A ligação é `credit_reconciliation`. O nome é resolvido por CNPJ (`mode()` para a grafia mais comum), não nota a nota, para a compra ter nome mesmo antes de o crédito dela chegar.
- Ranking ordenado por CRÉDITO, não por número de compras — a rede mais frequentada costuma não ser a que mais rende, e essa diferença é o ponto. Participação sai por função de janela na mesma consulta, senão dois números que precisam somar 100% viriam de varreduras diferentes.
- Recorte por projeto usa o vínculo VIGENTE NO MÊS DA NOTA. Contagem parte da compra e não do crédito: só a compra carrega o CPF.
- **Exceção do Moradia sai de graça**: `Dashboard.jsx` já escolhe o painel por `modules.monthly`, e a seção só entra no painel de crédito e no da plataforma.
- **Bug antigo revelado**: `formatDatePtBR` passava data sem hora por `new Date("2026-03-01")`, lido como meia-noite UTC — em UTC-3 voltava um dia e a nota de março aparecia como 28/02. Ficou latente porque todo uso anterior passava data COM hora, que é lida como local.
- Armadilha de teste registrada: a tabela acessível `sr-only` do gráfico responde a `tbody tr`. Mirar a tabela pelo NOME ACESSÍVEL (a legenda).

### Anotações da plataforma (commit 267)

- As do projeto continuam como estavam; o que nasceu é um espaço acima delas. Mesma tela, escopo diferente: `project_id` recebe `PLATFORM_NOTES_SCOPE`, um valor que nenhum projeto pode ter — assim a listagem continua uma igualdade simples, sem ramo de NULL.
- Rota `/plataforma/anotacoes`, e não `/anotacoes`: esse caminho redireciona favoritos anteriores ao multiprojeto para as anotações do PROJETO.
- Item de menu chamado **"Anotações gerais"**: dentro de um projeto os dois blocos aparecem juntos, e dois itens com o mesmo nome só se distinguiriam pelo cabeçalho acima deles.
- Busca por texto em título e conteúdo, sem acento e com as tags do editor removidas. Vazio de busca distinto do vazio de lista.

## Inteligência sobre notas fiscais (commits 269-270)

BI sobre a nota individual, em dois níveis: painel da plataforma (todos os projetos e doadores) e perfil do doador.

**O que NÃO existe**: cidade e estado. Nenhuma das duas planilhas traz essas colunas e nenhum dos dois pipelines as captura — filtrar por elas exigiria antes que o arquivo de origem passasse a informá-las.

**Base única** (`services/notes/noteAnalyticsSql.js`, módulo puro): `note_base` resolve doador, projeto (pelo vínculo vigente NO MÊS DA NOTA), estabelecimento e crédito de uma vez. Listagem, contagem, indicadores, faixas e ranking partem dela — bases separadas por pergunta fariam os números da mesma tela discordarem quando um filtro fosse aplicado num lugar e esquecido em outro.

- `donor_by_cpf` e `credit_by_note` são CTEs AGREGADAS, não JOINs diretos: um pareamento duplicado multiplicaria a nota e inflaria toda soma da tela sem sinal nenhum. Teste trava a contagem.
- `retorno` = crédito / valor, calculado na base e não em cada consumidor.
- Ordenação por lista fechada (`NOTE_SORT_COLUMNS`) porque o DuckDB não aceita `?` em `ORDER BY`; valor fora da lista cai no padrão. Teste tenta `'; DROP TABLE ...`.
- **Faixas de valor com limites meio-abertos** ([mín, máx)). Os rótulos originais diziam "Até R$ 50" para a faixa que EXCLUI R$ 50 — o e2e pegou. Agora "Menos de R$ 50" / "R$ 50 a R$ 100", com o limite pertencendo à faixa que começa nele.
- **"Compras excepcionais"** = decil superior de crédito do recorte (`quantile_cont(credito, 0.9)`), não um valor fixo em reais que envelheceria. É pergunta diferente do ranking geral: no teste, o MERCADO domina o crédito total por volume e NÃO aparece entre as excepcionais.
- Período aceita mês ou data completa; o fim do período abre para o último dia do mês (fevereiro bissexto conferido em teste).

**Componente único para as duas telas** (`features/notesAnalytics/`): `NoteAnalyticsExplorer` com `lockedFilters` (contexto da página, entra por cima do que o usuário escolhe e some da barra), `hiddenFilters`, `hiddenColumns` e `showSummary`. O perfil do doador PERDEU a tabela própria — `listDonorDonations`/`countDonorDonations` e o SQL delas foram removidos.

**Bug real corrigido durante o trabalho**: `handleSort` chamava `setDirection` dentro do updater de `setSort`. Updater precisa ser puro; no React 19 ele roda duas vezes e a inversão acontecia duas vezes, voltando ao sentido original — clicar duas vezes na mesma coluna não invertia nada. Virou um estado único `{sort, direction}`. Pego pelo e2e, não por inspeção.

**Armadilhas de escrita registradas**: escrever arquivo por script de patch comeu backslash de regex três vezes (`/d/` → `/d/`) e uma vez transformou `" "` em byte NUL. Mitigação: `String.fromCharCode(92)` para o backslash, e conferir com `grep` depois de escrever.

## Planilha de abatimento no formato do sistema de baixa (commits 272-273)

O usuário anexou `base_extrato.xlsx`, o gabarito que o sistema de abatimento importa, e pediu que a planilha saísse exatamente assim. Saiu de CSV para **.xlsx**.

O modelo NÃO é uma tabela simples: três parâmetros no topo (`AGENCA 0`, `CONTA 0`, `COD. BANCO NFP2607`), nota mesclada em D1:E3, duas linhas em branco, e só na **linha 6** o cabeçalho `DATA | VALOR | DESCRIÇÃO | NOME | CPF`. Errar qualquer posição faz o destino ler tudo deslocado.

- **Demanda saiu de coluna e virou nome de arquivo** — não existe coluna para ela no modelo. A divisão por demanda (um arquivo por demanda, zip quando há mais de uma) continua.
- **A DATA é o último dia do TERCEIRO mês após a competência** (abril → 31/07, maio → 31/08; regra dada pelo usuário). Derivada da competência e não do dia da geração: a chave única do destino é (Agencia, Conta, Cod. Banco, Data, Valor, Nome), então reexportar o mesmo mês tem de produzir a mesma chave. Os dois exemplos dados caem em meses de 31 dias e não distinguem "último dia" de "dia 31" — os testes travam janeiro→30/04 e novembro→28 ou 29/02.
- **Marcador SHA-1 escondido** na coluna 235 da linha 3 do modelo. Não deriva de nada óbvio e o gabarito não tem linha de dado, então não é soma de verificação. Reproduzido literalmente: remover custaria uma falha de importação sem explicação.
- **Bordas e moeda vieram numa segunda rodada** (commit 273): o gabarito é VAZIO, então não havia linha de dado para copiar e a primeira versão saiu sem borda e sem formato. `[$R$-416]` fixa o pt-BR — sem isso os separadores seguem a máquina de quem abre (renderizado num ambiente de locale inglês para confirmar).
- O teste compara o gerado **contra o arquivo do usuário**, célula a célula; o e2e baixa pelo app e reabre.

## Painel de Moradia: mês selecionável e reestruturação (commits 274-275)

- **Seletor de mês** no cabeçalho. Recorta SÓ o bloco de apuração — cadastro, inconsistência e totais do projeto não pertencem a competência nenhuma. Dois cuidados: o aviso de atraso passou a olhar o mês MAIS RECENTE (antes lia o exibido, e abrir janeiro acusaria atraso falso), e o "mês anterior" da comparação é o vizinho na lista de importações, não o do calendário (março não importado ⇒ o anterior a abril é fevereiro). Removido um `LIMIT 6` que teria limitado o seletor a seis meses.
- `latestMonth` virou `month` no payload e nos consumidores: com o mês selecionável, o nome mentia. `newestMonth` é o novo campo para o aviso de atraso.
- **Conteúdo novo**: progresso do abatimento como barra (era dois números soltos em cartões separados), variação contra o mês anterior, taxa de participação e estreias no mês. A quebra por demanda saiu de um modal e virou tabela visível; o modal "último mês importado" foi removido por repetir o que a página passou a mostrar.
- **Ocultar valores** (`useHiddenValues`): botão nos três painéis, começa OCULTO e lembra a escolha. A loja fica fora do React com `useSyncExternalStore` — é preferência de usuário, como o tema, e um contexto exigiria provedor em cada painel.
- O mascaramento é uma regra de CSS ancorada em `[data-values-hidden]`, não uma condição por componente: `.numeric` já marcava todo número. Primeira versão usava desfoque; o usuário pediu bolinhas, e `-webkit-text-security: disc` faz isso por caractere. O desfoque ficou como retaguarda em `@supports` — cair para texto legível seria falha de privacidade silenciosa.
- `TextWithValues` mascara só os NÚMEROS das frases de apoio. Cobrir a frase inteira virava uma fileira de pontinhos e o cartão perdia o significado junto com o valor. Usa a posição do `split` com grupo de captura, e não `test()` com regex global — `test` avança `lastIndex` e erraria do segundo número em diante.

## Auditoria da plataforma + roadmap derivado (commits 279-287)

Usuário pediu auditoria completa de 17 áreas e, na sequência, um roadmap do que valia melhorar. Os dois documentos foram publicados como artifacts. Auditoria: 9 achados (1 crítico, 2 altos, 4 médios, 2 baixos), tudo medido contra o sistema rodando. Roadmap: 5 fases, executadas do início ao fim.

**Duas correções que o roadmap fez na própria auditoria** (achadas ao medir, não ao ler código):
- A lentidão da Gestão Mensal não era "paginar a tela". Era que `listDonorMonthReconciliationStatuses()` e `getDonorInactivityStreakMap()` **não aceitavam parâmetro nenhum** — varriam todo o histórico e montavam um Map de (doadores × meses) na thread principal a cada abertura, com o usuário olhando um mês só.
- "Paginar Demandas e Projetos" caiu: essas listas não crescem com o tempo (Projetos carrega um punhado de linhas e uma contagem; Demandas é limitada pelo que a organização cadastra). Era cerimônia.

### Fase 1 — Limpeza (commit 279)

15 funções exportadas sem consumidor, removidas. Verificado por varredura antes de apagar: cada uma declarada uma vez e mencionada em lugar nenhum (nem em teste). Dois casos precisaram de decisão:
- `checkCreditAttributionIdentity` / `listOverlappingAssignments`: os SQL delas (`CREDIT_ATTRIBUTION_IDENTITY_SQL`, `OVERLAPPING_ASSIGNMENTS_SQL`) **são consumidos direto pelos testes de integração**. Só os invólucros estavam órfãos; o invariante central continua coberto.
- `listOrphanedCredits` / `listOrphanedDonations`: a auditoria tinha marcado como "talvez valha expor em vez de apagar". Fui verificar — o Dashboard **já mostra** `creditOnly`/`donationOnly` na seção de conciliação. Respondiam pergunta que já está na tela.

### Fase 2 — O ganho medido (commit 280)

`listDonorMonthReconciliationStatuses({ referenceMonth })` recorta os **dois** lados (crédito e abatimento) no mesmo mês. Recortar só um compararia um mês contra o abatimento de todos os meses e a coluna "Saldo" mostraria diferença que nunca existiu — há teste dedicado para isso.

Medido contra DuckDB real, 400 doadores × 24 meses (115.200 notas):

| Escopo | Linhas | Consulta | Map | Total |
|---|---|---|---|---|
| Todo o histórico (antes) | 9.600 | 80 ms | 57 ms | **137 ms** |
| Só o mês exibido | 400 | 21 ms | 2 ms | **23 ms** |

Seis vezes mais rápido, e o custo para de crescer com o acervo (linhas = doadores × meses). SQL extraído para `reconciliation/donorMonthStatusSql.js` (módulo puro) para o teste rodar a consulta de produção. Inatividade: **não** é recortada por mês (a métrica é estado atual) — passou a só ser carregada quando a visão pode exibir o emblema, e a leitura devolve mapa vazio nos demais meses em vez de zerar o estado.

3 testes novos, verificados por reintrodução do bug: falham com o recorte quebrado.

### Fase 3 — Autosave de anotações (commit 281)

`e2e/notes-autosave.spec.js`, 4 testes. Era o único ponto do sistema que pode perder trabalho digitado à mão sem deixar rastro. Cobre os dois lados da janela de 800ms (`AUTO_SAVE_DELAY_MS`): fechar antes (exercita o flush no fechamento) e esperar (exercita o temporizador), mais reabrir nota intocada e editar existente. Verificado por reintrodução: 3 dos 4 falham com o flush removido.

Armadilha registrada: o card de anotação **não abre pelo texto** — tem botão "Editar" próprio.

### Fase 4 — SQL e arquivos grandes (commits 282-285, 287)

**`escapeSqlString` deixou de existir no projeto** (era 13 arquivos). Conversões que mudaram o risco de verdade:
- `importQueries.listImports`: o filtro por nome de arquivo é o único com texto livre do usuário. Curingas ficam **fora** do parâmetro (`LIKE '%' || ? || '%'`) — dentro seriam comparados como caractere literal.
- `trashService.insertRows` e `backup.js`: os valores vêm de arquivo de backup enviado pelo usuário, a entrada menos confiável que chega ao banco. Bulk insert virou tuplas de `?` com params achatados. **Limite de bind medido antes**: 50.000 parâmetros passam no DuckDB, e o maior bloco usa 7.500 — cabe com folga.
- **`buildRegisteredFileName(nanoid())`**: descoberta de que `registeredFileName` era nanoid + `file.name` — ou seja, o nome que o **usuário** deu ao arquivo ia parar dentro de `read_csv_auto('...')`, onde o DuckDB não aceita parâmetro. Em vez de escapar, o nome passou a ser só `[A-Za-z0-9_-].csv`. Nada se perde: é identificador interno, o nome real vive em `imports.file_name`. O comentário antigo do CLAUDE.md que dizia "fileName é gerado internamente" estava **errado**.
- `buildInvalidStatusExpression`: padrões são lista fixa no código; ganhou checagem que **falha alto** se alguém acrescentar um com aspa.

**Splits** (todos por barril, zero consumidor alterado):
- `creditReconciliationService` 1.046 → 29 (motor / stats / por-doador / diagnóstico / listagens + helpers).
- `importPipeline` 1.237 → 23 (`donationSpreadsheet` / `importRecords` / `importProcess` / `importDelete` / `importReimport`).
- `Monthly.jsx` 995 → 798, via `useMonthlyExports` (os 5 exportadores não compartilham nada com o resto da página).
- `registerSpreadsheetPreviewFile` era **idêntica byte a byte** nos dois pipelines (42 linhas). Consolidada em `import/spreadsheetSource.js`.

**`Donors.jsx` (863) NÃO foi dividido, de propósito.** Os handlers já são finos (10 linhas cada, porque `useMutationAction` faz o trabalho), o estado é plano e as abstrações já estão aplicadas. As linhas são 5 modais + CRUD completo, não emaranhado. Extrair `DonorModals` daria um componente com ~25 props — moveria a complexidade em vez de reduzi-la. `migrations.js` (1.160) também fica: cresce por acréscimo e nunca é lido de ponta a ponta.

**Efeito colateral que virou correção real:** ao encolher `Monthly.jsx`, o analisador do `react-hooks` passou a conseguir processá-lo e apontou 4 violações de `set-state-in-effect` que **já existiam** e eram invisíveis só porque o arquivo era grande demais. Três foram corrigidas de verdade, com ganho de comportamento:
- Sobreposição otimista e limpeza de seleção viraram **ajuste durante o render** (padrão documentado do React). Em efeito, existia um quadro em que o palpite antigo aparecia sobre os dados novos, e a barra de ações em massa dizia "3 selecionados" sobre outra lista.
- A âncora automática de mês trocou o `useRef` por **estado**, mantendo a semântica de uma vez só (que o e2e depende).
- A quarta é falso positivo e ficou com `eslint-disable` justificado: as três funções são `async` e só escrevem estado **depois do `await`** — verificado uma a uma.

### Fase 5 — Um item feito, dois adiados com gatilho (commit 286)

**Feito: teste de reimportação** (`e2e/import-reimport.spec.js`, 3 testes). Era o maior buraco de cobertura do sistema — `applyReimport` **apaga** as notas do mês e reescreve a partir do arquivo novo, com zero teste ponta a ponta. A fixture nova difere da original em **três eixos ao mesmo tempo** (mais notas válidas, CPF novo, status corrigido); num eixo só, uma reimportação que ignorasse os outros dois passaria. Verificado por reintrodução: neutralizar o DELETE faz o teste "substitui em vez de somar" falhar.

Isso satisfez o portão do item "unificar pipelines de importação" — e a unificação, medida, resultou nas 42 linhas idênticas já consolidadas (o resto dos dois pipelines difere de verdade: tabelas, colunas, validação e encadeamento de conciliação).

**Adiados, com o número que os reabre** (usuário confirmou):
- **Sincronização incremental por tabela** — dispara quando o snapshot comprimido passar de **5 MB** (hoje ≈ 0,34 MB com 1 ano de uso). Cada gravação ainda reescreve o banco inteiro; enquanto o arquivo for pequeno, a complexidade não se paga.
- **Paginação server-side da Gestão Mensal** — dispara acima de **5.000 linhas num único mês**. A Fase 2 já removeu o custo que crescia sozinho; o que sobra é a lista em si, e adotá-la exige rework da página mais complexa do sistema.

**Estado ao fim:** 222 testes unitários/integração, 80 e2e, lint 0 erros, build OK.

## Transferência com demanda e planilha dos pendentes (commit 295)

Quatro pedidos. Dois bugs reais reproduzidos em e2e antes de corrigir, e uma regressão minha do commit 280.

- **Doador transferido não aparecia na Gestão Mensal do destino** — duas causas somadas:
  1. O mês padrão do modal era o do calendário. A planilha da NFP chega meses depois, então o mês corrente quase nunca tem nota: a transferência passava e nenhuma doação mudava de projeto. A sugestão agora é o primeiro mês com doação dentro do vínculo atual (`listDonorDonationMonths`, sobre `import_cpf_summary` de importações processadas), sempre posterior ao início do vínculo (o serviço recusa o contrário). O modal diz, antes de confirmar, o que passa e o que fica ("Passam para X: 2 meses com doação (Mar/2026 e Abr/2026).").
  2. A Gestão Mensal lê a demanda da CÓPIA gravada em `monthly_donor_summary` na reconciliação, não da ficha. Mesmo acertando o mês, o doador aparecia como "Demanda: Não informada". A transferência agora reconcilia os CPFs do doador depois de gravar a demanda.
- **Demanda obrigatória ao transferir para projeto com demandas**: `resolveDestinationDemand` exige demanda ativa DO DESTINO quando `modules.demands !== false` e grava `donors.demand` na mesma transação. Destino sem demandas mantém a demanda como está — os meses que ficam no projeto de origem ainda a exibem. Vale nos dois caminhos do modal: transferência e vínculo de quem não tem vínculo (novo `assignUnlinkedDonorToProject`; `assignDonorToProject` segue sendo o do cadastro, que roda dentro da transação do `createDonor`). `listProjectDemands(projectId)` existe porque `listDemands` é sempre do projeto ativo, e o destino por definição não é. Destino sem demanda cadastrada bloqueia o botão com instrução. O card de órfãos da tela de Projetos (`linkDonorToProject`) não mudou.
- **Bug latente nas opções de transação**: a transferência passava `{ source, domains }` para `runInTransaction`, que lê `{ changeSource, changeDomains }`. As opções eram ignoradas em silêncio e o evento saía como `"transaction"`, sem domínio.
- **Planilha dos pendentes**: sem mês selecionado, o botão vira "Planilha dos pendentes" e gera uma linha por CPF com todos os meses pendentes somados (VALOR = soma das notas).
  - Regra de pendente = a do contador da visão por mês: `pending`, com nota, e nenhum acumulado de OUTRO mês cobrindo. Sem a exclusão do acumulado o destino abateria a mesma doação duas vezes — verificado por mutação (o teste falha com a cláusula removida).
  - O status é por doador e a linha é por CPF: o casamento é `monthly_donor_summary.donor_id = donors.id` (dono do vínculo de CPF) no mesmo mês.
  - Descrição por `formatMonthsSpan` (em `utils/date.js`). Cada trecho vira "Mar/2026" (um mês), "Jan/2026 e Fev/2026" (dois meses vizinhos) ou "Jan/2026 até Mar/2026" (primeiro e último com mês entre eles), e trechos são ligados por ponto e vírgula: "Jan/2026 até Mar/2026; Mai/2026 e Jun/2026" (regra de trechos do usuário, commit 296).
  - **Na planilha dos pendentes, só um mês COM doação que ficou de fora parte o trecho** (abatido antes, coberto por acumulado, de outro projeto). Mês sem doação no meio é atravessado pelo "até". Correção do usuário no commit 298: o commit 296 partia em qualquer mês que faltasse, e isso faria o doador perguntar por que um mês sem doação "não foi abatido". A consulta devolve `donation_months` (todo mês com nota válida do CPF, em importação processada, qualquer status e projeto), `buildAbatementDescription({ donationMonths })` calcula os meses que partem e passa como `breakMonths`. Sem `breakMonths`, `formatMonthsSpan` parte em qualquer mês que falte — é o modo da transferência, que descreve meses com doação ao pé da letra. `parseMonthList` é compartilhado entre o serviço e o teste de integração.
  - Virada de ano conta como seguida — comparação por índice absoluto de mês.
  - DATA sai do mês mais recente DE CADA LINHA (`row.referenceMonth`, lido pelo workbook), não de um mês do arquivo: dois CPFs da mesma planilha podem ter conjuntos diferentes. Arquivo com sufixo `-pendentes`, um por demanda.
  - Colunas, junções e agrupamento viraram constantes compartilhadas com a planilha do mês em `abatementSheetSql.js` — duas cópias da identidade do titular divergiriam na primeira correção.
  - Exportar não marca nada como realizado, igual à planilha do mês.
- **JPEG sem "Valor abatido"**: não reproduzido. PDF e JPEG usam o mesmo `drawDonationReport`, e o JPEG gerado pelo app mostra a coluna — o provável é versão antiga em cache no navegador.
- **Regressão do commit 280**: `buildDonorMonthStatusQuery` recortava com `slice(0, 10)`, e escolher o mês no campo manda `2026-03`, sem dia — o `CAST(? AS DATE)` falhava e crédito real/saldo paravam de atualizar sem aviso. `toFirstDayOfMonth` + teste que falha com o recorte antigo.
- **Fixture `project-credit-backup.json`**: ganhou a demanda de Moradia e o `importCpfSummary`, que estava vazio. O restore NÃO deriva essa tabela das notas — sem ela não há resumo mensal nem mês com doação para sugerir.
- Armadilha de e2e: ao trocar de mês na Gestão Mensal, a linha do mês anterior do mesmo doador coexiste por um instante com a do novo, e `toBeVisible` num botão pelo nome dá violação de modo estrito. Esperar `toHaveCount(1)` — que também pega resumo duplicado.
- 249 testes (14 novos), 90 e2e (3 novos), lint 0 erros, build OK. Na rodada completa 7 e2e de outras áreas estouraram tempo — lint e build rodavam em paralelo na mesma máquina —, e os 7 passaram rodados de novo sem essa carga. Não rodar lint/build junto da suíte e2e.

## Desabater em massa (commit 297)

- Botão "Desabater em massa" ao lado de "Abater em massa". Abre o mesmo modal por mês, agora parametrizado por `status` — o status que ele GRAVA. No sentido de desabater lista os meses com abatimento realizado, em tom âmbar (o mesmo de "Pendente" no seletor de cada linha), e confirma com botão vermelho.
- Nenhuma mudança no serviço: `updateAbatementStatuses` já aceitava `pending` em massa, com a cascata para o acumulado do mês e a recusa das linhas "Via acumulado". O handler virou `handleBulkStatusChange(ids, status)`; `handleBulkAbate` e `handleBulkUnabate` são os dois sentidos.
- A barra de seleção por linha ganhou "Desabater N realizado(s)". Antes, selecionar só linhas realizadas era beco sem saída: botão desabilitado e "nenhuma pendente".
- "Desfazer" nas operações em massa, nos dois sentidos (o abatimento em massa não tinha). Restaura o status, não a data em que o abatimento tinha sido marcado — desabater apaga essa data, igual ao desfazer de uma linha.
- Estado da página: `bulkModalStatus` ("" | "applied" | "pending") no lugar do booleano do modal, e `bulkStatusInProgress` no lugar de `isBulkAbating` — com um booleano só, "Abatendo..." apareceria no botão de desabater. O modal recebe `key={bulkModalStatus}` para os meses marcados num sentido não vazarem para o outro.
- e2e `monthly-bulk-unabate.spec.js` (2 testes): abate março em massa, desabate e confere pelo ESTADO (modal de desabater vazio, março de volta no de abater), não só pela mensagem; e o "Desfazer".
- Armadilhas de e2e: a busca de papel por nome é por TRECHO — "Abater em massa" casa com "Desabater em massa" e "Abatimento em massa" com "Desabatimento em massa"; usar `exact: true`. O `Modal` tem dois "Fechar" (o X do cabeçalho e o botão do rodapé). Com um mês selecionado, a lista (e o modal em massa) só tem linhas daquele mês.
- 250 testes, 92 e2e (2 novos, suíte completa rodada sozinha), lint 0 erros, build OK.

## Convenções do projeto

- Cada commit é numerado sequencialmente (`commit 56`, `commit 57`, ...). Estamos em **commit 298**.
- Co-authored-by: `Claude Sonnet 4.6 <noreply@anthropic.com>` em todos os commits.
- Mensagens de commit são curtas (`commit N`) — o conteúdo vai no diff.
- Prefer `Edit` ao invés de `Write` para arquivos existentes.
- Não criar arquivos `.md` sem o usuário pedir explicitamente (o usuário pediu este).
- Nada de emojis em código a menos que pedido.

## Decisões já tomadas

- Filtros de Donors/People/Demands usam `SelectInput` searchable com match exato, igual a Monthly. Filtros que neutralizam o próprio campo nas opções: `donorId`, `cpf`, `demand` (paralelos a Monthly).
- Validação cronológica de ativação/desativação no servidor (`donorService`) e no cliente (modais com erro reativo).
- "CPFs encontrados" usa paginação default de 5 por página.
- Constantes shared em `features/donors/constants.js` (a mover para `src/constants/` na Fase 2).

## Itens explicitamente NÃO fazer agora

- TypeScript de uma vez só (P8) — incremental quando.
- Trocar DuckDB-WASM (lock-in aceito).
- Adicionar Docker / PostgreSQL / backend (Fase 5, escopo separado).
- Mexer no `chunkSizeWarningLimit` (P5).
- Padronizar subtitles de PageHeader (P4 — cosmético).
- Remover debounce dos filtros que viraram select (P1 — custo zero deixar).
