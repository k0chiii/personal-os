import {
  IconCheckbox,
  IconChevronRight,
  IconHistory,
  IconList,
  IconMenu2,
  IconMessage,
  IconMessageQuestion,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import type { Icon } from "@tabler/icons-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, PointerEvent as ReactPointerEvent } from "react";

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
  type Proposal,
  type Question,
  type Session,
  type TimelineEntry,
} from "./api.ts";
import {
  emptyTranscript,
  fail,
  retry,
  send,
  settle,
  visible,
  type Handoff,
  type Transcript,
  type Turn,
  type TurnId,
} from "./dialogue.ts";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group.tsx";
import { idAfterRemoval, inboxCommand, inboxFocus, movedId, type ReviewAction } from "./inbox.ts";

type ViewId = "review" | "dialogue" | "timeline" | "state" | "ask";

type Deck = "front" | "back" | "rest" | "out";

interface InboxRow {
  proposal: Proposal;
  phase: "in" | "out";
  leave?: ReviewAction;
}

type HealthState =
  | { phase: "checking" }
  | { phase: "ok" }
  | { phase: "unreachable" }
  | { phase: "error"; message: string };

type TimelineState = { phase: "idle" } | { phase: "ready"; entries: TimelineEntry[] };

type MemoryState = { phase: "idle" } | { phase: "ready"; state: CurrentState };

type ToastState = { text: string; visible: boolean };

const API_BASE_KEY = "personal-os-api-base";
const TOKEN_KEY = "personal-os-access-token";
const TOAST_MS = 3200;
const SWIPE_PX = 108;
const PENDING_IDS: readonly string[] = ["nav-pending-count", "inbox-count"];

const ACTION_LABELS: Record<ReviewAction, string> = { approve: "承認", reject: "却下" };

const NAV: readonly { id: ViewId; label: string }[] = [
  { id: "review", label: "レビュー" },
  { id: "dialogue", label: "対話" },
  { id: "timeline", label: "タイムライン" },
  { id: "state", label: "現在の状態" },
  { id: "ask", label: "質問" },
];

const SEARCH_PRIVACY = ["P0", "P1", "P2", "P3"] as const;

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

function frontCardId(): string | null {
  return document.querySelector<HTMLElement>(".inbox-card.deck-front")?.dataset.proposalId ?? null;
}

function deckFor(row: InboxRow, rows: readonly InboxRow[]): Deck {
  if (row.phase === "out") return "out";
  const pending = rows.filter((item) => item.phase === "in");
  const place = pending.findIndex((item) => item.proposal.id === row.proposal.id);
  if (place === 0) return "front";
  if (place === 1) return "back";
  return "rest";
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

function cardClass(deck: Deck, dragging: boolean): string {
  const names = ["card", "inbox-card", `deck-${deck}`];
  if (deck === "out") names.push("leaving");
  if (dragging) names.push("dragging");
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

const NAV_ICONS = {
  review: IconCheckbox,
  dialogue: IconMessage,
  timeline: IconHistory,
  state: IconList,
  ask: IconMessageQuestion,
} as const satisfies Record<ViewId, Icon>;

function NavIcon({ view }: { view: ViewId }) {
  const Glyph = NAV_ICONS[view];
  return <Glyph size={20} stroke={1.75} aria-hidden="true" />;
}

function OfflineNotice({ onReconnect }: { onReconnect: () => void }) {
  return (
    <section id="offline-notice" className="offline-notice" role="alert">
      <strong>オフラインです</strong>
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
      <IconRefresh size={16} stroke={1.75} aria-hidden="true" />
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
        <IconChevronRight size={16} stroke={1.75} aria-hidden="true" />
      </summary>
      <form id="connection-form" className="connection-form" onSubmit={onSubmit}>
        <label htmlFor="api-base">API の URL</label>
        <Input
          id="api-base"
          name="apiBase"
          type="url"
          placeholder="同一オリジン"
          defaultValue={session.apiBase}
        />
        <label htmlFor="access-token">アクセストークン</label>
        <Input
          id="access-token"
          name="accessToken"
          type="password"
          autoComplete="off"
          placeholder="トークン"
          defaultValue={session.accessToken}
        />
        <Button type="submit" className="w-full">
          接続を更新
        </Button>
      </form>
    </details>
  );
}

function ProposalCard({
  row,
  index,
  deck,
  busy,
  onReview,
  onLeft,
}: {
  row: InboxRow;
  index: number;
  deck: Deck;
  busy: boolean;
  onReview: (proposalId: string, action: ReviewAction, draft: string) => Promise<boolean>;
  onLeft: (proposalId: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; pointerId: number; active: boolean } | null>(null);
  const offsetRef = useRef(0);
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState(row.proposal.assertion.object);
  const onLeftRef = useRef(onLeft);
  const onReviewRef = useRef(onReview);
  onLeftRef.current = onLeft;
  onReviewRef.current = onReview;
  const proposal = row.proposal;

  function moveTo(value: number): void {
    offsetRef.current = value;
    setOffset(value);
  }

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

  function decide(action: ReviewAction): void {
    if (busy || row.phase !== "in") return;
    const mobile = window.matchMedia("(max-width: 900px)").matches;
    if (action === "approve" && draft.trim().length === 0) {
      setDragging(false);
      moveTo(0);
      void onReviewRef.current(proposal.id, action, draft);
      return;
    }
    if (!mobile) {
      void onReviewRef.current(proposal.id, action, draft);
      return;
    }
    setDragging(false);
    moveTo(action === "approve" ? window.innerWidth : -window.innerWidth);
    void onReviewRef.current(proposal.id, action, draft).then((ok) => {
      if (!ok) moveTo(0);
    });
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>): void {
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    if (deck !== "front" || busy || event.button !== 0) return;
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("button, textarea, input, a") !== null) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      active: false,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>): void {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.active) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        drag.current = null;
        return;
      }
      current.active = true;
      setDragging(true);
    }
    offsetRef.current = dx;
    setOffset(dx);
    const native = event.nativeEvent;
    if (
      current.active &&
      native instanceof PointerEvent &&
      native.isTrusted &&
      !event.currentTarget.hasPointerCapture(native.pointerId)
    ) {
      try {
        event.currentTarget.setPointerCapture(native.pointerId);
      } catch {
        // The pointer is no longer active.
      }
    }
  }

  function onPointerEnd(event: ReactPointerEvent<HTMLElement>): void {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (!current.active) return;
    const dx = offsetRef.current;
    if (dx >= SWIPE_PX) decide("approve");
    else if (dx <= -SWIPE_PX) decide("reject");
    else moveTo(0);
  }

  const tilt = Math.max(-12, Math.min(12, offset / 18));
  const moving = row.phase === "in" && offset !== 0;

  return (
    <article
      ref={ref}
      className={cardClass(deck, dragging)}
      style={{
        ...(lockedHeight === null ? {} : { height: lockedHeight }),
        ...(moving ? { transform: `translateX(${offset}px) rotate(${tilt}deg)` } : {}),
      }}
      tabIndex={0}
      data-proposal-id={proposal.id}
      data-leave={row.leave}
      aria-labelledby={`proposal-title-${proposal.id}`}
      {...(busy ? { "aria-busy": true } : {})}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <span className={offset > 24 ? "swipe-stamp approve show" : "swipe-stamp approve"}>承認</span>
      <span className={offset < -24 ? "swipe-stamp reject show" : "swipe-stamp reject"}>却下</span>
      <div>
        <p className="card-tags">
          <Badge variant="outline">{proposal.assertion.kind}</Badge>
          <Badge variant="outline">{proposal.assertion.privacy}</Badge>
        </p>
        <label id={`proposal-title-${proposal.id}`} className="card-edit-label">
          <textarea
            className="card-edit"
            rows={3}
            value={draft}
            aria-label="内容"
            disabled={busy || row.phase !== "in"}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <p className="meta">
          根拠 {proposal.assertion.evidenceIds.length} 件 ・ {formatWhen(proposal.createdAt)}
        </p>
      </div>
      <div className="actions">
        <Button
          type="button"
          size="sm"
          data-compose="approve"
          disabled={busy || row.phase !== "in"}
          onClick={() => decide("approve")}
        >
          承認<kbd>A</kbd>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-compose="reject"
          disabled={busy || row.phase !== "in"}
          onClick={() => decide("reject")}
        >
          却下<kbd>R</kbd>
        </Button>
      </div>
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

function DialogueScreen({ session, active }: { session: Session; active: boolean }) {
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [draft, setDraft] = useState("");
  // setState updaters run after the handler returns, so the fetch starts from this ref.
  const transcriptRef = useRef(transcript);

  async function complete(sendingId: TurnId, query: string): Promise<void> {
    try {
      const results = searchResponse(
        await requestJson(session, "/v1/search", { query, privacy: SEARCH_PRIVACY }),
      );
      setTranscript((current) => {
        const next = settle(current, sendingId, results);
        transcriptRef.current = next;
        return next;
      });
    } catch (error: unknown) {
      const message = errorMessage(error);
      setTranscript((current) => {
        const next = fail(current, sendingId, { message });
        transcriptRef.current = next;
        return next;
      });
    }
  }

  function commit(
    next: (current: Transcript) => Handoff,
  ): Extract<Turn, { phase: "sending" }> | null {
    const handoff = next(transcriptRef.current);
    if (!handoff.accepted) return null;
    transcriptRef.current = handoff.transcript;
    setTranscript(handoff.transcript);
    return handoff.sending;
  }

  function onSend(text: string): void {
    const sending = commit((current) => send(current, text));
    if (sending === null) return;
    if (draft === text) setDraft("");
    void complete(sending.id, sending.owner.text);
  }

  function onRetry(): void {
    const sending = commit((current) => retry(current));
    if (sending === null) return;
    void complete(sending.id, sending.owner.text);
  }

  return (
    <DialogueView
      active={active}
      transcript={transcript}
      draft={draft}
      onDraft={setDraft}
      onSend={onSend}
      onRetry={onRetry}
    />
  );
}

function DialogueView({
  active,
  transcript,
  draft,
  onDraft,
  onSend,
  onRetry,
}: {
  active: boolean;
  transcript: Transcript;
  draft: string;
  onDraft: (value: string) => void;
  onSend: (text: string) => void;
  onRetry: () => void;
}) {
  const rows = visible(transcript);
  const sending = transcript.open.phase === "sending";
  const logRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const log = logRef.current;
    if (log === null) return;
    log.scrollTop = log.scrollHeight;
  }, [active, transcript]);
  return (
    <section
      id="dialogue-view"
      className={`${viewClass(active)} dialogue`}
      aria-labelledby="dialogue-title"
    >
      <h2 id="dialogue-title">対話</h2>
      <div
        ref={logRef}
        className="dialogue-log"
        role="log"
        aria-live="polite"
        aria-label="対話の記録"
      >
        {rows.length === 0 ? <p className="meta">送ると、記憶にある文が返答になります。</p> : null}
        {rows.map((turn) => (
          <article key={turn.id}>
            <p className="dialogue-owner">{turn.owner.text}</p>
            {turn.phase === "sending" ? <p className="dialogue-system">探しています</p> : null}
            {turn.phase === "reply"
              ? turn.system.paragraphs.map((paragraph, index) => (
                  <p key={index} className="dialogue-system">
                    {paragraph}
                  </p>
                ))
              : null}
            {turn.phase === "failed" ? (
              <div className="dialogue-system">
                <p>送れませんでした。</p>
                <p>{turn.failure.message}</p>
                {transcript.open.phase === "failed" && transcript.open.id === turn.id ? (
                  <button type="button" onClick={onRetry}>
                    もう一度送る
                  </button>
                ) : null}
              </div>
            ) : null}
          </article>
        ))}
      </div>
      <form
        className="dialogue-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSend(draft);
        }}
      >
        <label htmlFor="dialogue-draft">メッセージ</label>
        <textarea
          id="dialogue-draft"
          value={draft}
          placeholder="記憶に聞く"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
        <button type="submit" disabled={sending}>
          送る
        </button>
      </form>
    </section>
  );
}

function TimelineList({ timeline }: { timeline: TimelineState }) {
  if (timeline.phase === "idle" || timeline.entries.length === 0) return null;
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
  if (memory.phase === "idle") return null;
  return stateGroups(memory.state).map((group) => (
    <section className="state-group" key={group.kind}>
      <h3>
        {group.kind.replaceAll("_", " ")} <span className="meta">{group.assertions.length}</span>
      </h3>
      <div className="stack">
        {group.assertions.map((assertion) => (
          <AssertionCard key={assertion.id} assertion={assertion} />
        ))}
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
  onSubmit: (
    event: FormEvent<HTMLFormElement>,
    question: Question,
    privacy: string,
  ) => void | Promise<void>;
}) {
  const answerId = `ask-answer-${index}`;
  const [privacy, setPrivacy] = useState("P1");
  return (
    <Card>
      <form onSubmit={(event) => void onSubmit(event, question, privacy)}>
        <CardHeader>
          <CardTitle>
            <Label htmlFor={answerId}>{question.prompt}</Label>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex gap-2">
            <Input id={answerId} name="answer" required />
            <Button type="submit">送る</Button>
          </div>
          <RadioGroup value={privacy} onValueChange={setPrivacy}>
            {ASK_PRIVACY.map((item) => {
              const itemId = `${answerId}-${item}`;
              return (
                <div key={item} className="flex items-center gap-2">
                  <RadioGroupItem value={item} id={itemId} />
                  <Label htmlFor={itemId}>{item}</Label>
                </div>
              );
            })}
          </RadioGroup>
        </CardContent>
      </form>
    </Card>
  );
}

export function Console() {
  const [session, setSession] = useState(loadSession);
  const [health, setHealth] = useState<HealthState>({ phase: "checking" });
  const [view, setView] = useState<ViewId>("dialogue");
  const [inboxLoaded, setInboxLoaded] = useState(false);
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [timeline, setTimeline] = useState<TimelineState>({ phase: "idle" });
  const [memory, setMemory] = useState<MemoryState>({ phase: "idle" });
  const [askedKinds, setAskedKinds] = useState<readonly string[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const submitting = useRef(false);
  const answering = useRef(false);
  const askRequest = useRef(0);
  const rowsRef = useRef(rows);
  const viewRef = useRef(view);
  const previousPending = useRef<string | null>(null);
  const reviewRef = useRef<(proposalId: string, action: ReviewAction) => void>(() => undefined);
  rowsRef.current = rows;
  viewRef.current = view;

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
      setSendingId(null);
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

  function dismiss(id: string, action: ReviewAction): void {
    const current = rowsRef.current;
    if (!current.some((row) => row.proposal.id === id && row.phase === "in")) return;
    const ids = current.filter((row) => row.phase === "in").map((row) => row.proposal.id);
    const nextId = idAfterRemoval(ids, id);
    if (nextId !== null) {
      const next = cardElement(nextId);
      if (next !== null) focusCard(next);
    }
    const nextRows = current.map((row): InboxRow =>
      row.proposal.id === id ? { proposal: row.proposal, phase: "out", leave: action } : row,
    );
    rowsRef.current = nextRows;
    setRows(nextRows);
  }

  function dropRow(id: string): void {
    const next = rowsRef.current.filter((row) => row.proposal.id !== id);
    rowsRef.current = next;
    setRows(next);
    setSendingId((current) => (current === id ? null : current));
    if (next.length === 0) document.querySelector<HTMLElement>("#review-title")?.focus();
  }

  async function review(
    proposalId: string,
    action: ReviewAction,
    draft: string,
    instant: boolean,
  ): Promise<boolean> {
    if (submitting.current) return false;
    const row = rowsRef.current.find((item) => item.proposal.id === proposalId);
    if (row === undefined || row.phase !== "in") return false;
    const edited = draft.trim();
    if (action === "approve" && edited.length === 0) {
      showToast("内容を入力してください。");
      return false;
    }
    const editedObject =
      action === "approve" && edited !== row.proposal.assertion.object ? edited : undefined;
    submitting.current = true;
    setSendingId(proposalId);
    try {
      await requestJson(session, `/v1/proposals/${encodeURIComponent(proposalId)}/${action}`, {
        actor: "web-owner",
        reason: editedObject === undefined ? ACTION_LABELS[action] : "修正して承認",
        ...(editedObject === undefined ? {} : { editedObject }),
      });
    } catch (error: unknown) {
      submitting.current = false;
      setSendingId(null);
      showToast(errorMessage(error));
      return false;
    }
    showToast(`提案を${ACTION_LABELS[action]}しました。`);
    void reloadTimeline(session, false);
    void reloadMemory(session, false);
    if (instant) dropRow(proposalId);
    else dismiss(proposalId, action);
    submitting.current = false;
    setSendingId(null);
    return true;
  }

  function reconnect(current: Session): void {
    void reloadHealth(current);
    void reloadProposals(current);
    void reloadTimeline(current, false);
    void reloadMemory(current, false);
  }

  function selectView(next: ViewId): void {
    setView(next);
    setMenuOpen(false);
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

  function toggleAskedKind(kind: string, checked: boolean): void {
    const kinds = ASK_KINDS.map((item) => item.value).filter((value) =>
      value === kind ? checked : askedKinds.includes(value),
    );
    setAskedKinds(kinds);
    void loadQuestions(session, kinds);
  }

  async function submitAnswer(
    event: FormEvent<HTMLFormElement>,
    question: Question,
    privacy: string,
  ): Promise<void> {
    event.preventDefault();
    if (answering.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const answerValue = data.get("answer");
    const answer = typeof answerValue === "string" ? answerValue : "";
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

  reviewRef.current = (proposalId, action) => {
    const card = cardElement(proposalId);
    const field = card?.querySelector("textarea");
    const draft = field instanceof HTMLTextAreaElement ? field.value : "";
    const instant = window.matchMedia("(max-width: 900px)").matches;
    void review(proposalId, action, draft, instant);
  };

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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const focus = inboxFocus({
        key: event.key,
        inReasonForm: false,
        typing: target.closest("input, textarea, select, [contenteditable]") !== null,
      });
      if (focus === "ignore") return;
      if (viewRef.current !== "review") return;
      const command = inboxCommand(event);
      if (command === null) return;
      const card = target.closest<HTMLElement>(".inbox-card");
      if (command.type === "compose") {
        const proposalId = card?.dataset.proposalId ?? frontCardId();
        if (proposalId === null) return;
        event.preventDefault();
        reviewRef.current(proposalId, command.action);
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

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (sidebar === null) return undefined;
    const query = window.matchMedia("(max-width: 900px)");
    const sync = (): void => {
      sidebar.inert = query.matches && !menuOpen;
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <>
      <a className="skip-link" href="#main">
        本文へ移動
      </a>
      <div className={view === "dialogue" ? "app-shell dialogue-open" : "app-shell"}>
        {menuOpen ? (
          <button
            type="button"
            className="menu-backdrop"
            aria-label="メニューを閉じる"
            onClick={() => setMenuOpen(false)}
          />
        ) : null}
        <aside id="sidebar" ref={sidebarRef} className={menuOpen ? "sidebar open" : "sidebar"}>
          <Brand />
          <MainNav view={view} pendingText={pendingText} onSelect={selectView} />
          <div className="sidebar-bottom">
            <ConnectionForm session={session} onSubmit={onConnect} />
            <p className="build-label">v1.0.0-rc.1</p>
          </div>
        </aside>
        <main id="main" className="main-content" tabIndex={-1}>
          <header className="topbar">
            <div className="topbar-start">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="menu-button"
                aria-expanded={menuOpen}
                aria-controls="sidebar"
                aria-label={menuOpen ? "メニューを閉じる" : "メニュー"}
                onClick={() => setMenuOpen((open) => !open)}
              >
                {menuOpen ? (
                  <IconX size={18} stroke={1.75} />
                ) : (
                  <IconMenu2 size={18} stroke={1.75} />
                )}
              </Button>
              <h1>Personal OS</h1>
            </div>
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
            <div id="proposal-list" className="review-list" aria-live="polite">
              {rows.length === 0
                ? null
                : rows.map((row, index) => (
                    <ProposalCard
                      key={row.proposal.id}
                      row={row}
                      index={index}
                      deck={deckFor(row, rows)}
                      busy={sendingId === row.proposal.id}
                      onReview={(proposalId, action, draft) =>
                        review(
                          proposalId,
                          action,
                          draft,
                          window.matchMedia("(max-width: 900px)").matches,
                        )
                      }
                      onLeft={dropRow}
                    />
                  ))}
            </div>
          </section>
          <DialogueScreen session={session} active={view === "dialogue"} />
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
            <Card>
              <CardHeader>
                <CardTitle>種類</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {ASK_KINDS.map((kind) => {
                  const id = `ask-kind-${kind.value}`;
                  return (
                    <div key={kind.value} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={askedKinds.includes(kind.value)}
                        onCheckedChange={(checked) => toggleAskedKind(kind.value, checked === true)}
                      />
                      <Label htmlFor={id}>{kind.label}</Label>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
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
