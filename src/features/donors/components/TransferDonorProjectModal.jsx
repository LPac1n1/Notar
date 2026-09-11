import { useEffect, useMemo, useState } from "react";
import Button from "../../../components/ui/Button";
import FeedbackMessage from "../../../components/ui/FeedbackMessage";
import Modal from "../../../components/ui/Modal";
import MonthInput from "../../../components/ui/MonthInput";
import SelectInput from "../../../components/ui/SelectInput";
import { listProjectDemands } from "../../../services/demandService";
import { logError } from "../../../services/logger";
import {
  assignUnlinkedDonorToProject,
  listDonorDonationMonths,
  listProjects,
  transferDonorToProject,
} from "../../../services/projectService";
import {
  formatMonthAbbrev,
  formatMonthsSpan,
  formatMonthYear,
} from "../../../utils/date";
import { getErrorMessage } from "../../../utils/error";

const MONTH_VALUE_PATTERN = /^\d{4}-\d{2}$/;

function currentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * O último mês que fica com o projeto ANTERIOR.
 *
 * A janela antiga fecha em `effectiveMonth - 1`, porque `valid_to` é
 * inclusivo: fechar no próprio mês faria o mês da transferência pertencer aos
 * dois projetos e o crédito dele ser contado duas vezes. O texto tem de dizer
 * o mesmo mês que o banco grava — anunciar o mês efetivo aqui prometeria ao
 * operador um recorte diferente do que ele vai ver depois.
 */
function previousMonthLabel(monthValue) {
  if (!MONTH_VALUE_PATTERN.test(monthValue)) return "o mês anterior";

  const [year, month] = monthValue.split("-").map(Number);
  const previous = new Date(year, month - 2, 1);

  return formatMonthYear(
    `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}-01`,
  );
}

/**
 * O mês sugerido para a transferência.
 *
 * Era o mês do calendário. Só que a planilha da NFP chega meses depois da
 * compra, então o mês corrente quase nunca tem nota: a transferência passava,
 * nenhuma doação mudava de projeto e o doador não aparecia na Gestão Mensal do
 * destino — nem o nome, nem as pendências.
 *
 * A sugestão passou a ser o primeiro mês com doação dentro do vínculo atual,
 * o que leva junto tudo que ainda está nele. Continua sendo só sugestão: o
 * texto abaixo do campo diz o que muda e o que fica antes de confirmar.
 *
 * Precisa ser POSTERIOR ao início do vínculo atual (o serviço recusa o
 * contrário), então o próprio mês de início nunca é sugerido. Sem doação
 * elegível, volta ao mês corrente.
 */
function suggestEffectiveMonth(donationMonths, windowStart) {
  return (
    donationMonths.find((month) => !windowStart || month > windowStart) ??
    currentMonthValue()
  );
}

function describeDonationMonths(months) {
  const count = months.length;
  const noun = count === 1 ? "1 mês com doação" : `${count} meses com doação`;

  // A lista inteira só enquanto é curta; depois disso, o intervalo basta.
  if (count <= 4) {
    return `${noun} (${formatMonthsSpan(months)})`;
  }

  return `${noun}, de ${formatMonthAbbrev(months[0])} a ${formatMonthAbbrev(months[count - 1])}`;
}

/**
 * Transferência de um doador entre projetos, a partir de um mês.
 *
 * O mês é obrigatório e não é detalhe de formulário: ele decide onde cada
 * doação passada é contada. A planilha é mensal, então uma vigência no meio do
 * mês exigiria um rateio que o dado de origem não permite calcular.
 *
 * Quando o doador ainda não tem vínculo nenhum, a operação é outra: não há
 * janela para fechar, então o vínculo abre desde o início do histórico e todo
 * o crédito passado dele passa a somar para o projeto escolhido. Usar a
 * transferência aqui deixaria os meses anteriores sem projeto.
 *
 * Nos dois caminhos, destino que classifica por demanda exige a demanda — sem
 * ela o doador chega à Gestão Mensal como "Não informada".
 */
export default function TransferDonorProjectModal({
  currentAssignment,
  donor,
  onClose,
  onTransferred,
}) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [demand, setDemand] = useState("");
  const [demandsByProject, setDemandsByProject] = useState({
    projectId: "",
    items: [],
  });
  // `null` enquanto carrega — distinto de "não tem doação nenhuma".
  const [donationMonths, setDonationMonths] = useState(null);
  // `null` enquanto o operador não mexe no campo: o mês exibido é a sugestão.
  const [editedMonth, setEditedMonth] = useState(null);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isFirstAssignment = !currentAssignment;
  const donorId = donor?.id ?? "";
  const currentProjectName =
    currentAssignment?.projectName || "o projeto atual";
  // Início do vínculo atual em AAAA-MM; vazio quando ele vale desde sempre.
  const windowStart = String(currentAssignment?.validFrom ?? "").slice(0, 7);

  useEffect(() => {
    let cancelled = false;

    listProjects({ activeStatus: "active" })
      .then((rows) => {
        if (!cancelled) setProjects(rows);
      })
      .catch((err) => {
        logError("TransferDonorProject.loadProjects", err);
        if (!cancelled) {
          setError("Não foi possível carregar a lista de projetos.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!donorId) return undefined;

    let cancelled = false;

    listDonorDonationMonths(donorId)
      .then((months) => {
        if (!cancelled) setDonationMonths(months);
      })
      .catch((err) => {
        // Sem a lista a transferência continua possível: a sugestão fica no
        // mês corrente e o texto volta a ser o genérico.
        logError("TransferDonorProject.loadDonationMonths", err);
      });

    return () => {
      cancelled = true;
    };
  }, [donorId]);

  const options = useMemo(
    () =>
      projects
        .filter((project) => project.id !== currentAssignment?.projectId)
        .map((project) => ({ value: project.id, label: project.name })),
    [projects, currentAssignment],
  );

  const selectedProject = projects.find((project) => project.id === projectId);
  const usesDemands =
    Boolean(selectedProject) && selectedProject.modules?.demands !== false;

  useEffect(() => {
    if (!projectId || !usesDemands) return undefined;

    let cancelled = false;

    listProjectDemands(projectId)
      .then((items) => {
        if (!cancelled) setDemandsByProject({ projectId, items });
      })
      .catch((err) => {
        logError("TransferDonorProject.loadDemands", err);
        if (!cancelled) {
          setError("Não foi possível carregar as demandas do projeto de destino.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, usesDemands]);

  // `null` enquanto as demandas do destino escolhido ainda não chegaram — a
  // lista guardada pode ser de outro destino escolhido antes.
  const destinationDemands =
    demandsByProject.projectId === projectId ? demandsByProject.items : null;
  const demandOptions = useMemo(
    () =>
      (destinationDemands ?? []).map((item) => ({
        value: item.name,
        label: item.name,
      })),
    [destinationDemands],
  );
  const destinationHasNoDemands =
    usesDemands && destinationDemands !== null && destinationDemands.length === 0;

  const suggestedMonth = useMemo(
    () => suggestEffectiveMonth(donationMonths ?? [], windowStart),
    [donationMonths, windowStart],
  );
  const effectiveMonth = editedMonth ?? suggestedMonth;
  const hasValidMonth = MONTH_VALUE_PATTERN.test(effectiveMonth);

  const monthsInWindow = (donationMonths ?? []).filter(
    (month) => !windowStart || month >= windowStart,
  );
  const movingMonths = hasValidMonth
    ? monthsInWindow.filter((month) => month >= effectiveMonth)
    : [];
  const stayingMonths = hasValidMonth
    ? monthsInWindow.filter((month) => month < effectiveMonth)
    : [];
  const destinationName = selectedProject?.name ?? "o novo projeto";

  const handleProjectChange = (event) => {
    setProjectId(event.target.value);
    // Demanda é do projeto: a escolhida para um destino não existe no outro.
    setDemand("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!projectId) {
      setError("Selecione o projeto de destino.");
      return;
    }

    if (usesDemands && !demand) {
      setError(`Selecione a demanda do doador em ${selectedProject.name}.`);
      return;
    }

    try {
      setError("");
      setIsSubmitting(true);

      if (isFirstAssignment) {
        await assignUnlinkedDonorToProject({
          donorId: donor.id,
          projectId,
          demand,
        });
      } else {
        await transferDonorToProject({
          donorId: donor.id,
          projectId,
          effectiveMonth,
          demand,
        });
      }

      onTransferred(selectedProject?.name ?? "outro projeto");
    } catch (err) {
      logError("TransferDonorProject.submit", err);
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderTransferSummary = () => {
    if (!hasValidMonth) {
      return <p>Informe o mês a partir do qual a transferência vale.</p>;
    }

    if (donationMonths === null) {
      return (
        <p>
          As doações até {previousMonthLabel(effectiveMonth)} continuam somando
          para {currentProjectName}. Só o que vier depois conta para o novo
          projeto.
        </p>
      );
    }

    return (
      <>
        <p>
          {movingMonths.length > 0
            ? `Passam para ${destinationName}: ${describeDonationMonths(movingMonths)}.`
            : `Nenhuma doação registrada a partir de ${formatMonthYear(`${effectiveMonth}-01`)}: só as planilhas desse período em diante vão contar para ${destinationName}.`}
        </p>
        <p>
          {stayingMonths.length > 0
            ? `Continuam em ${currentProjectName} as doações até ${previousMonthLabel(effectiveMonth)}: ${describeDonationMonths(stayingMonths)}.`
            : `Nenhuma doação fica em ${currentProjectName}.`}
        </p>
      </>
    );
  };

  return (
    <Modal
      title={isFirstAssignment ? "Vincular a um projeto" : "Transferir de projeto"}
      description={
        isFirstAssignment
          ? `${donor?.name} passa a pertencer ao projeto escolhido, com todo o histórico dele.`
          : `${donor?.name} deixa de pertencer a ${currentProjectName} a partir do mês informado.`
      }
      onClose={onClose}
      size="sm"
    >
      <form onSubmit={handleSubmit}>
        <FeedbackMessage message={error} tone="error" />

        <SelectInput
          label="Projeto de destino"
          name="projectId"
          value={projectId}
          onChange={handleProjectChange}
          options={options}
          placeholder="Selecione o projeto"
          searchable
          searchPlaceholder="Buscar projeto..."
        />

        {usesDemands ? (
          <div className="mt-3">
            <SelectInput
              label="Demanda"
              name="demand"
              value={demand}
              onChange={(event) => setDemand(event.target.value)}
              options={demandOptions}
              placeholder={
                destinationDemands === null
                  ? "Carregando demandas..."
                  : "Selecione a demanda"
              }
              searchable
              searchPlaceholder="Buscar demanda..."
            />
            <p className="mt-1 text-xs text-[var(--muted)]">
              {destinationHasNoDemands
                ? `${selectedProject.name} ainda não tem demanda cadastrada. Cadastre uma na tela de Demandas desse projeto antes de continuar.`
                : `Obrigatória: ${selectedProject.name} agrupa os doadores por demanda na Gestão Mensal, nos relatórios e na planilha de abatimento.`}
            </p>
          </div>
        ) : null}

        {isFirstAssignment ? null : (
          <div className="mt-3">
            <MonthInput
              label="A partir de"
              name="effectiveMonth"
              value={effectiveMonth}
              onChange={(event) => setEditedMonth(event.target.value)}
            />
          </div>
        )}

        <div className="mt-3 space-y-1 rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-3 text-sm text-[var(--muted)]">
          {isFirstAssignment ? (
            <p>
              Sem vínculo anterior, todo o crédito já conciliado deste doador
              passa a ser atribuído ao projeto escolhido.
            </p>
          ) : (
            renderTransferSummary()
          )}
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <Button type="button" variant="subtle" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            disabled={isSubmitting || destinationHasNoDemands}
          >
            {isSubmitting
              ? "Salvando..."
              : isFirstAssignment
                ? "Vincular"
                : "Transferir"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
