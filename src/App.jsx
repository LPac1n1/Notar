import AppRoutes from "./routes/AppRoutes";
import GlobalAsyncFeedback from "./components/ui/GlobalAsyncFeedback";
import LoadingScreen from "./components/ui/LoadingScreen";
import ErrorState from "./components/ui/ErrorState";
import ErrorBoundary from "./components/ui/ErrorBoundary";
import SignInPanel from "./components/auth/SignInPanel";
import RemoteConflictBanner from "./components/sync/RemoteConflictBanner";
import { useAuth } from "./hooks/useAuth";
import { useCloudSync } from "./hooks/useCloudSync";

const HYDRATION_STEP_LABELS = {
  db: "Inicializando banco de dados…",
  download: "Baixando seus dados da nuvem…",
  restore: "Carregando dados no banco…",
};

const RESTORE_TABLE_LABELS = {
  projects: "projetos",
  donor_project_assignments: "vínculos de projeto",
  demands: "demandas",
  people: "pessoas",
  donors: "doadores",
  donor_cpf_links: "vínculos de CPF",
  imports: "importações de doações",
  donation_notes: "notas de doação",
  import_cpf_summary: "resumo de CPFs por importação",
  monthly_donor_summary: "resumo mensal por doador",
  notes: "anotações",
  action_history: "histórico de ações",
  donor_activity_history: "histórico de atividade dos doadores",
  abatement_adjustments: "ajustes de abatimento",
  credit_imports: "importações de crédito",
  credit_notes: "notas de crédito",
  credit_reconciliation: "conciliação de créditos",
  trash_items: "lixeira",
};

const ROW_FORMATTER = new Intl.NumberFormat("pt-BR");

function formatProgressDescription(step) {
  if (!step) return "Preparando o Notar…";
  const baseLabel = HYDRATION_STEP_LABELS[step.step] ?? "Preparando o Notar…";

  // Depois da última linha restaurada a conciliação é refeita a partir das
  // notas. Sem um rótulo próprio a tela ficaria parada em "Restaurando …
  // (N de N linhas)", que parece travamento.
  if (step.phase === "reconcile") {
    return "Refazendo a conciliação de créditos…";
  }

  // O banco chega em vários arquivos: mostrar quantos já vieram evita a
  // impressão de tela parada numa conexão lenta.
  if (step.step === "download" && step.totalParts) {
    return `Baixando seus dados da nuvem (${step.downloadedParts ?? 0} de ${step.totalParts} arquivos)…`;
  }

  if (step.step !== "restore" || !step.totalRows) {
    return baseLabel;
  }

  const friendlyTable = step.currentTable
    ? (RESTORE_TABLE_LABELS[step.currentTable] ?? step.currentTable)
    : null;
  const restored = ROW_FORMATTER.format(step.restoredRows ?? 0);
  const total = ROW_FORMATTER.format(step.totalRows);

  if (friendlyTable) {
    return `Restaurando ${friendlyTable} (${restored} de ${total} linhas)…`;
  }
  return `Restaurando dados (${restored} de ${total} linhas)…`;
}

function HydrationProgressBar({ step }) {
  if (
    !step ||
    step.step !== "restore" ||
    typeof step.totalRows !== "number" ||
    step.totalRows <= 0
  ) {
    return null;
  }

  const restored = Math.max(0, Math.min(step.restoredRows ?? 0, step.totalRows));
  const percent = Math.round((restored / step.totalRows) * 100);

  return (
    <div className="mt-4 w-full max-w-md">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Progresso da restauração"
        className="h-2 w-full overflow-hidden rounded-full bg-[color:var(--surface-muted)]"
      >
        <div
          className="h-full rounded-full bg-[color:var(--accent-strong)] transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-[var(--muted)]">
        <span>{percent}%</span>
        <span>
          {ROW_FORMATTER.format(restored)} / {ROW_FORMATTER.format(step.totalRows)}
        </span>
      </div>
    </div>
  );
}

function CloudSyncGate() {
  const { hydrationStatus, hydrationStep, hydrationError } = useCloudSync();
  const { signOut } = useAuth();

  if (hydrationStatus === "ready") {
    return (
      <ErrorBoundary>
        <>
          <AppRoutes />
          <GlobalAsyncFeedback />
          <RemoteConflictBanner />
        </>
      </ErrorBoundary>
    );
  }

  if (hydrationStatus === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--surface)] p-6">
        <div className="w-full max-w-md">
          <ErrorState
            title="Não foi possível carregar seus dados"
            description={
              hydrationError?.message ||
              "Não conseguimos baixar o snapshot mais recente da nuvem."
            }
            actionLabel="Tentar novamente"
            onAction={() => window.location.reload()}
            secondaryActionLabel="Sair desta conta"
            onSecondaryAction={() => signOut()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--surface)] p-6">
      <div className="w-full max-w-md">
        <LoadingScreen
          title="Carregando seus dados"
          description={formatProgressDescription(hydrationStep)}
        />
        <HydrationProgressBar step={hydrationStep} />
      </div>
    </div>
  );
}

function LocalAppShell() {
  return (
    <ErrorBoundary>
      <>
        <AppRoutes />
        <GlobalAsyncFeedback />
      </>
    </ErrorBoundary>
  );
}

export default function App() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--surface)] p-6">
        <div className="w-full max-w-md">
          <LoadingScreen
            title="Carregando o Notar"
            description="Verificando sua sessão."
          />
        </div>
      </div>
    );
  }

  if (status === "authenticated") {
    return <CloudSyncGate />;
  }

  if (status === "local") {
    return <LocalAppShell />;
  }

  return <SignInPanel />;
}
