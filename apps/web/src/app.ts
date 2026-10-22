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

async function loadProposals(): Promise<void> {
  const proposals = proposalsResponse(await api("/v1/proposals?status=pending"));
  byId("pending-count").textContent = String(proposals.length);
  byId("nav-pending-count").textContent = String(proposals.length);
  byId("proposal-list").innerHTML =
    proposals.length === 0
      ? '<div class="empty-state"><div><span class="empty-state-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 12 3 3 7-7"/><circle cx="12" cy="12" r="9"/></svg></span><h3>すべて確認済みです</h3><p>新しい提案が届くと、ここに根拠とともに表示されます。</p></div></div>'
      : proposals
          .map(
            (proposal) =>
              `<article class="card"><div><p><span class="badge">${escapeHtml(proposal.assertion.kind)}</span><span class="badge">${escapeHtml(proposal.assertion.privacy)}</span></p><h3>${escapeHtml(proposal.assertion.object)}</h3><p class="meta">根拠 ${proposal.assertion.evidenceIds.length} 件 ・ ${escapeHtml(new Date(proposal.createdAt).toLocaleString("ja-JP"))}</p></div><div class="actions"><button data-review="approve" data-id="${escapeHtml(proposal.id)}">承認</button><button class="reject" data-review="reject" data-id="${escapeHtml(proposal.id)}">却下</button></div></article>`,
          )
          .join("");
}

async function review(id: string, action: "approve" | "reject"): Promise<void> {
  const actionLabel = action === "approve" ? "承認" : "却下";
  const reason = window.prompt(`${actionLabel}する理由を入力してください。`)?.trim();
  if (!reason) return;
  await api(`/v1/proposals/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    body: JSON.stringify({ actor: "web-owner", reason }),
  });
  toast(`提案を${actionLabel}しました。`);
  await loadProposals();
}

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
  const reviewAction = target.dataset.review;
  const id = target.dataset.id;
  if ((reviewAction === "approve" || reviewAction === "reject") && id !== undefined) {
    void review(id, reviewAction).catch((error: unknown) => toast(errorMessage(error)));
  }
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
