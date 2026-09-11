import Button from "../../../components/ui/Button";
import {
  CheckIcon,
  DownloadIcon,
  FileIcon,
  HistoryIcon,
} from "../../../components/ui/icons";
import OverviewMetric from "./OverviewMetric";

export default function MonthlySummaryToolbar({
  metrics,
  onBulkAbate,
  onBulkUnabate,
  onClearRefinements,
  onExportCsv,
  onExportPdf,
  onExportJpeg,
  onExportReconciliationCsv,
  onExportAbatementSheet,
  isBulkAbateDisabled,
  isBulkUnabateDisabled,
  isExportingCsv,
  isExportingPdf,
  isExportingJpeg,
  isExportingReconciliation,
  isExportingAbatementSheet,
  isPdfDisabled,
  hasSelectedReferenceMonth = true,
}) {
  return (
    <div className="mb-5 grid gap-4">
      <div className={`grid gap-3 ${metrics.length > 2 ? "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : "sm:grid-cols-2"}`}>
        {metrics.map((metric) => (
          <OverviewMetric
            key={metric.label}
            icon={metric.icon}
            label={metric.label}
            value={metric.value}
            helper={metric.helper}
            tone={metric.tone}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <Button
          variant="primary"
          onClick={onBulkAbate}
          disabled={isBulkAbateDisabled}
          leftIcon={<CheckIcon className="h-4 w-4" />}
        >
          Abater em massa
        </Button>
        {onBulkUnabate ? (
          <Button
            variant="subtle"
            onClick={onBulkUnabate}
            disabled={isBulkUnabateDisabled}
            leftIcon={<HistoryIcon className="h-4 w-4" />}
            title="Volta para pendente os abatimentos já realizados dos meses que você escolher."
          >
            Desabater em massa
          </Button>
        ) : null}
        <Button
          variant="subtle"
          onClick={onClearRefinements}
        >
          Limpar refinamentos
        </Button>
        {onExportAbatementSheet ? (
          <Button
            variant="subtle"
            onClick={onExportAbatementSheet}
            disabled={isExportingAbatementSheet}
            isLoading={isExportingAbatementSheet}
            loadingLabel="Gerando planilha..."
            leftIcon={<DownloadIcon className="h-4 w-4" />}
            title={
              hasSelectedReferenceMonth
                ? "Planilha .xlsx por CPF do mês selecionado, no formato que o sistema de abatimento importa. Sai uma por demanda."
                : "Sem mês selecionado: planilha .xlsx com todos os meses ainda pendentes, somados por CPF. A descrição de cada linha nomeia os meses. Sai uma por demanda."
            }
          >
            {/* O rótulo muda junto com o que o botão gera: sem mês, a planilha
                não é "do mês" e sim de tudo que está pendente. */}
            {hasSelectedReferenceMonth
              ? "Planilha de abatimento"
              : "Planilha dos pendentes"}
          </Button>
        ) : null}
        <Button
          variant="subtle"
          onClick={onExportCsv}
          disabled={isExportingCsv}
          isLoading={isExportingCsv}
          loadingLabel="Exportando..."
          leftIcon={<DownloadIcon className="h-4 w-4" />}
        >
          Exportar CSV
        </Button>
        <Button
          variant="subtle"
          onClick={onExportPdf}
          disabled={isExportingPdf || isPdfDisabled}
          isLoading={isExportingPdf}
          loadingLabel="Gerando PDF..."
          leftIcon={<FileIcon className="h-4 w-4" />}
          title="Gera um PDF por demanda com os doadores filtrados. Disponível após selecionar um mês."
        >
          PDFs por demanda
        </Button>
        <Button
          variant="subtle"
          onClick={onExportJpeg}
          disabled={isExportingJpeg || isPdfDisabled}
          isLoading={isExportingJpeg}
          loadingLabel="Gerando JPEG..."
          leftIcon={<FileIcon className="h-4 w-4" />}
          title="Gera uma imagem JPEG por demanda com os doadores filtrados. Disponível após selecionar um mês."
        >
          JPEGs por demanda
        </Button>
        {onExportReconciliationCsv ? (
          <Button
            variant="subtle"
            onClick={onExportReconciliationCsv}
            disabled={isExportingReconciliation}
            isLoading={isExportingReconciliation}
            loadingLabel="Exportando..."
            leftIcon={<DownloadIcon className="h-4 w-4" />}
            title="Exporta a conciliação por doador respeitando os filtros (mês e status)."
          >
            Exportar conciliação CSV
          </Button>
        ) : null}
      </div>
    </div>
  );
}
