export {
  DONATION_START_DATE_OPTIONS,
  DONOR_TYPE_OPTIONS,
} from "../../constants/filterOptions";

export const INITIAL_MONTHLY_FILTERS = {
  // `referenceMonth` é derivado de `referenceMonths`: preenchido só quando
  // há exatamente um mês escolhido. Ver `withSelectedMonths` em Monthly.jsx.
  referenceMonth: "",
  referenceMonths: [],
  search: "",
  donorId: "",
  donorType: "all",
  cpf: "",
  demand: "",
  donationActivity: "all",
  abatementStatus: "all",
  abatementSort: "",
  donationStartDate: "all",
  reconciliationStatus: "all",
};

export const ICON_TONE_CLASS_NAMES = {
  default:
    "border-[var(--line)] bg-[color:var(--surface-strong)] text-[var(--text-soft)]",
  success:
    "border-[var(--success-line)] bg-[color:var(--success-soft)] text-[var(--success)]",
  warning:
    "border-[var(--warning-line)] bg-[color:var(--warning-soft)] text-[var(--warning)]",
};

export const ABATEMENT_STATUS_OPTIONS = [
  { value: "all", label: "Todos os status" },
  { value: "pending", label: "Pendentes", tone: "warning" },
  { value: "applied", label: "Realizados", tone: "success" },
];

export const DONATION_ACTIVITY_OPTIONS = [
  { value: "all", label: "Todos os doadores" },
  { value: "donated", label: "Doaram no mês", tone: "success" },
  { value: "not-donated", label: "Não doaram no mês", tone: "default" },
];

export const ABATEMENT_SORT_OPTIONS = [
  { value: "", label: "Sem ordenação por abatimento" },
  { value: "desc", label: "Maior abatimento primeiro" },
  { value: "asc", label: "Menor abatimento primeiro" },
];

// "incomplete" used to be a separate filter ("Crédito disponível") but
// surplus credit no longer counts as a problem — credit > abated is just
// folded into "ok". Removing the option keeps the filter list from
// landing the user on an always-empty result page.
export const RECONCILIATION_STATUS_OPTIONS = [
  { value: "all", label: "Toda a conciliação" },
  { value: "ok", label: "Com crédito conciliado", tone: "success" },
  { value: "no-credit", label: "Sem crédito conciliado", tone: "default" },
];
