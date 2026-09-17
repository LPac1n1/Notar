import { useEffect, useRef, useState } from "react";
import Button from "../../../components/ui/Button";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
} from "../../../components/ui/icons";
import { formatDatePtBR, formatMonthYear } from "../../../utils/date";
import { formatCurrency, formatInteger } from "../../../utils/format";

export default function ImportedMonthsCarousel({
  imports,
  selectedReferenceMonths = [],
  isMultiSelect = false,
  onSelectMonth,
  onToggleMonth,
  onToggleMultiSelect,
}) {
  // Comparação por mês: o carrossel guarda a data completa do mês de
  // referência ("2026-03-01") e o campo de filtro entrega "2026-03".
  const selectedKeys = new Set(
    selectedReferenceMonths.map((month) => String(month).slice(0, 7)),
  );
  const railRef = useRef(null);
  const trackRef = useRef(null);
  const dragStateRef = useRef(null);
  const [scrollState, setScrollState] = useState({
    left: 0,
    scrollWidth: 0,
    clientWidth: 0,
  });

  useEffect(() => {
    const rail = railRef.current;

    if (!rail) {
      return undefined;
    }

    const update = () => {
      setScrollState({
        left: rail.scrollLeft,
        scrollWidth: rail.scrollWidth,
        clientWidth: rail.clientWidth,
      });
    };

    update();
    rail.addEventListener("scroll", update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(rail);

    return () => {
      rail.removeEventListener("scroll", update);
      resizeObserver.disconnect();
    };
  }, [imports.length]);

  useEffect(() => {
    const handleMove = (event) => {
      const dragState = dragStateRef.current;
      const rail = railRef.current;

      if (!dragState || !rail) {
        return;
      }

      const deltaX = event.clientX - dragState.startX;
      const scrollableTrack = dragState.trackWidth - dragState.thumbWidth;
      const scrollableContent = rail.scrollWidth - rail.clientWidth;

      if (scrollableTrack <= 0 || scrollableContent <= 0) {
        return;
      }

      rail.scrollLeft =
        dragState.startScrollLeft +
        (deltaX / scrollableTrack) * scrollableContent;
    };

    const handleUp = () => {
      dragStateRef.current = null;
      document.body.style.removeProperty("user-select");
    };

    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
    document.addEventListener("pointercancel", handleUp);

    return () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
      document.removeEventListener("pointercancel", handleUp);
    };
  }, []);

  const isOverflowing = scrollState.scrollWidth > scrollState.clientWidth + 1;
  const thumbWidthPercent = isOverflowing
    ? Math.max(
        (scrollState.clientWidth / scrollState.scrollWidth) * 100,
        12,
      )
    : 100;
  const maxScrollLeft = Math.max(
    scrollState.scrollWidth - scrollState.clientWidth,
    1,
  );
  const thumbLeftPercent = isOverflowing
    ? (scrollState.left / maxScrollLeft) * (100 - thumbWidthPercent)
    : 0;

  const handleTrackPointerDown = (event) => {
    if (event.button !== 0) {
      return;
    }

    const rail = railRef.current;
    const track = trackRef.current;

    if (!rail || !track || !isOverflowing) {
      return;
    }

    const trackRect = track.getBoundingClientRect();
    const thumbWidthPx = (trackRect.width * thumbWidthPercent) / 100;
    const thumbLeftPx = (trackRect.width * thumbLeftPercent) / 100;
    const clickX = event.clientX - trackRect.left;
    const onThumb =
      clickX >= thumbLeftPx && clickX <= thumbLeftPx + thumbWidthPx;
    const scrollableContent = rail.scrollWidth - rail.clientWidth;
    const scrollableTrack = trackRect.width - thumbWidthPx;

    if (!onThumb && scrollableTrack > 0) {
      const targetThumbLeft = Math.max(
        0,
        Math.min(clickX - thumbWidthPx / 2, scrollableTrack),
      );
      rail.scrollTo({
        left: (targetThumbLeft / scrollableTrack) * scrollableContent,
        behavior: "smooth",
      });
      return;
    }

    dragStateRef.current = {
      startX: event.clientX,
      startScrollLeft: rail.scrollLeft,
      trackWidth: trackRect.width,
      thumbWidth: thumbWidthPx,
    };
    document.body.style.userSelect = "none";
    event.preventDefault();
  };

  const scrollByPage = (direction) => {
    const rail = railRef.current;

    if (!rail) {
      return;
    }

    rail.scrollBy({
      left: direction * Math.max(rail.clientWidth * 0.75, 280),
      behavior: "smooth",
    });
  };

  return (
    <div className="mb-5 rounded-md border border-[var(--line)] bg-[var(--surface-elevated)] p-4">
      <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-semibold text-[var(--text-main)]">
            Meses importados
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {isMultiSelect
              ? `${formatInteger(selectedKeys.size)} mês(es) selecionado(s) — os valores saem somados, com o detalhe de cada mês`
              : `${formatInteger(imports.length)} mês(es) com planilha processada`}
          </p>
        </div>

        <div className="flex gap-2">
          {onToggleMultiSelect ? (
            <Button
              variant={isMultiSelect ? "primary" : "subtle"}
              onClick={onToggleMultiSelect}
              aria-pressed={isMultiSelect}
              title="Marque vários meses para ver, exportar e abater os valores somados no período."
            >
              {isMultiSelect ? "Selecionando vários" : "Selecionar vários"}
            </Button>
          ) : null}
          <Button
            variant="subtle"
            className="h-10 w-10 px-0"
            onClick={() => scrollByPage(-1)}
            aria-label="Ver meses anteriores"
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="subtle"
            className="h-10 w-10 px-0"
            onClick={() => scrollByPage(1)}
            aria-label="Ver próximos meses"
          >
            <ChevronRightIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        ref={railRef}
        role="list"
        aria-label="Meses importados"
        className="no-scrollbar flex gap-3 overflow-x-auto [touch-action:pan-x] snap-x snap-mandatory"
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          const buttons = [...railRef.current.querySelectorAll("button")];
          const idx = buttons.indexOf(document.activeElement);
          if (idx === -1) return;
          let next = idx;
          if (e.key === "ArrowLeft") next = Math.max(0, idx - 1);
          else if (e.key === "ArrowRight") next = Math.min(buttons.length - 1, idx + 1);
          else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = buttons.length - 1;
          buttons[next].focus();
          buttons[next].scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
        }}
      >
        {imports.map((item) => {
          const isSelected = selectedKeys.has(
            String(item.referenceMonth).slice(0, 7),
          );
          const actionLabel = isMultiSelect
            ? isSelected
              ? "Desmarcar"
              : "Marcar"
            : isSelected
              ? "Limpar seleção de"
              : "Selecionar";

          return (
            <button
              key={item.id}
              role="listitem"
              type="button"
              onClick={() =>
                isMultiSelect
                  ? onToggleMonth?.(item.referenceMonth)
                  : onSelectMonth?.(isSelected ? "" : item.referenceMonth)
              }
              aria-label={`${actionLabel} ${formatMonthYear(item.referenceMonth)}`}
              aria-pressed={isSelected}
              className={`snap-start min-w-[250px] rounded-md border p-4 text-left transition ${
                isSelected
                  ? "border-[var(--accent)] bg-[var(--surface-elevated)]"
                  : "border-[var(--line)] bg-[var(--surface-strong)] hover:border-[var(--line-strong)]"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-[var(--text-main)]">
                    {formatMonthYear(item.referenceMonth)}
                  </p>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    {formatInteger(item.matchedDonors)} doador(es) que doaram
                  </p>
                </div>
                <span
                  className={`rounded-md px-2 py-1 text-xs font-medium ${
                    isSelected
                      ? "bg-[color:var(--accent-soft)] text-[var(--accent)]"
                      : "bg-[color:var(--surface-muted)] text-[var(--text-soft)]"
                  }`}
                >
                  {isMultiSelect
                    ? isSelected
                      ? "Marcado"
                      : "Marcar"
                    : isSelected
                      ? "Fechar"
                      : "Ver"}
                </span>
              </div>

              <div className="mt-3 space-y-1 text-sm text-[var(--muted)]">
                <p>
                  Valor por nota:{" "}
                  <span className="font-medium">
                    {formatCurrency(item.valuePerNote)}
                  </span>
                </p>
                <p>
                  Importado em{" "}
                  <span className="font-medium">
                    {formatDatePtBR(item.importedAt)}
                  </span>
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {isOverflowing ? (
        <div
          ref={trackRef}
          onPointerDown={handleTrackPointerDown}
          className="mt-3 h-1.5 w-full cursor-pointer rounded-full bg-[color:var(--line)]"
        >
          <div
            className="h-full rounded-full bg-[color:var(--line-strong)] transition-colors hover:bg-[color:var(--muted-strong)]"
            style={{
              width: `${thumbWidthPercent}%`,
              marginLeft: `${thumbLeftPercent}%`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
