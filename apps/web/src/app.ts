import { idAfterRemoval, inboxCommand, movedId, type ReviewAction } from "./inbox.ts";

type JsonRecord = Record<string, unknown>;

function byId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`#${id}`);
  if (element === null) throw new Error(`Missing element: ${id}`);
  return element;
}

function inputById(id: string): HTMLInputElement {
  const element = byId(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`${id} is not an input.`);
  return element;
}

function formById(id: string): HTMLFormElement {
  const element = byId(id);
  if (!(element instanceof HTMLFormElement)) throw new Error(`${id} is not a form.`);
  return element;
}

let apiBase = (localStorage.getItem("personal-os-api-base") ?? "").replace(/\/$/u, "");
let accessToken = sessionStorage.getItem("personal-os-access-token") ?? "";
inputById("api-base").value = apiBase;
inputById("access-token").value = accessToken;

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(value: JsonRecord, key: string): string {
  const property = value[key];
  if (typeof property !== "string") throw new Error(`API response is missing ${key}.`);
  return property;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  if (accessToken.length > 0) headers.set("authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${apiBase}${path}`, { ...init, headers });
  const text = await response.text();
  const value =
    text.length === 0
      ? null
      : response.headers.get("content-type")?.includes("application/json") === true
        ? parseJson(text)
        : text;
  if (!response.ok) {
    const detail = isRecord(value) && typeof value.detail === "string" ? value.detail : null;
    throw new Error(detail ?? `Request failed (${response.status})`);
  }
  return value;
}

function toast(message: string): void {
  const element = byId("toast");
  element.textContent = message;
  element.classList.add("visible");
  window.setTimeout(() => element.classList.remove("visible"), 3200);
}

async function health(): Promise<void> {
  const element = byId("health");
  try {
    const value = await api("/health");
    if (!isRecord(value) || value.status !== "ok") throw new Error("API 未接続");
    element.innerHTML = '<span class="health-dot"></span><span>API 接続済み</span>';
    element.classList.add("ok");
    element.classList.remove("error");
    document.body.classList.add("api-connected");
  } catch (error: unknown) {
    element.innerHTML = `<span class="health-dot"></span><span>${escapeHtml(errorMessage(error))}</span>`;
    element.classList.remove("ok");
    element.classList.add("error");
    document.body.classList.remove("api-connected");
  }
}

interface Proposal {
  id: string;
  assertion: { kind: string; object: string; privacy: string; evidenceIds: string[] };
  createdAt: string;
}

function proposalsResponse(value: unknown): Proposal[] {
  if (!Array.isArray(value)) throw new Error("API returned an invalid proposal list.");
  return value.map((item) => {
    if (!isRecord(item) || !isRecord(item.assertion)) throw new Error("Invalid proposal.");
    const evidenceIds = item.assertion.evidenceIds;
    if (!Array.isArray(evidenceIds) || !evidenceIds.every((id) => typeof id === "string")) {
      throw new Error("Invalid proposal Evidence IDs.");
    }
    return {
      id: stringProperty(item, "id"),
      assertion: {
        kind: stringProperty(item.assertion, "kind"),
        object: stringProperty(item.assertion, "object"),
        privacy: stringProperty(item.assertion, "privacy"),
        evidenceIds,
      },
      createdAt: stringProperty(item, "createdAt"),
    };
  });
}

const ACTION_LABELS: Readonly<Record<ReviewAction, string>> = { approve: "承認", reject: "却下" };
const REASON_PLACEHOLDERS: Readonly<Record<ReviewAction, string>> = {
  approve: "例：本人の発言と一致している",
  reject: "例：根拠と内容が食い違っている",
};
const REASON_HINT = "Enter で確定 ・ Esc で取り消し";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let proposals: Proposal[] = [];

function setPendingCount(count: number): void {
  for (const id of ["pending-count", "nav-pending-count", "inbox-count"]) {
    const element = byId(id);
    if (element.textContent === String(count)) continue;
    element.textContent = String(count);
    element.classList.remove("bump");
    void element.offsetWidth;
    element.classList.add("bump");
  }
}

function proposalCard(proposal: Proposal, index: number): string {
  const id = escapeHtml(proposal.id);
  return `<article class="card inbox-card" tabindex="0" data-proposal-id="${id}" style="--i: ${Math.min(index, 8)}" aria-labelledby="proposal-title-${id}" aria-describedby="review-shortcuts"><div class="card-body"><p class="card-tags"><span class="badge badge-kind">${escapeHtml(proposal.assertion.kind)}</span><span class="badge">${escapeHtml(proposal.assertion.privacy)}</span></p><h3 id="proposal-title-${id}">${escapeHtml(proposal.assertion.object)}</h3><p class="meta">根拠 ${proposal.assertion.evidenceIds.length} 件 ・ ${escapeHtml(new Date(proposal.createdAt).toLocaleString("ja-JP"))}</p></div><div class="actions"><button type="button" data-compose="approve">承認<kbd>A</kbd></button><button type="button" class="reject" data-compose="reject">却下<kbd>R</kbd></button></div></article>`;
}

function renderProposals(): void {
  setPendingCount(proposals.length);
  byId("review-shortcuts").hidden = proposals.length === 0;
  byId("proposal-list").innerHTML =
    proposals.length === 0
      ? '<div class="empty-state inbox-empty"><div><span class="empty-state-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 12 3 3 7-7"/><circle cx="12" cy="12" r="9"/></svg></span><h3>すべて確認済みです</h3><p>次は新しい Evidence を取り込みましょう。取り込んだ Evidence からエージェントや CLI が提案を作ると、根拠の件数とともにここに並びます。</p><code class="empty-command">pnpm personal evidence import &lt;file&gt;</code></div></div>'
      : proposals.map(proposalCard).join("");
}

async function loadProposals(): Promise<void> {
  proposals = proposalsResponse(await api("/v1/proposals?status=pending"));
  renderProposals();
}

function cardById(id: string): HTMLElement | null {
  return byId("proposal-list").querySelector<HTMLElement>(
    `.inbox-card[data-proposal-id="${CSS.escape(id)}"]`,
  );
}

function focusCard(card: HTMLElement): void {
  card.focus();
  card.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
}

function closeComposer(restoreFocus: boolean): void {
  const form = byId("proposal-list").querySelector<HTMLFormElement>(".reason-form");
  if (form === null) return;
  const card = form.closest<HTMLElement>(".inbox-card");
  form.remove();
  card?.classList.remove("composing", "composing--approve", "composing--reject");
  if (restoreFocus && card !== null) focusCard(card);
}

function openComposer(card: HTMLElement, action: ReviewAction): void {
  closeComposer(false);
  const label = ACTION_LABELS[action];
  card.classList.add("composing", `composing--${action}`);
  card.insertAdjacentHTML(
    "beforeend",
    `<form class="reason-form" data-action="${action}" novalidate><label for="reason-input">${label}する理由</label><div class="reason-row"><input id="reason-input" name="reason" autocomplete="off" placeholder="${REASON_PLACEHOLDERS[action]}" aria-describedby="reason-hint" /><button type="submit" class="confirm confirm--${action}">${label}を確定</button><button type="button" class="secondary" data-cancel-review>キャンセル</button></div><p id="reason-hint" class="reason-hint">${REASON_HINT}</p></form>`,
  );
  card.querySelector<HTMLInputElement>("#reason-input")?.focus();
}

function leave(card: HTMLElement): Promise<void> {
  if (reducedMotion.matches) return Promise.resolve();
  card.style.height = `${card.offsetHeight}px`;
  card.classList.add("leaving");
  return new Promise((resolve) => {
    card.addEventListener("animationend", () => resolve(), { once: true });
    window.setTimeout(resolve, 450);
  });
}

async function dismissCard(card: HTMLElement, id: string): Promise<void> {
  const nextId = idAfterRemoval(
    proposals.map((proposal) => proposal.id),
    id,
  );
  proposals = proposals.filter((proposal) => proposal.id !== id);
  setPendingCount(proposals.length);
  const next = nextId === null ? null : cardById(nextId);
  if (next !== null) focusCard(next);
  await leave(card);
  card.remove();
  if (proposals.length === 0) {
    renderProposals();
    byId("review-title").focus();
  }
}

async function submitReview(form: HTMLFormElement): Promise<void> {
  const card = form.closest<HTMLElement>(".inbox-card");
  const id = card?.dataset.proposalId;
  const action = form.dataset.action;
  if (card === null || id === undefined || (action !== "approve" && action !== "reject")) return;
  const input = form.querySelector<HTMLInputElement>("#reason-input");
  const hint = form.querySelector<HTMLElement>("#reason-hint");
  if (input === null || hint === null) return;
  const reason = input.value.trim();
  if (reason.length === 0) {
    input.setAttribute("aria-invalid", "true");
    hint.textContent = "理由を入力してください。";
    hint.classList.add("error");
    input.focus();
    return;
  }
  const controls = form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button");
  controls.forEach((control) => (control.disabled = true));
  card.setAttribute("aria-busy", "true");
  try {
    await api(`/v1/proposals/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ actor: "web-owner", reason }),
    });
  } catch (error: unknown) {
    controls.forEach((control) => (control.disabled = false));
    card.removeAttribute("aria-busy");
    hint.textContent = errorMessage(error);
    hint.classList.add("error");
    input.focus();
    return;
  }
  toast(`提案を${ACTION_LABELS[action]}しました。`);
  void loadTimeline().catch(() => undefined);
  void loadState().catch(() => undefined);
  await dismissCard(card, id);
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.classList.contains("reason-form")) return;
  event.preventDefault();
  void submitReview(form).catch((error: unknown) => toast(errorMessage(error)));
});

document.addEventListener("input", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.id !== "reason-input") return;
  if (input.getAttribute("aria-invalid") === null) return;
  input.removeAttribute("aria-invalid");
  const hint = byId("reason-hint");
  hint.textContent = REASON_HINT;
  hint.classList.remove("error");
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (event.key === "Escape" && target.closest(".reason-form") !== null) {
    event.preventDefault();
    closeComposer(true);
    return;
  }
  if (target.closest("input, textarea, select, [contenteditable]") !== null) return;
  if (byId("review-view").classList.contains("hidden")) return;
  const command = inboxCommand(event);
  if (command === null) return;
  const card = target.closest<HTMLElement>(".inbox-card");
  if (command.type === "compose") {
    if (card === null) return;
    event.preventDefault();
    openComposer(card, command.action);
    return;
  }
  const fromPage = target === document.body || target === byId("main");
  if (card === null && (!fromPage || event.key.startsWith("Arrow"))) return;
  const nextId = movedId(
    proposals.map((proposal) => proposal.id),
    card?.dataset.proposalId ?? null,
    command.delta,
  );
  const next = nextId === null ? null : cardById(nextId);
  if (next === null) return;
  event.preventDefault();
  focusCard(next);
});

interface TimelineEntry {
  operation: string;
  occurredAt: string;
  actor: string;
  reason: string;
  entityType: string;
  entityId: string;
  privacy: string;
}

function timelineResponse(value: unknown): TimelineEntry[] {
  if (!Array.isArray(value)) throw new Error("API returned an invalid timeline.");
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("Invalid timeline entry.");
    return {
      operation: stringProperty(item, "operation"),
      occurredAt: stringProperty(item, "occurredAt"),
      actor: stringProperty(item, "actor"),
      reason: stringProperty(item, "reason"),
      entityType: stringProperty(item, "entityType"),
      entityId: stringProperty(item, "entityId"),
      privacy: stringProperty(item, "privacy"),
    };
  });
}

async function loadTimeline(): Promise<void> {
  const entries = timelineResponse(await api("/v1/timeline?privacy=P0,P1,P2,P3&limit=100"));
  byId("timeline-count").textContent = String(entries.length);
  byId("timeline-list").innerHTML =
    entries
      .map(
        (entry) =>
          `<li><div><strong>${escapeHtml(entry.operation)}</strong> <span class="badge">${escapeHtml(entry.privacy)}</span><p class="meta">${escapeHtml(new Date(entry.occurredAt).toLocaleString("ja-JP"))}</p></div><div><p>${escapeHtml(entry.reason)}</p><p class="meta">実行者：${escapeHtml(entry.actor)}</p><code>${escapeHtml(entry.entityType)}:${escapeHtml(entry.entityId)}</code></div></li>`,
      )
      .join("") ||
    '<li><div><strong>履歴はまだありません</strong></div><div><p class="meta">最初の Evidence を取り込むと、監査イベントが表示されます。</p></div></li>';
}

interface Assertion {
  id: string;
  kind: string;
  object: string;
  privacy: string;
  validFrom: string;
}
interface CurrentState {
  asOf: string;
  preferences: Assertion[];
  intents: Record<string, Assertion[]>;
}

function assertionResponse(value: unknown): Assertion {
  if (!isRecord(value)) throw new Error("Invalid assertion.");
  return {
    id: stringProperty(value, "id"),
    kind: stringProperty(value, "kind"),
    object: stringProperty(value, "object"),
    privacy: stringProperty(value, "privacy"),
    validFrom: stringProperty(value, "validFrom"),
  };
}

function currentStateResponse(value: unknown): CurrentState {
  if (!isRecord(value) || !Array.isArray(value.preferences) || !isRecord(value.intents)) {
    throw new Error("API returned an invalid current state.");
  }
  const intents: Record<string, Assertion[]> = {};
  for (const [kind, assertions] of Object.entries(value.intents)) {
    if (!Array.isArray(assertions)) throw new Error("Invalid intent group.");
    intents[kind] = assertions.map(assertionResponse);
  }
  return {
    asOf: stringProperty(value, "asOf"),
    preferences: value.preferences.map(assertionResponse),
    intents,
  };
}

function assertionCard(assertion: Assertion): string {
  return `<article class="result"><span class="badge">${escapeHtml(assertion.kind)}</span><span class="badge">${escapeHtml(assertion.privacy)}</span><h3>${escapeHtml(assertion.object)}</h3><p class="meta">${escapeHtml(new Date(assertion.validFrom).toLocaleString("ja-JP"))} から有効 ・ ${escapeHtml(assertion.id)}</p></article>`;
}

async function loadState(): Promise<void> {
  const state = currentStateResponse(await api("/v1/self/current?privacy=P0,P1,P2,P3"));
  const groups = { preferences: state.preferences, ...state.intents };
  byId("memory-count").textContent = String(
    Object.values(groups).reduce((total, assertions) => total + assertions.length, 0),
  );
  byId("state-content").innerHTML = Object.entries(groups)
    .map(
      ([kind, assertions]) =>
        `<section class="state-group"><h3>${escapeHtml(kind.replaceAll("_", " "))} <span class="meta">${assertions.length}</span></h3><div class="stack">${assertions.map(assertionCard).join("") || '<p class="meta">有効な項目はありません。</p>'}</div></section>`,
    )
    .join("");
}

document.addEventListener("click", (event) => {
  const source = event.target;
  if (!(source instanceof Element)) return;
  const target = source.closest("button");
  if (!(target instanceof HTMLButtonElement)) return;
  const view = target.dataset.view;
  if (view !== undefined) {
    document
      .querySelectorAll(".tab")
      .forEach((tab) => tab.classList.toggle("active", tab === target));
    document
      .querySelectorAll(".view")
      .forEach((section) => section.classList.toggle("hidden", section.id !== `${view}-view`));
    const labels: Readonly<Record<string, string>> = {
      review: "レビュー",
      search: "検索",
      timeline: "タイムライン",
      state: "現在の状態",
    };
    byId("current-view-label").textContent = labels[view] ?? view;
    if (view === "timeline")
      void loadTimeline().catch((error: unknown) => toast(errorMessage(error)));
    if (view === "state") void loadState().catch((error: unknown) => toast(errorMessage(error)));
  }
  const compose = target.dataset.compose;
  const card = target.closest<HTMLElement>(".inbox-card");
  if ((compose === "approve" || compose === "reject") && card !== null) openComposer(card, compose);
  if (target.dataset.cancelReview !== undefined) closeComposer(true);
  const refresh = target.dataset.refresh;
  if (refresh === "review")
    void loadProposals().catch((error: unknown) => toast(errorMessage(error)));
  if (refresh === "timeline")
    void loadTimeline().catch((error: unknown) => toast(errorMessage(error)));
  if (refresh === "state") void loadState().catch((error: unknown) => toast(errorMessage(error)));
});

formById("connection-form").addEventListener("submit", (event) => {
  event.preventDefault();
  apiBase = inputById("api-base").value.trim().replace(/\/$/u, "");
  accessToken = inputById("access-token").value.trim();
  localStorage.setItem("personal-os-api-base", apiBase);
  sessionStorage.setItem("personal-os-access-token", accessToken);
  void Promise.all([health(), loadProposals(), loadTimeline(), loadState()]);
});

const searchForm = formById("search-form");
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(searchForm);
  const queryValue = form.get("query");
  const query = typeof queryValue === "string" ? queryValue : "";
  const privacy = form
    .getAll("privacy")
    .filter((value): value is string => typeof value === "string");
  void api("/v1/search", { method: "POST", body: JSON.stringify({ query, privacy }) })
    .then((value) => {
      if (!isRecord(value) || !Array.isArray(value.assertions) || !Array.isArray(value.decisions)) {
        throw new Error("API returned invalid search results.");
      }
      const assertions = value.assertions.map(assertionResponse);
      const decisions = value.decisions.map((decision) => {
        if (!isRecord(decision)) throw new Error("Invalid Decision result.");
        return `<article class="result"><span class="badge">decision</span><h3>${escapeHtml(stringProperty(decision, "problem"))}</h3><p>${escapeHtml(stringProperty(decision, "rationale"))}</p></article>`;
      });
      byId("search-results").innerHTML =
        [...assertions.map(assertionCard), ...decisions].join("") ||
        '<div class="empty-state"><div><h3>根拠のある記憶が見つかりませんでした</h3><p>検索語またはプライバシークラスを変えて、もう一度お試しください。</p></div></div>';
    })
    .catch((error: unknown) => toast(errorMessage(error)));
});

void health();
void loadProposals().catch((error: unknown) => toast(errorMessage(error)));
void loadTimeline().catch(() => undefined);
void loadState().catch(() => undefined);
