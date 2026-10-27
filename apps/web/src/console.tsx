import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import {
  ApiUnreachableError,
  createdEvidenceId,
  currentStateResponse,
  healthResponse,
  proposalsResponse,
  questionsResponse,
  requestJson,
  searchResponse,
  timelineResponse,
  type Assertion,
  type CurrentState,
  type Decision,
  type Proposal,
  type Question,
  type SearchResults,
  type Session,
  type TimelineEntry,
} from "./api.ts";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { idAfterRemoval, inboxCommand, inboxFocus, movedId, type ReviewAction } from "./inbox.ts";

type ViewId = "review" | "search" | "timeline" | "state" | "ask";

type Composer =
  | { phase: "closed" }
  | {
      phase: "edit";
      proposalId: string;
      action: ReviewAction;
      reason: string;
      problem: string | null;
    }
  | { phase: "sending"; proposalId: string; action: ReviewAction; reason: string };

interface InboxRow {
  proposal: Proposal;
  phase: "in" | "out";
}

type HealthState =
  | { phase: "checking" }
  | { phase: "ok" }
  | { phase: "unreachable" }
  | { phase: "error"; message: string };

type TimelineState = { phase: "idle" } | { phase: "ready"; entries: TimelineEntry[] };

type MemoryState = { phase: "idle" } | { phase: "ready"; state: CurrentState };

type SearchState = { phase: "idle" } | { phase: "ready"; results: SearchResults };

type ToastState = { text: string; visible: boolean };

const API_BASE_KEY = "personal-os-api-base";
const TOKEN_KEY = "personal-os-access-token";
const TOAST_MS = 3200;
const REASON_HINT = "Enter で確定 ・ Esc で取り消し";
const EMPTY_REASON = "理由を入力してください。";
const PENDING_IDS: readonly string[] = ["nav-pending-count", "inbox-count"];

const ACTION_LABELS: Record<ReviewAction, string> = { approve: "承認", reject: "却下" };

const REASON_PLACEHOLDERS: Record<ReviewAction, string> = {
  approve: "例：本人の発言と一致している",
  reject: "例：根拠と内容が食い違っている",
};

const NAV: readonly { id: ViewId; label: string }[] = [
  { id: "review", label: "レビュー" },
  { id: "search", label: "検索" },
  { id: "timeline", label: "タイムライン" },
  { id: "state", label: "現在の状態" },
  { id: "ask", label: "質問" },
];

const PRIVACY_OPTIONS: readonly { value: string; label: string; checked: boolean }[] = [
  { value: "P0", label: "P0 公開", checked: true },
  { value: "P1", label: "P1 個人", checked: true },
  { value: "P2", label: "P2 機微", checked: false },
  { value: "P3", label: "P3 厳格", checked: false },
];

const ASK_KINDS: readonly { value: string; label: string }[] = [
  { value: "preference", label: "好み" },
  { value: "goal", label: "目標" },
  { value: "project", label: "プロジェクト" },
  { value: "artifact", label: "成果物" },
  { value: "research_topic", label: "研究テーマ" },
  { value: "value", label: "価値観" },
  { value: "belief", label: "信念" },
  { value: "constraint", label: "制約" },
];

const ASK_PRIVACY = ["P0", "P1", "P2", "P3"] as const;

function uuidV7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function checkedKinds(form: HTMLFormElement): string[] {
  return new FormData(form)
    .getAll("kind")
    .filter((value): value is string => typeof value === "string");
}

function loadSession(): Session {
  return {
    apiBase: (localStorage.getItem(API_BASE_KEY) ?? "").replace(/\/$/u, ""),
    accessToken: sessionStorage.getItem(TOKEN_KEY) ?? "",
  };
}

function saveSession(session: Session): void {
  localStorage.setItem(API_BASE_KEY, session.apiBase);
  sessionStorage.setItem(TOKEN_KEY, session.accessToken);
}

function readSession(form: HTMLFormElement): Session {
  const data = new FormData(form);
  const apiBase = data.get("apiBase");
  const accessToken = data.get("accessToken");
  return {
    apiBase: (typeof apiBase === "string" ? apiBase : "").trim().replace(/\/$/u, ""),
    accessToken: (typeof accessToken === "string" ? accessToken : "").trim(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "予期しないエラーです。";
}

function formatWhen(value: string): string {
  return new Date(value).toLocaleString("ja-JP");
}

function stateGroups(state: CurrentState): { kind: string; assertions: Assertion[] }[] {
  const grouped: Record<string, Assertion[]> = {
    preferences: state.preferences,
    ...state.intents,
  };
  return Object.entries(grouped).map(([kind, assertions]) => ({ kind, assertions }));
}

function memoryCount(state: CurrentState): number {
  return stateGroups(state).reduce((total, group) => total + group.assertions.length, 0);
}

function cardElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.inbox-card[data-proposal-id="${CSS.escape(id)}"]`);
}

function focusCard(card: HTMLElement): void {
  card.focus();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
}

function pulsePending(): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const id of PENDING_IDS) {
    document
      .getElementById(id)
      ?.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(1.18)", offset: 0.4 },
          { transform: "scale(1)" },
        ],
        { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
  }
}

function viewClass(active: boolean): string {
  return active ? "view" : "view hidden";
}

function cardClass(rejecting: boolean, leaving: boolean): string {
  const names = ["card", "inbox-card"];
  if (rejecting) names.push("composing--reject");
  if (leaving) names.push("leaving");
  return names.join(" ");
}

function healthClass(health: HealthState): string {
  switch (health.phase) {
    case "checking":
      return "health";
    case "ok":
      return "health api-connected";
    case "unreachable":
    case "error":
      return "health error";
    default: {
      const unexpected: never = health;
      throw new Error(String(unexpected));
    }
  }
}

function healthLabel(health: HealthState): string {
  switch (health.phase) {
    case "checking":
      return "接続を確認中";
    case "ok":
      return "API 接続済み";
    case "unreachable":
      return ApiUnreachableError.text;
    case "error":
      return health.message;
    default: {
      const unexpected: never = health;
      throw new Error(String(unexpected));
    }
  }
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

function NavIcon({ view }: { view: ViewId }) {
  switch (view) {
    case "review":
      return (
        <Icon>
          <path d="M9 11l2 2 4-4M5 4h14v16H5z" />
        </Icon>
      );
    case "search":
      return <SearchIcon />;
    case "timeline":
      return (
        <Icon>
          <path d="M12 7v5l3 2M4 12a8 8 0 1 0 2.3-5.7L4 8.6V4" />
        </Icon>
      );
    case "state":
      return (
        <Icon>
          <path d="M4 6h16M4 12h10M4 18h13" />
        </Icon>
      );
    case "ask":
      return (
        <Icon>
          <path d="M5 5h14v14H5z" />
        </Icon>
      );
    default: {
      const unexpected: never = view;
      throw new Error(String(unexpected));
    }
  }
}

function SearchIcon() {
  return (
    <Icon>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m16 16 4 4" />
    </Icon>
  );
}

function RefreshIcon() {
  return (
    <Icon>
      <path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.8-2L20 11M4 13l2.1 4a7 7 0 0 0 11.8-2" />
    </Icon>
  );
}

function OfflineNotice({ onReconnect }: { onReconnect: () => void }) {
  return (
    <section id="offline-notice" className="offline-notice" role="alert">
      <div>
        <strong>オフラインです</strong>
        <p>
          保存済みの画面を表示しています。API サーバー（ローカルでは{" "}
          <code>pnpm personal:serve</code>）を起動してから再接続してください。
        </p>
      </div>
      <Button type="button" size="sm" data-reconnect="" onClick={onReconnect}>
        再接続
      </Button>
    </section>
  );
}

function RefreshButton({
  target,
  onClick,
}: {
  target: "review" | "timeline" | "state";
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="icon-button"
      data-refresh={target}
      onClick={onClick}
    >
      <RefreshIcon />
      更新
    </Button>
  );
}

function Brand() {
  return (
    <a className="brand" href="#main" aria-label="Personal OS ホーム">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>
        <strong>Personal OS</strong>
      </span>
    </a>
  );
}

function MainNav({
  view,
  pendingText,
  onSelect,
}: {
  view: ViewId;
  pendingText: string;
  onSelect: (view: ViewId) => void;
}) {
  return (
    <nav className="primary-nav" aria-label="メインメニュー">
      {NAV.map((item) => (
        <button
          key={item.id}
          type="button"
          className={view === item.id ? "tab active" : "tab"}
          data-view={item.id}
          aria-controls={`${item.id}-view`}
          onClick={() => onSelect(item.id)}
        >
          <NavIcon view={item.id} />
          <span>{item.label}</span>
          {item.id === "review" ? <b id="nav-pending-count">{pendingText}</b> : null}
        </button>
      ))}
    </nav>
  );
}

const sidebarField = "border-[#343a32] bg-[#1a1d18] text-white placeholder:text-[#858d83]";

function ConnectionForm({
  session,
  onSubmit,
}: {
  session: Session;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <details className="connection-panel">
      <summary>
        <span className="connection-dot" />
        <span>
          <strong>API 設定</strong>
        </span>
        <Icon>
          <path d="m9 6 6 6-6 6" />
        </Icon>
      </summary>
      <form id="connection-form" className="connection-form" onSubmit={onSubmit}>
        <label htmlFor="api-base">API の URL</label>
        <Input
          id="api-base"
          name="apiBase"
          type="url"
          placeholder="同一オリジン"
          defaultValue={session.apiBase}
          className={sidebarField}
        />
        <label htmlFor="access-token">アクセストークン</label>
        <Input
          id="access-token"
          name="accessToken"
          type="password"
          autoComplete="off"
          placeholder="トークン"
          defaultValue={session.accessToken}
          className={sidebarField}
        />
        <p>トークンはこのタブを閉じると破棄されます。</p>
        <Button type="submit" className="w-full">
          接続を更新
        </Button>
      </form>
    </details>
  );
}

function InboxEmpty({ loaded }: { loaded: boolean }) {
  if (!loaded) {
    return (
      <div className="empty-state">
        <div>
          <span className="empty-state-icon">
            <Icon>
              <path d="M5 4h14v16H5zM9 9h6M9 13h4" />
            </Icon>
          </span>
          <h3>API に接続してください</h3>
        </div>
      </div>
    );
  }
  return (
    <div className="empty-state inbox-empty">
      <div>
        <span className="empty-state-icon">
          <Icon>
            <path d="m7 12 3 3 7-7" />
            <circle cx="12" cy="12" r="9" />
          </Icon>
        </span>
        <h3>すべて確認済みです</h3>
        <code className="empty-command">pnpm personal evidence import {"<file>"}</code>
      </div>
    </div>
  );
}

function ReasonForm({
  action,
  reason,
  problem,
  busy,
  onReason,
  onSubmit,
  onCancel,
}: {
  action: ReviewAction;
  reason: string;
  problem: string | null;
  busy: boolean;
  onReason: (reason: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const label = ACTION_LABELS[action];
  return (
    <form className="reason-form" data-action={action} noValidate onSubmit={onSubmit}>
      <label htmlFor="reason-input">{label}する理由</label>
      <div className="reason-row">
        <Input
          id="reason-input"
          name="reason"
          autoComplete="off"
          placeholder={REASON_PLACEHOLDERS[action]}
          aria-describedby="reason-hint"
          value={reason}
          disabled={busy}
          onChange={(event) => onReason(event.target.value)}
          {...(problem === EMPTY_REASON ? { "aria-invalid": true } : {})}
        />
        <Button
          type="submit"
          variant={action === "approve" ? "default" : "destructive"}
          disabled={busy}
        >
          {label}を確定
        </Button>
        <Button
          type="button"
          variant="outline"
          data-cancel-review=""
          disabled={busy}
          onClick={onCancel}
        >
          キャンセル
        </Button>
      </div>
      <p id="reason-hint" className={problem === null ? "reason-hint" : "reason-hint error"}>
        {problem ?? REASON_HINT}
      </p>
    </form>
  );
}

function ProposalCard({
  row,
  index,
  composer,
  onCompose,
  onCancel,
  onSubmit,
  onReason,
  onLeft,
}: {
  row: InboxRow;
  index: number;
  composer: Composer;
  onCompose: (proposalId: string, action: ReviewAction) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onReason: (reason: string) => void;
  onLeft: (proposalId: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);
  const onLeftRef = useRef(onLeft);
  onLeftRef.current = onLeft;
  const proposal = row.proposal;
  const open = composer.phase !== "closed" && composer.proposalId === proposal.id ? composer : null;
  const busy = open?.phase === "sending";
  const rejecting = open !== null && open.action === "reject";

  useLayoutEffect(() => {
    ref.current?.style.setProperty("--i", String(index));
  }, [index, lockedHeight]);

  useLayoutEffect(() => {
    if (row.phase !== "out" || lockedHeight !== null) return;
    const card = ref.current;
    if (card === null) return;
    setLockedHeight(card.offsetHeight);
  }, [row.phase, lockedHeight]);

  useLayoutEffect(() => {
    if (row.phase !== "out" || lockedHeight === null) return undefined;
    const card = ref.current;
    if (card === null) return undefined;
    let cancelled = false;
    void card.offsetHeight;
    const animations = card.getAnimations();
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!cancelled) onLeftRef.current(proposal.id);
    });
    return () => {
      cancelled = true;
    };
  }, [row.phase, lockedHeight, proposal.id]);

  return (
    <article
      ref={ref}
      className={cardClass(rejecting, lockedHeight !== null)}
      style={lockedHeight === null ? undefined : { height: lockedHeight }}
      tabIndex={0}
      data-proposal-id={proposal.id}
      aria-labelledby={`proposal-title-${proposal.id}`}
      aria-describedby="review-shortcuts"
      {...(busy ? { "aria-busy": true } : {})}
    >
      <div>
        <p className="card-tags">
          <Badge variant="outline">{proposal.assertion.kind}</Badge>
          <Badge variant="outline">{proposal.assertion.privacy}</Badge>
        </p>
        <h3 id={`proposal-title-${proposal.id}`}>{proposal.assertion.object}</h3>
        <p className="meta">
          根拠 {proposal.assertion.evidenceIds.length} 件 ・ {formatWhen(proposal.createdAt)}
        </p>
      </div>
      <div className="actions">
        <Button
          type="button"
          size="sm"
          data-compose="approve"
          onClick={() => onCompose(proposal.id, "approve")}
        >
          承認<kbd>A</kbd>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="reject"
          data-compose="reject"
          onClick={() => onCompose(proposal.id, "reject")}
        >
          却下<kbd>R</kbd>
        </Button>
      </div>
      {open === null ? null : (
        <ReasonForm
          action={open.action}
          reason={open.reason}
          problem={open.phase === "edit" ? open.problem : null}
          busy={open.phase === "sending"}
          onReason={onReason}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      )}
    </article>
  );
}

function AssertionCard({ assertion }: { assertion: Assertion }) {
  return (
    <article className="result">
      <Badge variant="outline">{assertion.kind}</Badge>
      <Badge variant="outline">{assertion.privacy}</Badge>
      <h3>{assertion.object}</h3>
      <p className="meta">
        {formatWhen(assertion.validFrom)} から有効 ・ {assertion.id}
      </p>
    </article>
  );
}

function DecisionCard({ decision }: { decision: Decision }) {
  return (
    <article className="result">
      <Badge variant="outline">decision</Badge>
      <h3>{decision.problem}</h3>
      <p>{decision.rationale}</p>
    </article>
  );
}

function SearchResultsList({ search }: { search: SearchState }) {
  if (search.phase !== "ready") return null;
  const { assertions, decisions } = search.results;
  if (assertions.length === 0 && decisions.length === 0) {
    return (
      <div className="empty-state">
        <div>
          <h3>根拠のある記憶が見つかりませんでした</h3>
          <p>検索語またはプライバシークラスを変えて、もう一度お試しください。</p>
        </div>
      </div>
    );
  }
  return (
    <>
      {assertions.map((assertion) => (
        <AssertionCard key={assertion.id} assertion={assertion} />
      ))}
      {decisions.map((decision, index) => (
        <DecisionCard key={`${decision.problem}-${index}`} decision={decision} />
      ))}
    </>
  );
}

function TimelineList({ timeline }: { timeline: TimelineState }) {
  if (timeline.phase === "idle") {
    return (
      <li>
        <div>
          <strong>接続待ち</strong>
        </div>
        <div>
          <p className="meta">API 接続後に監査イベントを読み込みます。</p>
        </div>
      </li>
    );
  }
  if (timeline.entries.length === 0) {
    return (
      <li>
        <div>
          <strong>履歴はまだありません</strong>
        </div>
        <div>
          <p className="meta">最初の Evidence を取り込むと、監査イベントが表示されます。</p>
        </div>
      </li>
    );
  }
  return timeline.entries.map((entry, index) => (
    <li key={`${entry.occurredAt}-${entry.entityId}-${index}`}>
      <div>
        <strong>{entry.operation}</strong> <Badge variant="outline">{entry.privacy}</Badge>
        <p className="meta">{formatWhen(entry.occurredAt)}</p>
      </div>
      <div>
        <p>{entry.reason}</p>
        <p className="meta">実行者：{entry.actor}</p>
        <code>
          {entry.entityType}:{entry.entityId}
        </code>
      </div>
    </li>
  ));
}

function StatePanels({ memory }: { memory: MemoryState }) {
  if (memory.phase === "idle") {
    return (
      <section className="state-group">
        <p className="meta">API 接続後に現在の状態を読み込みます。</p>
      </section>
    );
  }
  return stateGroups(memory.state).map((group) => (
    <section className="state-group" key={group.kind}>
      <h3>
        {group.kind.replaceAll("_", " ")} <span className="meta">{group.assertions.length}</span>
      </h3>
      <div className="stack">
        {group.assertions.length === 0 ? (
          <p className="meta">有効な項目はありません。</p>
        ) : (
          group.assertions.map((assertion) => (
            <AssertionCard key={assertion.id} assertion={assertion} />
          ))
        )}
      </div>
    </section>
  ));
}

function QuestionForm({
  question,
  index,
  onSubmit,
}: {
  question: Question;
  index: number;
  onSubmit: (event: FormEvent<HTMLFormElement>, question: Question) => void | Promise<void>;
}) {
  const answerId = `ask-answer-${index}`;
  return (
    <form className="search-panel result" onSubmit={(event) => void onSubmit(event, question)}>
      <h3>
        <label htmlFor={answerId}>{question.prompt}</label>
      </h3>
      <div className="search-input-wrap">
        <Input id={answerId} name="answer" required />
        <Button type="submit">送る</Button>
      </div>
      <fieldset>
        <legend>区分</legend>
        {ASK_PRIVACY.map((privacy) => (
          <label key={privacy}>
            <input type="radio" name="privacy" value={privacy} defaultChecked={privacy === "P1"} />
            <span>{privacy}</span>
          </label>
        ))}
      </fieldset>
    </form>
  );
}

export function Console() {
  const [session, setSession] = useState(loadSession);
  const [health, setHealth] = useState<HealthState>({ phase: "checking" });
  const [view, setView] = useState<ViewId>("review");
  const [inboxLoaded, setInboxLoaded] = useState(false);
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [timeline, setTimeline] = useState<TimelineState>({ phase: "idle" });
  const [memory, setMemory] = useState<MemoryState>({ phase: "idle" });
  const [search, setSearch] = useState<SearchState>({ phase: "idle" });
  const [askedKinds, setAskedKinds] = useState<readonly string[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [composer, setComposer] = useState<Composer>({ phase: "closed" });
  const [toast, setToast] = useState<ToastState | null>(null);
  const focusReason = useRef(false);
  const submitting = useRef(false);
  const answering = useRef(false);
  const askRequest = useRef(0);
  const rowsRef = useRef(rows);
  const viewRef = useRef(view);
  const composerRef = useRef(composer);
  const previousPending = useRef<string | null>(null);
  const openComposerRef = useRef<(proposalId: string, action: ReviewAction) => void>(
    () => undefined,
  );
  const closeComposerRef = useRef<() => void>(() => undefined);
  rowsRef.current = rows;
  viewRef.current = view;
  composerRef.current = composer;

  const pendingText = inboxLoaded ? String(rows.filter((row) => row.phase === "in").length) : "—";
  const timelineText = timeline.phase === "ready" ? String(timeline.entries.length) : "—";
  const memoryText = memory.phase === "ready" ? String(memoryCount(memory.state)) : "—";

  function showToast(text: string): void {
    setToast({ text, visible: true });
  }

  async function reloadHealth(current: Session): Promise<void> {
    try {
      healthResponse(await requestJson(current, "/health"));
      setHealth({ phase: "ok" });
    } catch (error: unknown) {
      setHealth(
        error instanceof ApiUnreachableError
          ? { phase: "unreachable" }
          : { phase: "error", message: errorMessage(error) },
      );
    }
  }

  async function reloadProposals(current: Session): Promise<void> {
    try {
      const proposals = proposalsResponse(
        await requestJson(current, "/v1/proposals?status=pending"),
      );
      setInboxLoaded(true);
      setRows(proposals.map((proposal) => ({ proposal, phase: "in" })));
      setComposer({ phase: "closed" });
    } catch (error: unknown) {
      showToast(errorMessage(error));
    }
  }

  async function reloadTimeline(current: Session, notify: boolean): Promise<void> {
    try {
      const entries = timelineResponse(
        await requestJson(current, "/v1/timeline?privacy=P0,P1,P2,P3&limit=100"),
      );
      setTimeline({ phase: "ready", entries });
    } catch (error: unknown) {
      if (notify) showToast(errorMessage(error));
    }
  }

  async function reloadMemory(current: Session, notify: boolean): Promise<void> {
    try {
      setMemory({
        phase: "ready",
        state: currentStateResponse(
          await requestJson(current, "/v1/self/current?privacy=P0,P1,P2,P3"),
        ),
      });
    } catch (error: unknown) {
      if (notify) showToast(errorMessage(error));
    }
  }

  function openComposer(proposalId: string, action: ReviewAction): void {
    const row = rowsRef.current.find((item) => item.proposal.id === proposalId);
    if (row === undefined || row.phase !== "in") return;
    focusReason.current = true;
    setComposer({ phase: "edit", proposalId, action, reason: "", problem: null });
  }

  function closeComposer(): void {
    const current = composerRef.current;
    if (current.phase === "closed") return;
    const card = cardElement(current.proposalId);
    setComposer({ phase: "closed" });
    if (card !== null) focusCard(card);
  }

  function dismiss(id: string): void {
    const current = rowsRef.current;
    if (!current.some((row) => row.proposal.id === id && row.phase === "in")) return;
    const ids = current.filter((row) => row.phase === "in").map((row) => row.proposal.id);
    const nextId = idAfterRemoval(ids, id);
    if (nextId !== null) {
      const next = cardElement(nextId);
      if (next !== null) focusCard(next);
    }
    const nextRows = current.map((row): InboxRow =>
      row.proposal.id === id ? { proposal: row.proposal, phase: "out" } : row,
    );
    rowsRef.current = nextRows;
    setRows(nextRows);
  }

  function dropRow(id: string): void {
    const next = rowsRef.current.filter((row) => row.proposal.id !== id);
    rowsRef.current = next;
    setRows(next);
    setComposer((current) =>
      current.phase !== "closed" && current.proposalId === id ? { phase: "closed" } : current,
    );
    if (next.length === 0) document.querySelector<HTMLElement>("#review-title")?.focus();
  }

  function onReason(reason: string): void {
    setComposer((current) => {
      if (current.phase !== "edit") return current;
      if (current.problem !== EMPTY_REASON) return { ...current, reason };
      return { ...current, reason, problem: null };
    });
  }

  async function submitReview(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting.current) return;
    const current = composerRef.current;
    if (current.phase !== "edit") return;
    const reason = current.reason.trim();
    if (reason.length === 0) {
      setComposer({ ...current, problem: EMPTY_REASON });
      document.querySelector<HTMLInputElement>("#reason-input")?.focus();
      return;
    }
    submitting.current = true;
    setComposer({
      phase: "sending",
      proposalId: current.proposalId,
      action: current.action,
      reason: current.reason,
    });
    try {
      await requestJson(
        session,
        `/v1/proposals/${encodeURIComponent(current.proposalId)}/${current.action}`,
        { actor: "web-owner", reason },
      );
    } catch (error: unknown) {
      submitting.current = false;
      const message = errorMessage(error);
      setComposer((latest) => {
        if (latest.phase !== "sending" || latest.proposalId !== current.proposalId) return latest;
        return {
          phase: "edit",
          proposalId: current.proposalId,
          action: current.action,
          reason: current.reason,
          problem: message,
        };
      });
      document.querySelector<HTMLInputElement>("#reason-input")?.focus();
      return;
    }
    showToast(`提案を${ACTION_LABELS[current.action]}しました。`);
    void reloadTimeline(session, false);
    void reloadMemory(session, false);
    dismiss(current.proposalId);
    submitting.current = false;
  }

  function reconnect(current: Session): void {
    void reloadHealth(current);
    void reloadProposals(current);
    void reloadTimeline(current, false);
    void reloadMemory(current, false);
  }

  function selectView(next: ViewId): void {
    setView(next);
    if (next === "timeline") void reloadTimeline(session, true);
    if (next === "state") void reloadMemory(session, true);
  }

  function onConnect(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const next = readSession(event.currentTarget);
    saveSession(next);
    setSession(next);
    reconnect(next);
  }

  async function loadQuestions(current: Session, kinds: readonly string[]): Promise<void> {
    const requestId = askRequest.current + 1;
    askRequest.current = requestId;
    if (kinds.length === 0) {
      setQuestions([]);
      return;
    }
    try {
      const next = questionsResponse(
        await requestJson(current, `/v1/questions?kinds=${encodeURIComponent(kinds.join(","))}`),
      );
      if (askRequest.current !== requestId) return;
      setQuestions(next);
    } catch (error: unknown) {
      if (askRequest.current !== requestId) return;
      showToast(errorMessage(error));
    }
  }

  function changeAskedKinds(event: FormEvent<HTMLFormElement>): void {
    const kinds = checkedKinds(event.currentTarget);
    setAskedKinds(kinds);
    void loadQuestions(session, kinds);
  }

  async function submitAnswer(
    event: FormEvent<HTMLFormElement>,
    question: Question,
  ): Promise<void> {
    event.preventDefault();
    if (answering.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const answerValue = data.get("answer");
    const privacyValue = data.get("privacy");
    const answer = typeof answerValue === "string" ? answerValue : "";
    const privacy = typeof privacyValue === "string" ? privacyValue : "P1";
    answering.current = true;
    try {
      const evidenceId = createdEvidenceId(
        await requestJson(session, "/v1/evidence", {
          content: answer,
          sourceType: "plain_text",
          sourceUri: null,
          occurredAt: null,
          author: null,
          privacy,
          mediaType: "text/plain",
          actor: "web-owner",
          reason: "質問への回答",
        }),
      );
      await requestJson(session, "/v1/proposals", {
        subjectId: uuidV7(),
        kind: question.kind,
        object: answer,
        evidenceIds: [evidenceId],
        epistemicOrigin: "self_stated",
        validFrom: new Date().toISOString(),
        validUntil: null,
        privacy,
        createdBy: "user",
        actor: "web-owner",
        reason: "質問への回答",
      });
      form.reset();
      await loadQuestions(session, askedKinds);
    } catch (error: unknown) {
      showToast(errorMessage(error));
    } finally {
      answering.current = false;
    }
  }

  async function onSearch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const queryValue = data.get("query");
    const query = typeof queryValue === "string" ? queryValue : "";
    const privacy = data
      .getAll("privacy")
      .filter((value): value is string => typeof value === "string");
    try {
      setSearch({
        phase: "ready",
        results: searchResponse(await requestJson(session, "/v1/search", { query, privacy })),
      });
    } catch (error: unknown) {
      showToast(errorMessage(error));
    }
  }

  openComposerRef.current = openComposer;
  closeComposerRef.current = closeComposer;

  useEffect(() => {
    reconnect(loadSession());
    const onOnline = (): void => {
      reconnect(loadSession());
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("api-connected", health.phase === "ok");
  }, [health.phase]);

  useEffect(() => {
    if (toast === null || !toast.visible) return undefined;
    const timeout = window.setTimeout(() => {
      setToast((current) => (current === null ? current : { ...current, visible: false }));
    }, TOAST_MS);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const previous = previousPending.current;
    previousPending.current = pendingText;
    if (previous === null || previous === pendingText) return;
    pulsePending();
  }, [pendingText]);

  useLayoutEffect(() => {
    if (!focusReason.current) return;
    focusReason.current = false;
    document.querySelector<HTMLInputElement>("#reason-input")?.focus();
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const focus = inboxFocus({
        key: event.key,
        inReasonForm: target.closest(".reason-form") !== null,
        typing: target.closest("input, textarea, select, [contenteditable]") !== null,
      });
      if (focus === "dismiss") {
        event.preventDefault();
        closeComposerRef.current();
        return;
      }
      if (focus === "ignore") return;
      if (viewRef.current !== "review") return;
      const command = inboxCommand(event);
      if (command === null) return;
      const card = target.closest<HTMLElement>(".inbox-card");
      if (command.type === "compose") {
        if (card === null) return;
        const proposalId = card.dataset.proposalId;
        if (proposalId === undefined) return;
        event.preventDefault();
        openComposerRef.current(proposalId, command.action);
        return;
      }
      const main = document.querySelector("#main");
      const fromPage =
        target === document.body || target === main || target.closest("#review-view") !== null;
      if (card === null && (!fromPage || event.key.startsWith("Arrow"))) return;
      const ids = rowsRef.current.filter((row) => row.phase === "in").map((row) => row.proposal.id);
      const nextId = movedId(ids, card?.dataset.proposalId ?? null, command.delta);
      if (nextId === null) return;
      const next = cardElement(nextId);
      if (next === null) return;
      event.preventDefault();
      focusCard(next);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <a className="skip-link" href="#main">
        本文へ移動
      </a>
      <div className="app-shell">
        <aside className="sidebar">
          <Brand />
          <MainNav view={view} pendingText={pendingText} onSelect={selectView} />
          <div className="sidebar-bottom">
            <ConnectionForm session={session} onSubmit={onConnect} />
            <p className="build-label">v1.0.0-rc.1</p>
          </div>
        </aside>
        <main id="main" className="main-content" tabIndex={-1}>
          <header className="topbar">
            <h1>Personal OS</h1>
            <div id="health" className={healthClass(health)} role="status">
              <span className="health-dot" />
              <span>{healthLabel(health)}</span>
            </div>
          </header>
          {health.phase === "unreachable" ? (
            <OfflineNotice onReconnect={() => reconnect(session)} />
          ) : null}
          <section
            id="review-view"
            className={viewClass(view === "review")}
            aria-labelledby="review-title"
          >
            <div className="section-heading">
              <h2 id="review-title" tabIndex={-1}>
                審査待ちの提案{" "}
                <span id="inbox-count" className="inbox-count">
                  {pendingText}
                </span>
              </h2>
              <RefreshButton target="review" onClick={() => void reloadProposals(session)} />
            </div>
            <p
              id="review-shortcuts"
              className="shortcut-hint"
              hidden={!rows.some((row) => row.phase === "in")}
            >
              <span>
                <kbd>J</kbd>
                <kbd>K</kbd> で移動
              </span>
              <span>
                <kbd>A</kbd> で承認
              </span>
              <span>
                <kbd>R</kbd> で却下
              </span>
              <span>
                <kbd>Esc</kbd> で取り消し
              </span>
            </p>
            <div id="proposal-list" className="review-list" aria-live="polite">
              {rows.length === 0 ? (
                <InboxEmpty loaded={inboxLoaded} />
              ) : (
                rows.map((row, index) => (
                  <ProposalCard
                    key={row.proposal.id}
                    row={row}
                    index={index}
                    composer={composer}
                    onCompose={openComposer}
                    onCancel={closeComposer}
                    onSubmit={(event) => void submitReview(event)}
                    onReason={onReason}
                    onLeft={dropRow}
                  />
                ))
              )}
            </div>
          </section>
          <section
            id="search-view"
            className={viewClass(view === "search")}
            aria-labelledby="search-title"
          >
            <div className="section-heading">
              <h2 id="search-title">記憶を検索</h2>
            </div>
            <form
              id="search-form"
              className="search-panel"
              onSubmit={(event) => void onSearch(event)}
            >
              <label htmlFor="query">質問またはキーワード</label>
              <div className="search-input-wrap">
                <SearchIcon />
                <Input
                  id="query"
                  name="query"
                  required
                  placeholder="例：いま優先している研究テーマは？"
                  className="pl-10"
                />
                <Button type="submit">検索</Button>
              </div>
              <fieldset>
                <legend>検索に含めるプライバシークラス</legend>
                {PRIVACY_OPTIONS.map((option) => (
                  <label key={option.value}>
                    <input
                      type="checkbox"
                      name="privacy"
                      value={option.value}
                      defaultChecked={option.checked}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </fieldset>
            </form>
            <div id="search-results" className="result-list" aria-live="polite">
              <SearchResultsList search={search} />
            </div>
          </section>
          <section
            id="timeline-view"
            className={viewClass(view === "timeline")}
            aria-labelledby="timeline-title"
          >
            <div className="section-heading">
              <h2 id="timeline-title">
                監査タイムライン{" "}
                <span id="timeline-count" className="inbox-count">
                  {timelineText}
                </span>
              </h2>
              <RefreshButton target="timeline" onClick={() => void reloadTimeline(session, true)} />
            </div>
            <ol id="timeline-list" className="timeline" aria-live="polite">
              <TimelineList timeline={timeline} />
            </ol>
          </section>
          <section
            id="state-view"
            className={viewClass(view === "state")}
            aria-labelledby="state-title"
          >
            <div className="section-heading">
              <h2 id="state-title">
                現在の状態{" "}
                <span id="memory-count" className="inbox-count">
                  {memoryText}
                </span>
              </h2>
              <RefreshButton target="state" onClick={() => void reloadMemory(session, true)} />
            </div>
            <div id="state-content" className="state-grid" aria-live="polite">
              <StatePanels memory={memory} />
            </div>
          </section>
          <section id="ask-view" className={viewClass(view === "ask")} aria-labelledby="ask-title">
            <div className="section-heading">
              <h2 id="ask-title">質問</h2>
            </div>
            <form
              id="ask-kinds"
              className="search-panel"
              onSubmit={(event) => event.preventDefault()}
              onChange={(event) => changeAskedKinds(event)}
            >
              <fieldset>
                <legend>種類</legend>
                {ASK_KINDS.map((kind) => (
                  <label key={kind.value}>
                    <input type="checkbox" name="kind" value={kind.value} />
                    <span>{kind.label}</span>
                  </label>
                ))}
              </fieldset>
            </form>
            {questions.length === 0 ? null : (
              <div className="result-list">
                {questions.map((question, index) => (
                  <QuestionForm
                    key={`${question.kind}-${question.code}-${index}`}
                    question={question}
                    index={index}
                    onSubmit={submitAnswer}
                  />
                ))}
              </div>
            )}
          </section>
        </main>
        <div
          id="toast"
          className={toast?.visible === true ? "toast visible" : "toast"}
          role="status"
          aria-live="polite"
        >
          {toast?.text ?? ""}
        </div>
      </div>
    </>
  );
}
