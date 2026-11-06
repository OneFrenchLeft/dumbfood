import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  CookingPot,
  Copy,
  Heart,
  History,
  LayoutGrid,
  Leaf,
  Link2,
  LoaderCircle,
  LogOut,
  MapPin,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  Utensils,
  UtensilsCrossed,
  Wine,
  X,
} from "lucide-react";
import type {
  Contribution,
  EventSnapshot,
  Item,
  MealEvent,
  Participant,
  Session,
  Unit,
} from "../shared/types";
import "./style.css";

const number = (n: number) =>
  new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(n);
const unitLabels: Record<Unit, string> = {
  g: "g",
  L: "L",
  portion: "portions",
  place: "places",
  piece: "pièces",
};
const unitNames: Record<Unit, string> = {
  g: "Grammes (g)",
  L: "Litres (L)",
  portion: "Portions",
  place: "Places",
  piece: "Pièces",
};
const amount = (value: number, unit: Unit) => {
  const singular = { portion: "portion", place: "place", piece: "pièce" };
  const label =
    Math.abs(value) === 1 && unit in singular
      ? singular[unit as keyof typeof singular]
      : unitLabels[unit];
  return `${number(value)} ${label}`;
};
const totalFor = (item: Item, contributions: Contribution[]) =>
  contributions
    .filter((c) => c.itemId === item.id)
    .reduce(
      (sum, c) =>
        sum + c.quantity * (item.unit === "place" ? c.capacity || 1 : 1),
      0,
    );
const formatDate = (date: string, options?: Intl.DateTimeFormatOptions) => {
  const d = new Date(date);
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString(
        "fr-FR",
        options || { weekday: "long", day: "numeric", month: "long" },
      );
};
const timeOf = (date: string) => {
  const d = new Date(date);
  return Number.isNaN(d.getTime())
    ? ""
    : d
        .toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
        .replace(":", "h");
};
const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
const colorFor = (name: string) =>
  ["peach", "lilac", "mint", "yellow", "blue"][
    Array.from(name).reduce((s, c) => s + c.charCodeAt(0), 0) % 5
  ];

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
async function api<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-Event-Token": token } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      data.error || "Impossible de terminer cette action. Réessayez.",
      response.status,
    );
  }
  return response.status === 204 ? (null as T) : response.json();
}
const json = (method: string, value?: unknown): RequestInit => ({
  method,
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
});
type ModalState =
  | { kind: "identity"; next?: () => void }
  | { kind: "event"; event?: MealEvent }
  | { kind: "item"; item?: Item }
  | {
      kind: "contribution";
      item: Item;
      contribution?: Contribution;
      personId?: string;
    }
  | { kind: "activity" }
  | { kind: "navigation" }
  | { kind: "share" }
  | {
      kind: "confirm";
      title: string;
      text: string;
      action: () => Promise<unknown>;
    }
  | null;

function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span
      className={`avatar ${colorFor(name)} ${small ? "small" : ""}`}
      title={name}
    >
      {initials(name)}
    </span>
  );
}
function App() {
  const initialToken =
    window.location.pathname.match(/^\/e\/([^/]+)/)?.[1] || "";
  const [token, setToken] = useState(initialToken);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<MealEvent[]>([]);
  const [snapshot, setSnapshot] = useState<EventSnapshot | null>(null);
  const [loading, setLoading] = useState(!!initialToken);
  const [pageError, setPageError] = useState("");
  const [tab, setTab] = useState<"items" | "people" | "missing">("items");
  const [category, setCategory] = useState<"all" | "ingredient" | "equipment">(
    "all",
  );
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [connection, setConnection] = useState<
    "live" | "connecting" | "offline"
  >("connecting");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const toastTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const isAdminPage = window.location.pathname === "/admin";
  const notify = useCallback((message: string, error = false) => {
    clearTimeout(toastTimeout.current);
    setToast({ message, error });
    toastTimeout.current = setTimeout(
      () => setToast(null),
      error ? 6500 : 3500,
    );
  }, []);
  const refreshEvents = useCallback(async () => {
    const list = await api<MealEvent[]>("/events");
    setEvents(list);
    return list;
  }, []);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!token) return;
    const sequence = ++refreshSequence.current;
    try {
      const next = await api<EventSnapshot>(
        `/events/${encodeURIComponent(token)}`,
      );
      if (tokenRef.current === token && sequence === refreshSequence.current) {
        setSnapshot(next);
        setPageError("");
      }
    } catch (error) {
      if (
        (error as ApiError).status === 404 &&
        tokenRef.current === token &&
        sequence === refreshSequence.current
      ) {
        setSnapshot(null);
        setLoading(false);
        setPageError(
          "Ce repas a été supprimé ou ce lien n’est plus disponible.",
        );
        return;
      }
      throw error;
    }
  }, [token]);
  const selectEvent = useCallback((newToken: string) => {
    tokenRef.current = newToken;
    setToken(newToken);
    setSnapshot(null);
    setTab("items");
    setPageError("");
    window.history.pushState({}, "", `/e/${newToken}`);
  }, []);
  useEffect(() => {
    api<Session>("/session")
      .then(setSession)
      .catch(() => setSession({ admin: false, actor: null }));
  }, []);
  useEffect(() => {
    if (session?.admin)
      refreshEvents()
        .then((list) => {
          if (!tokenRef.current && list.length)
            selectEvent((list.find((e) => !e.archived) || list[0]).shareToken);
        })
        .catch((e) => notify(e.message, true));
  }, [session?.admin, refreshEvents, selectEvent, notify]);
  useEffect(() => {
    if (!token) return;
    let current = true;
    setLoading(true);
    setPageError("");
    refresh()
      .catch((e) => {
        if (current) setPageError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [token, refresh]);
  useEffect(() => {
    const onPop = () => {
      const next = window.location.pathname.match(/^\/e\/([^/]+)/)?.[1] || "";
      tokenRef.current = next;
      setToken(next);
      setSnapshot(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (!token) return;
    let socket: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      setConnection(navigator.onLine ? "connecting" : "offline");
      socket = new WebSocket(
        `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?event=${encodeURIComponent(token)}`,
      );
      const activeSocket = socket;
      socket.onopen = () => {
        if (disposed || socket !== activeSocket) return;
        setConnection("live");
        refresh().catch(() => {});
      };
      socket.onmessage = (message) => {
        if (disposed || socket !== activeSocket) return;
        try {
          if (JSON.parse(message.data).type === "changed") {
            refresh().catch(() =>
              notify("Actualisation interrompue. Reconnexion en cours…", true),
            );
            if (session?.admin) refreshEvents().catch(() => {});
          }
        } catch {
          /* Ignore non-JSON keepalives. */
        }
      };
      socket.onclose = () => {
        if (!disposed && socket === activeSocket) {
          setConnection("offline");
          timer = setTimeout(connect, 2500);
        }
      };
      socket.onerror = () => activeSocket.close();
    };
    const online = () => {
      if (socket?.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        socket?.close();
        connect();
      } else refresh().catch(() => {});
    };
    const visible = () => {
      if (document.visibilityState === "visible") online();
    };
    connect();
    window.addEventListener("online", online);
    window.addEventListener("focus", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket?.close();
      window.removeEventListener("online", online);
      window.removeEventListener("focus", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [token, refresh, session?.admin, refreshEvents, notify]);
  const requireIdentity = (next: () => void) => {
    if (session?.actor || session?.admin) next();
    else setModal({ kind: "identity", next });
  };
  const execute = async (
    operation: () => Promise<unknown>,
    message = "Enregistré, tout le monde est à jour.",
  ) => {
    setSubmitting(true);
    try {
      await operation();
      setModal(null);
      if (tokenRef.current) {
        const currentToken = tokenRef.current;
        const next = await api<EventSnapshot>(
          `/events/${encodeURIComponent(currentToken)}`,
        );
        if (tokenRef.current === currentToken) setSnapshot(next);
      }
      if (session?.admin) await refreshEvents();
      notify(message);
    } catch (e) {
      const error = e as ApiError;
      if (error.status === 409) {
        await refresh().catch(() => {});
        setModal(null);
        notify(`${error.message} Les données ont été actualisées.`, true);
      } else notify(error.message, true);
    } finally {
      setSubmitting(false);
    }
  };
  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError("");
    try {
      await api("/admin/login", json("POST", { password }));
      setPassword("");
      setSession(await api<Session>("/session"));
    } catch (e) {
      setLoginError((e as Error).message);
    } finally {
      setLoginBusy(false);
    }
  };
  const signOut = async () => {
    try {
      await api("/admin/logout", json("POST", {}));
      setSession(await api<Session>("/session"));
      setEvents([]);
      notify("Vous êtes déconnecté de l’administration.");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const participantName = (id: string) =>
    snapshot?.participants.find((p) => p.id === id)?.name || "Participant";
  const event = snapshot?.event;
  const visibleEvents = events.filter((e) => showArchived || !e.archived);
  const targeted = snapshot?.items.filter((i) => i.target !== null) || [];
  const covered = targeted.filter(
    (i) => totalFor(i, snapshot?.contributions || []) >= (i.target || 0),
  ).length;
  const freeCount =
    snapshot?.items.filter((i) => i.target === null).length || 0;
  const filteredItems =
    snapshot?.items.filter(
      (i) =>
        (category === "all" || i.category === category) &&
        i.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
        (tab !== "missing" ||
          (i.target !== null &&
            totalFor(i, snapshot.contributions) < i.target)),
    ) || [];
  const totalMissing = targeted.filter(
    (i) => totalFor(i, snapshot?.contributions || []) < (i.target || 0),
  ).length;
  const editContribution = (
    item: Item,
    contribution?: Contribution,
    personId?: string,
  ) =>
    requireIdentity(() =>
      setModal({ kind: "contribution", item, contribution, personId }),
    );
  const addItem = () => requireIdentity(() => setModal({ kind: "item" }));
  const shareLink = `${window.location.origin}/e/${token}`;
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      notify("Lien copié. À partager avec la tablée !");
    } catch {
      setModal({ kind: "share" });
    }
  };
  const identityButton = (
    <button
      className="identity-button"
      onClick={() => setModal({ kind: "identity" })}
      aria-label="Modifier mon prénom"
    >
      <Avatar name={session?.actor || (session?.admin ? "Admin" : "?")} small />
      <span>
        {session?.actor || (session?.admin ? "Admin" : "Votre prénom")}
        <small>{session?.admin ? "Administrateur" : "Invité du repas"}</small>
      </span>
      <ChevronDown size={14} />
    </button>
  );

  return (
    <>
      <div className="app-shell">
        <aside className="sidebar">
          <a
            className="brand"
            href={session?.admin ? "/admin" : "/"}
            aria-label="dumbfood accueil"
          >
            <span className="brand-icon">
              <UtensilsCrossed size={20} strokeWidth={2.3} />
            </span>
            dumbfood<span className="brand-dot">.</span>
          </a>
          <div className="sidebar-title">ON SE RETROUVE À TABLE</div>
          <div className="sidebar-section-label">
            {session?.admin ? "MES REPAS" : "AU MENU"}
          </div>
          {session?.admin ? (
            <>
              <div className="event-nav">
                {visibleEvents.map((e) => (
                  <button
                    key={e.id}
                    className={`event-nav-button ${token === e.shareToken ? "selected" : ""}`}
                    onClick={() => selectEvent(e.shareToken)}
                  >
                    <span className="event-nav-icon">
                      <CookingPot size={19} />
                    </span>
                    <span>
                      {e.title}
                      <small>
                        {formatDate(e.date, { day: "numeric", month: "short" })}
                        {e.archived ? " · Archivé" : ""}
                      </small>
                    </span>
                    {token === e.shareToken && (
                      <span className="nav-active-dot" />
                    )}
                  </button>
                ))}
              </div>
              <button
                className="sidebar-add"
                onClick={() => setModal({ kind: "event" })}
              >
                <Plus size={17} /> Nouveau repas
              </button>
              {events.some((e) => e.archived) && (
                <button
                  className="text-button archived-toggle"
                  onClick={() => setShowArchived(!showArchived)}
                >
                  {showArchived ? "Masquer les archives" : "Voir les archives"}
                </button>
              )}
            </>
          ) : event ? (
            <button className="event-nav-button selected">
              <span className="event-nav-icon">
                <CookingPot size={19} />
              </span>
              <span>
                {event.title}
                <small>
                  {formatDate(event.date, { day: "numeric", month: "short" })}
                </small>
              </span>
              <span className="nav-active-dot" />
            </button>
          ) : (
            <div className="sidebar-hint">
              Les bons repas commencent par un lien partagé.
            </div>
          )}
          <div className="sidebar-note">
            <div className="note-illustration">
              <Heart size={22} />
              <span>✦</span>
            </div>
            <strong>Chacun apporte sa part.</strong>
            <p>
              Moins d’organisation,
              <br />
              plus de bons moments.
            </p>
          </div>
          <div className="sidebar-bottom">
            {session?.admin ? (
              <button className="sidebar-utility" onClick={signOut}>
                <LogOut size={17} /> Déconnexion admin
              </button>
            ) : (
              <a className="sidebar-utility" href="/admin">
                <ShieldCheck size={17} /> Espace organisateur
              </a>
            )}
            <span className="made-for">
              Fait pour les grandes tablées <Heart size={11} />
            </span>
          </div>
        </aside>
        <div className="main-column">
          <header className="topbar">
            <div className="breadcrumb">
              <Utensils size={15} />
              <span>Mes repas</span>
              <ChevronRight size={13} />
              <strong>
                {event?.title ||
                  (isAdminPage ? "Administration" : "Bienvenue à table")}
              </strong>
            </div>
            <div className="mobile-brand-group">
              <a href="/" className="mobile-brand">
                dumbfood<span>.</span>
              </a>
              {session?.admin && (
                <button
                  className="mobile-admin-menu"
                  aria-label="Choisir un repas"
                  onClick={() => setModal({ kind: "navigation" })}
                >
                  <Menu size={19} />
                </button>
              )}
            </div>
            <div className="topbar-actions">
              {token && (
                <span className={`connection ${connection}`} role="status">
                  <span />
                  {connection === "live"
                    ? "En direct"
                    : connection === "connecting"
                      ? "Connexion…"
                      : "Reconnexion…"}
                </span>
              )}
              {identityButton}
            </div>
          </header>
          <main>
            {session === null ? (
              <div className="page-state">
                <LoaderCircle className="spin" />
                <p>On prépare la table…</p>
              </div>
            ) : isAdminPage && !session.admin ? (
              <div className="welcome-wrap">
                <div className="welcome-art">
                  <UtensilsCrossed size={36} />
                </div>
                <span className="eyebrow">LE COIN DE L’ORGANISATEUR</span>
                <h1>Bienvenue en cuisine.</h1>
                <p>
                  Connectez-vous pour organiser vos repas
                  <br />
                  et préparer de belles tablées.
                </p>
                <form className="login-form" onSubmit={signIn}>
                  <label htmlFor="admin-password">
                    Mot de passe administrateur
                  </label>
                  <input
                    id="admin-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoFocus
                    placeholder="Votre mot de passe"
                  />
                  {loginError && (
                    <p className="field-error" role="alert">
                      {loginError}
                    </p>
                  )}
                  <button className="button primary" disabled={loginBusy}>
                    {loginBusy ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : (
                      <ArrowRight size={17} />
                    )}{" "}
                    Ouvrir mon espace
                  </button>
                </form>
              </div>
            ) : !token ? (
              <div className="welcome-wrap">
                <div className="welcome-art">
                  <CookingPot size={38} />
                </div>
                <span className="eyebrow">À CHACUN SA PART</span>
                <h1>
                  Les bons repas
                  <br />
                  se préparent ensemble.
                </h1>
                <p>
                  {session.admin
                    ? "Votre prochaine tablée n’attend que vous."
                    : "Ouvrez le lien de votre repas pour voir ce qu’il manque et ajouter ce que vous apportez."}
                </p>
                {session.admin ? (
                  <button
                    className="button primary"
                    onClick={() => setModal({ kind: "event" })}
                  >
                    <Plus size={18} /> Créer mon premier repas
                  </button>
                ) : (
                  <a className="button primary" href="/admin">
                    <ShieldCheck size={18} /> Organiser un repas
                  </a>
                )}
                <div className="welcome-pills">
                  <span>
                    <CheckCheck size={16} /> Quantités partagées
                  </span>
                  <span>
                    <Users size={16} /> Sans compte invité
                  </span>
                </div>
              </div>
            ) : pageError ? (
              <div className="page-state">
                <CookingPot size={34} />
                <h1>Le repas est introuvable.</h1>
                <p>{pageError}</p>
                <button
                  className="button secondary"
                  onClick={() => {
                    setPageError("");
                    setLoading(true);
                    refresh()
                      .catch((e) => setPageError(e.message))
                      .finally(() => setLoading(false));
                  }}
                >
                  Réessayer
                </button>
                <a href="/admin" className="text-button">
                  Espace organisateur
                </a>
              </div>
            ) : loading || !snapshot ? (
              <div className="page-state">
                <LoaderCircle className="spin" />
                <p>On dresse la table…</p>
              </div>
            ) : (
              <>
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">
                      <span className="tiny-star">✦</span> LE PROCHAIN BON
                      MOMENT
                    </div>
                    <h1>{event!.title}</h1>
                  </div>
                  <div className="heading-actions">
                    {session.admin && (
                      <button
                        className="button icon-button secondary"
                        onClick={() => setModal({ kind: "event", event })}
                        aria-label="Modifier le repas"
                      >
                        <Settings2 size={18} />
                      </button>
                    )}
                    <button
                      className="button secondary share-button"
                      onClick={copyLink}
                    >
                      <Link2 size={17} />
                      <span>Inviter la tablée</span>
                    </button>
                  </div>
                </div>
                <section
                  className="meal-banner"
                  aria-label="Informations du repas"
                >
                  <div className="banner-content">
                    <span className="banner-tag">
                      <CookingPot size={14} />{" "}
                      {event!.archived
                        ? "Repas archivé"
                        : "LE REPAS SE PRÉPARE"}
                    </span>
                    <p>
                      {event!.description ||
                        "Une grande table, de bonnes choses et vous."}
                    </p>
                    <div className="meal-meta">
                      <span>
                        <CalendarDays size={16} />
                        {formatDate(event!.date)}
                        <span className="meta-separator">·</span>
                        {timeOf(event!.date)}
                      </span>
                      {event!.location && (
                        <span>
                          <MapPin size={16} />
                          {event!.location}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="plate-art" aria-hidden="true">
                    <span className="plate-orbit orbit-one" />
                    <span className="plate-orbit orbit-two" />
                    <span className="plate">
                      <span>
                        <UtensilsCrossed size={44} strokeWidth={1.3} />
                      </span>
                    </span>
                    <span className="plate-spark spark-one">✦</span>
                    <span className="plate-spark spark-two">✦</span>
                    <span className="plate-leaf">
                      <Leaf size={28} strokeWidth={1.5} />
                    </span>
                  </div>
                </section>
                <details className="mobile-meal-info">
                  <summary aria-label="Voir les détails du repas">
                    <span className="mobile-meal-copy">
                      <span>
                        <CalendarDays size={16} />
                        {formatDate(event!.date)} · {timeOf(event!.date)}
                      </span>
                      {event!.location && (
                        <span>
                          <MapPin size={14} />
                          {event!.location}
                        </span>
                      )}
                      {event!.archived && <span>Repas archivé</span>}
                    </span>
                    <ChevronDown size={17} />
                  </summary>
                  <p>
                    {event!.description ||
                      "Une grande table, de bonnes choses et vous."}
                  </p>
                </details>
                <section className="overview" aria-label="Résumé des apports">
                  <div className="overview-main">
                    <div className="summary-icon">
                      <CheckCheck size={22} />
                    </div>
                    <div>
                      <strong>
                        {covered}
                        <span> / {targeted.length}</span>
                      </strong>
                      <span className="summary-label">besoins couverts</span>
                    </div>
                    <div className="mini-meter" aria-hidden="true">
                      {Array.from(
                        { length: Math.min(targeted.length || 6, 12) },
                        (_, i) => (
                          <span
                            key={i}
                            className={i < covered ? "filled" : ""}
                          />
                        ),
                      )}
                    </div>
                  </div>
                  <div className="overview-separator" />
                  <div className="overview-free">
                    <span className="soft-icon">
                      <Sparkles size={20} />
                    </span>
                    <div>
                      <strong>{freeCount}</strong>
                      <span className="summary-label">
                        {freeCount > 1
                          ? "extras à partager"
                          : "extra à partager"}
                      </span>
                    </div>
                  </div>
                  <div className="overview-people">
                    <div className="avatar-stack">
                      {snapshot.participants.slice(0, 4).map((p) => (
                        <Avatar key={p.id} name={p.name} small />
                      ))}
                    </div>
                    <div>
                      <strong>
                        {snapshot.participants.length} à la tablée
                      </strong>
                      <span className="summary-label">
                        {snapshot.contributions.length} apports prévus
                      </span>
                    </div>
                  </div>
                </section>
                {connection === "offline" && (
                  <div className="offline-notice" role="status">
                    La connexion est interrompue. Les données affichées peuvent
                    avoir changé ; nous essayons de reconnecter le repas.
                  </div>
                )}
                <div className="list-heading">
                  <div>
                    <h2>Qui apporte quoi ?</h2>
                    <p>Un peu de chacun, beaucoup à partager.</p>
                  </div>
                  <button
                    className="button primary add-item-desktop"
                    onClick={addItem}
                  >
                    <Plus size={17} /> Ajouter autre chose
                  </button>
                </div>
                <div className="tabs-toolbar">
                  <div
                    className="view-tabs"
                    role="tablist"
                    aria-label="Vue des apports"
                  >
                    <button
                      role="tab"
                      aria-selected={tab === "items"}
                      className={tab === "items" ? "active" : ""}
                      onClick={() => setTab("items")}
                    >
                      <LayoutGrid size={16} /> À apporter
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "people"}
                      className={tab === "people" ? "active" : ""}
                      onClick={() => setTab("people")}
                    >
                      <Users size={16} /> Par personne
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "missing"}
                      className={tab === "missing" ? "active" : ""}
                      onClick={() => setTab("missing")}
                    >
                      <span className="tab-icon-dot" /> Ce qu’il manque{" "}
                      <span className="tab-count">{totalMissing}</span>
                    </button>
                  </div>
                  <button
                    className="history-button"
                    onClick={() => setModal({ kind: "activity" })}
                  >
                    <History size={16} />
                    <span>Activité</span>
                  </button>
                </div>
                {tab !== "people" ? (
                  <>
                    <div className="filter-row">
                      <div className="category-filters" aria-label="Catégorie">
                        <button
                          className={category === "all" ? "selected" : ""}
                          onClick={() => setCategory("all")}
                        >
                          Tout <span>{snapshot.items.length}</span>
                        </button>
                        <button
                          className={
                            category === "ingredient" ? "selected" : ""
                          }
                          onClick={() => setCategory("ingredient")}
                        >
                          <Leaf size={14} /> Ingrédients
                        </button>
                        <button
                          className={category === "equipment" ? "selected" : ""}
                          onClick={() => setCategory("equipment")}
                        >
                          <CookingPot size={14} /> Matériel
                        </button>
                      </div>
                      <label className="search-field" htmlFor="item-search">
                        <Search size={16} />
                        <input
                          id="item-search"
                          type="search"
                          aria-label="Rechercher un élément"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="Rechercher…"
                        />
                      </label>
                    </div>
                    <div className="item-grid">
                      {filteredItems.map((item) => {
                        const contributions = snapshot.contributions.filter(
                          (c) => c.itemId === item.id,
                        );
                        const total = totalFor(item, snapshot.contributions);
                        const percent = item.target
                          ? Math.round((total / item.target) * 100)
                          : null;
                        const complete =
                          item.target !== null && total >= item.target;
                        return (
                          <article
                            key={item.id}
                            className={`item-card ${complete ? "complete" : ""}`}
                          >
                            <div className="card-top">
                              <span
                                className={`item-symbol ${item.category === "equipment" ? "equipment" : ""}`}
                              >
                                {item.category === "equipment" ? (
                                  <CookingPot size={21} />
                                ) : item.unit === "L" ? (
                                  <Wine size={21} />
                                ) : (
                                  <Leaf size={21} />
                                )}
                              </span>
                              <div className="item-title">
                                <h3>{item.name}</h3>
                                <span>
                                  {item.category === "equipment"
                                    ? "Matériel"
                                    : "Ingrédient"}
                                </span>
                              </div>
                              {session.admin && (
                                <button
                                  className="card-menu"
                                  aria-label={`Modifier ${item.name}`}
                                  onClick={() =>
                                    setModal({ kind: "item", item })
                                  }
                                >
                                  <MoreHorizontal size={21} />
                                </button>
                              )}
                              {!session.admin && complete && (
                                <CheckCircle2
                                  size={20}
                                  className="card-complete-icon"
                                />
                              )}
                            </div>
                            <div className="quantity-row">
                              <div>
                                <strong>{amount(total, item.unit)}</strong>
                                {item.target !== null && (
                                  <span>
                                    {" "}
                                    / {amount(item.target, item.unit)}
                                  </span>
                                )}
                              </div>
                              {percent !== null ? (
                                <span
                                  className={`percent ${complete ? "done" : ""}`}
                                >
                                  {complete && <Check size={12} />} {percent} %
                                </span>
                              ) : (
                                <span className="free-badge">
                                  <Sparkles size={11} /> En libre
                                </span>
                              )}
                            </div>
                            {item.target !== null ? (
                              <>
                                <div
                                  className="progress-track"
                                  role="progressbar"
                                  aria-label={`Progression ${item.name}`}
                                  aria-valuenow={total}
                                  aria-valuemin={0}
                                  aria-valuemax={Math.max(total, item.target)}
                                  aria-valuetext={`${percent} % de l’objectif`}
                                >
                                  <span
                                    style={{
                                      width: `${Math.min(100, (total / item.target) * 100)}%`,
                                    }}
                                  />
                                </div>
                                <div
                                  className={`progress-caption ${complete ? "done" : ""}`}
                                >
                                  {total > item.target ? (
                                    <>
                                      <Check size={12} />
                                      {amount(
                                        total - item.target,
                                        item.unit,
                                      )}{" "}
                                      en plus, c’est généreux !
                                    </>
                                  ) : total === item.target ? (
                                    <>
                                      <Check size={12} />
                                      Tout est prévu, parfait !
                                    </>
                                  ) : (
                                    <>
                                      Encore{" "}
                                      {amount(item.target - total, item.unit)} à
                                      prévoir
                                    </>
                                  )}
                                </div>
                              </>
                            ) : (
                              <div className="free-caption">
                                Les petits plus font les grands repas.
                              </div>
                            )}
                            <div className="contributions-list">
                              {contributions.length ? (
                                contributions.map((c) => (
                                  <button
                                    key={c.id}
                                    className="contribution-line"
                                    onClick={() => editContribution(item, c)}
                                    aria-label={`Modifier l’apport de ${participantName(c.participantId)} pour ${item.name}`}
                                  >
                                    <Avatar
                                      name={participantName(c.participantId)}
                                      small
                                    />
                                    <span>
                                      {participantName(c.participantId)}
                                      {c.note && <small>{c.note}</small>}
                                    </span>
                                    <strong>
                                      {item.unit === "place"
                                        ? `${number(c.quantity)} × ${number(c.capacity || 1)} places`
                                        : amount(c.quantity, item.unit)}
                                    </strong>
                                    <ChevronRight size={13} />
                                  </button>
                                ))
                              ) : (
                                <div className="no-contribution">
                                  <span className="empty-avatar">
                                    <Users size={14} />
                                  </span>
                                  La première part est pour vous ?
                                </div>
                              )}
                            </div>
                            <button
                              className="card-add"
                              onClick={() => editContribution(item)}
                            >
                              <Plus size={16} /> J’en apporte
                            </button>
                          </article>
                        );
                      })}
                      {!filteredItems.length && (
                        <div className="empty-list">
                          <CheckCircle2 size={31} />
                          <h3>
                            {tab === "missing" && !query
                              ? "Tout est prévu !"
                              : snapshot.items.length
                                ? "Aucun élément trouvé"
                                : "La table est encore vide"}
                          </h3>
                          <p>
                            {tab === "missing" && !query
                              ? "Il ne reste plus qu’à passer un bon moment."
                              : snapshot.items.length
                                ? "Essayez une autre recherche ou catégorie."
                                : "Ajoutez les ingrédients, le matériel ou un petit extra."}
                          </p>
                          {!snapshot.items.length && (
                            <button
                              className="button primary"
                              onClick={addItem}
                            >
                              <Plus size={17} /> Ajouter le premier élément
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="people-grid">
                    {snapshot.participants.map((person) => {
                      const list = snapshot.contributions.filter(
                        (c) => c.participantId === person.id,
                      );
                      return (
                        <article className="person-card" key={person.id}>
                          <div className="person-heading">
                            <Avatar name={person.name} />
                            <div>
                              <h3>{person.name}</h3>
                              <span>
                                {list.length} apport{list.length > 1 ? "s" : ""}{" "}
                                prévu{list.length > 1 ? "s" : ""}
                              </span>
                            </div>
                          </div>
                          {list.length ? (
                            list.map((c) => {
                              const item = snapshot.items.find(
                                (i) => i.id === c.itemId,
                              );
                              return item ? (
                                <button
                                  className="person-item"
                                  key={c.id}
                                  onClick={() => editContribution(item, c)}
                                >
                                  <span>{item.name}</span>
                                  <strong>
                                    {item.unit === "place"
                                      ? `${number(c.quantity)} × ${number(c.capacity || 1)} places`
                                      : amount(c.quantity, item.unit)}
                                  </strong>
                                  <ChevronRight size={14} />
                                </button>
                              ) : null;
                            })
                          ) : (
                            <p className="person-empty">
                              Sa part reste à choisir.
                            </p>
                          )}
                        </article>
                      );
                    })}
                    {!snapshot.participants.length && (
                      <div className="empty-list">
                        <Users size={30} />
                        <h3>La tablée se construit</h3>
                        <p>Ajoutez un premier apport pour commencer.</p>
                      </div>
                    )}
                  </div>
                )}
                <div className="page-footer">
                  <span>
                    <CheckCheck size={15} /> Les changements sont partagés en
                    direct.
                  </span>
                  <button onClick={() => setModal({ kind: "activity" })}>
                    Voir l’activité <ArrowUpRight size={13} />
                  </button>
                </div>
                <button className="button primary mobile-add" onClick={addItem}>
                  <Plus size={18} /> Ajouter autre chose
                </button>
              </>
            )}
          </main>
        </div>
      </div>
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <CircleHelp size={18} /> : <CheckCircle2 size={18} />}
          <span>{toast.message}</span>
          <button
            onClick={() => setToast(null)}
            aria-label="Fermer la notification"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal && (
        <Modal
          title={
            modal.kind === "identity"
              ? "On vous appelle comment ?"
              : modal.kind === "event"
                ? modal.event
                  ? "Les détails du repas"
                  : "Une nouvelle tablée"
                : modal.kind === "item"
                  ? modal.item
                    ? "Modifier cet élément"
                    : "Un petit quelque chose en plus"
                  : modal.kind === "contribution"
                    ? modal.contribution
                      ? "Modifier cet apport"
                      : "Je prends ma part"
                    : modal.kind === "activity"
                      ? "La vie de la tablée"
                      : modal.kind === "navigation"
                        ? "Vos repas"
                        : modal.kind === "share"
                          ? "Inviter la tablée"
                          : modal.title
          }
          onClose={() => !submitting && setModal(null)}
        >
          {modal.kind === "identity" && (
            <IdentityForm
              initial={session?.actor || ""}
              busy={submitting}
              onSubmit={(name) => {
                setSubmitting(true);
                api("/identity", json("POST", { name }))
                  .then(async () => {
                    setSession(await api<Session>("/session"));
                    const next = modal.next;
                    setModal(null);
                    next?.();
                  })
                  .catch((e) => notify(e.message, true))
                  .finally(() => setSubmitting(false));
              }}
            />
          )}
          {modal.kind === "event" && (
            <EventForm
              event={modal.event}
              busy={submitting}
              onSubmit={(data) =>
                execute(
                  async () => {
                    if (modal.event)
                      await api(
                        `/events/${modal.event.id}`,
                        json("PATCH", {
                          ...data,
                          version: modal.event.version,
                        }),
                      );
                    else {
                      const created = await api<MealEvent>(
                        "/events",
                        json("POST", data),
                      );
                      selectEvent(created.shareToken);
                    }
                  },
                  modal.event
                    ? "Les détails du repas sont à jour."
                    : "Le repas est créé. À vous de dresser la liste !",
                )
              }
              onArchive={
                modal.event
                  ? () =>
                      execute(
                        () =>
                          api(
                            `/events/${modal.event!.id}`,
                            json("PATCH", {
                              archived: !modal.event!.archived,
                              version: modal.event!.version,
                            }),
                          ),
                        modal.event!.archived
                          ? "Le repas est de nouveau actif."
                          : "Le repas est archivé.",
                      )
                  : undefined
              }
              onDelete={
                modal.event
                  ? () =>
                      setModal({
                        kind: "confirm",
                        title: "Supprimer ce repas ?",
                        text: "Tous ses éléments et ses apports seront supprimés. Cette action est définitive.",
                        action: async () => {
                          await api(
                            `/events/${modal.event!.id}?version=${modal.event!.version}`,
                            { method: "DELETE" },
                          );
                          tokenRef.current = "";
                          setToken("");
                          setSnapshot(null);
                          window.history.pushState({}, "", "/admin");
                          const remaining = await refreshEvents();
                          if (remaining.length)
                            selectEvent(remaining[0].shareToken);
                        },
                      })
                  : undefined
              }
            />
          )}
          {modal.kind === "item" && (
            <ItemForm
              item={modal.item}
              admin={!!session?.admin}
              people={snapshot?.participants || []}
              actor={session?.actor || "Admin"}
              busy={submitting}
              onSubmit={(data) =>
                execute(() =>
                  modal.item
                    ? api(
                        `/items/${modal.item.id}`,
                        json("PATCH", {
                          name: data.name,
                          category: data.category,
                          unit: data.unit,
                          target: data.target,
                          version: modal.item.version,
                        }),
                        token,
                      )
                    : api(`/events/${token}/items`, json("POST", data), token),
                )
              }
              onDelete={
                modal.item
                  ? () =>
                      setModal({
                        kind: "confirm",
                        title: "Supprimer cet élément ?",
                        text: `« ${modal.item!.name} » et tous les apports associés seront supprimés.`,
                        action: () =>
                          api(
                            `/items/${modal.item!.id}?version=${modal.item!.version}`,
                            { method: "DELETE" },
                            token,
                          ),
                      })
                  : undefined
              }
            />
          )}
          {modal.kind === "contribution" && (
            <ContributionForm
              item={modal.item}
              contribution={modal.contribution}
              people={snapshot!.participants}
              actor={session?.actor || "Admin"}
              personId={modal.personId}
              busy={submitting}
              onSubmit={(data) =>
                execute(async () => {
                  let participantId = data.participantId;
                  if (!participantId) {
                    const person = await api<Participant>(
                      `/events/${token}/participants`,
                      json("POST", { name: data.personName }),
                      token,
                    );
                    participantId = person.id;
                  }
                  const body = {
                    participantId,
                    quantity: data.quantity,
                    capacity: data.capacity,
                    note: data.note,
                  };
                  if (modal.contribution)
                    await api(
                      `/contributions/${modal.contribution.id}`,
                      json("PATCH", {
                        ...body,
                        version: modal.contribution.version,
                      }),
                      token,
                    );
                  else
                    await api(
                      `/events/${token}/contributions`,
                      json("POST", { ...body, itemId: modal.item.id }),
                      token,
                    );
                })
              }
              onDelete={
                modal.contribution
                  ? () =>
                      setModal({
                        kind: "confirm",
                        title: "Retirer cet apport ?",
                        text: `L’apport de ${participantName(modal.contribution!.participantId)} sera retiré. L’élément « ${modal.item.name} » restera dans la liste.`,
                        action: () =>
                          api(
                            `/contributions/${modal.contribution!.id}?version=${modal.contribution!.version}`,
                            { method: "DELETE" },
                            token,
                          ),
                      })
                  : undefined
              }
            />
          )}
          {modal.kind === "navigation" && (
            <div className="mobile-navigation">
              <p className="modal-intro">
                Retrouvez vos tablées et préparez le prochain repas.
              </p>
              <div className="event-nav">
                {visibleEvents.map((e) => (
                  <button
                    key={e.id}
                    className={`event-nav-button ${token === e.shareToken ? "selected" : ""}`}
                    onClick={() => {
                      selectEvent(e.shareToken);
                      setModal(null);
                    }}
                  >
                    <span className="event-nav-icon">
                      <CookingPot size={19} />
                    </span>
                    <span>
                      {e.title}
                      <small>
                        {formatDate(e.date, { day: "numeric", month: "long" })}
                        {e.archived ? " · Archivé" : ""}
                      </small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
              {events.some((e) => e.archived) && (
                <button
                  className="text-button"
                  onClick={() => setShowArchived(!showArchived)}
                >
                  {showArchived
                    ? "Masquer les archives"
                    : "Afficher les archives"}
                </button>
              )}
              <button
                className="button primary full-width"
                onClick={() => setModal({ kind: "event" })}
              >
                <Plus size={17} /> Nouveau repas
              </button>
              <button
                className="sidebar-utility mobile-logout"
                onClick={() => {
                  setModal(null);
                  signOut();
                }}
              >
                <LogOut size={16} /> Déconnexion admin
              </button>
            </div>
          )}
          {modal.kind === "activity" && (
            <div className="activity-list">
              <p className="modal-intro">
                Les dernières nouvelles, pour savoir qui a changé quoi.
              </p>
              {snapshot?.activity.length ? (
                snapshot.activity.map((a) => (
                  <div className="activity-entry" key={a.id}>
                    <Avatar name={a.actor} small />
                    <div>
                      <strong>{a.actor}</strong>
                      <p>{a.description}</p>
                      <time>
                        {new Date(a.createdAt).toLocaleString("fr-FR", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-list">
                  <History size={27} />
                  <p>Les premières contributions apparaîtront ici.</p>
                </div>
              )}
            </div>
          )}
          {modal.kind === "share" && (
            <div className="share-content">
              <p className="modal-intro">
                Toute personne qui possède ce lien peut consulter le repas et
                modifier les apports après avoir renseigné son prénom.
              </p>
              <label htmlFor="share-link">Lien du repas</label>
              <input
                id="share-link"
                value={shareLink}
                readOnly
                onFocus={(e) => e.target.select()}
              />
              <button
                className="button primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(shareLink);
                    notify("Lien copié !");
                    setModal(null);
                  } catch {
                    document.getElementById("share-link")?.focus();
                    notify(
                      "Sélectionnez le lien et copiez-le avec votre navigateur.",
                    );
                  }
                }}
              >
                <Copy size={17} /> Copier le lien
              </button>
            </div>
          )}
          {modal.kind === "confirm" && (
            <div className="confirm-content">
              <p>{modal.text}</p>
              <div className="form-actions">
                <button
                  className="button secondary"
                  onClick={() => setModal(null)}
                  disabled={submitting}
                >
                  Annuler
                </button>
                <button
                  className="button danger"
                  disabled={submitting}
                  onClick={() =>
                    execute(modal.action, "Suppression enregistrée.")
                  }
                >
                  {submitting ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <Trash2 size={17} />
                  )}{" "}
                  Supprimer
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      const el = ref.current?.querySelector<HTMLElement>(
        'input:not([type="checkbox"]), select, textarea, button',
      );
      el?.focus();
    });
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const list = ref.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
        );
        if (!list?.length) return;
        const first = list[0],
          last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = bodyOverflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-handle" />
        <div className="modal-heading">
          <div>
            <span className="eyebrow">ON PRÉPARE ÇA ENSEMBLE</span>
            <h2 id="modal-title">{title}</h2>
          </div>
          <button
            className="close-button"
            onClick={onClose}
            aria-label="Fermer"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function IdentityForm({
  initial,
  busy,
  onSubmit,
}: {
  initial: string;
  busy: boolean;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <form
      className="modal-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit(name.trim());
      }}
    >
      <p className="modal-intro">
        Un prénom suffit pour participer. Vous pourrez aussi renseigner les
        apports des autres.
      </p>
      <label htmlFor="identity-name">Votre prénom</label>
      <input
        id="identity-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={60}
        required
        placeholder="Par exemple : Thomas"
        autoComplete="given-name"
        autoFocus
      />
      <p className="field-hint">
        Ce prénom signe vos modifications et reste mémorisé sur cet appareil.
      </p>
      <button
        className="button primary full-width"
        disabled={busy || !name.trim()}
      >
        {busy ? (
          <LoaderCircle className="spin" size={17} />
        ) : (
          <ArrowRight size={17} />
        )}{" "}
        C’est parti
      </button>
    </form>
  );
}
function EventForm({
  event,
  busy,
  onSubmit,
  onArchive,
  onDelete,
}: {
  event?: MealEvent;
  busy: boolean;
  onSubmit: (data: {
    title: string;
    date: string;
    location: string;
    description: string;
  }) => void;
  onArchive?: () => void;
  onDelete?: () => void;
}) {
  const localDate = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const [title, setTitle] = useState(event?.title || "");
  const [date, setDate] = useState(event ? localDate(event.date) : "");
  const [location, setLocation] = useState(event?.location || "");
  const [description, setDescription] = useState(event?.description || "");
  return (
    <form
      className="modal-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          title: title.trim(),
          date: new Date(date).toISOString(),
          location: location.trim(),
          description: description.trim(),
        });
      }}
    >
      <label htmlFor="event-title">Nom du repas</label>
      <input
        id="event-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={100}
        required
        placeholder="Raclette entre amis"
      />
      <label htmlFor="event-date">Date et heure</label>
      <input
        id="event-date"
        type="datetime-local"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        required
      />
      <label htmlFor="event-location">
        Où se retrouve-t-on ? <span>Facultatif</span>
      </label>
      <input
        id="event-location"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        maxLength={200}
        placeholder="Chez Camille"
      />
      <label htmlFor="event-description">
        Un petit mot pour la tablée <span>Facultatif</span>
      </label>
      <textarea
        id="event-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={1000}
        rows={3}
        placeholder="Une grande table, de bonnes choses et vous."
      />
      <button className="button primary full-width" disabled={busy}>
        {busy ? (
          <LoaderCircle className="spin" size={17} />
        ) : (
          <Check size={17} />
        )}{" "}
        {event ? "Enregistrer le repas" : "Créer le repas"}
      </button>
      {event && (
        <div className="form-admin-actions">
          <button
            type="button"
            className="text-button"
            onClick={onArchive}
            disabled={busy}
          >
            {event.archived ? "Réactiver ce repas" : "Archiver ce repas"}
          </button>
          <button
            type="button"
            className="text-button danger-text"
            onClick={onDelete}
            disabled={busy}
          >
            <Trash2 size={14} /> Supprimer le repas
          </button>
        </div>
      )}
    </form>
  );
}
type ItemFormData = {
  name: string;
  category: "ingredient" | "equipment";
  unit: Unit;
  target: number | null;
  participantId?: string;
  quantity?: number;
  capacity?: number | null;
  note?: string;
};
function ItemForm({
  item,
  admin,
  people,
  actor,
  busy,
  onSubmit,
  onDelete,
}: {
  item?: Item;
  admin: boolean;
  people: Participant[];
  actor: string;
  busy: boolean;
  onSubmit: (data: ItemFormData) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(item?.name || "");
  const [category, setCategory] = useState<"ingredient" | "equipment">(
    item?.category || "ingredient",
  );
  const [unit, setUnit] = useState<Unit>(item?.unit || "g");
  const [hasTarget, setHasTarget] = useState(item?.target != null);
  const [target, setTarget] = useState(item?.target?.toString() || "");
  const [quantity, setQuantity] = useState("");
  const [capacity, setCapacity] = useState("6");
  const [personId, setPersonId] = useState(
    people.find((p) => p.name.toLocaleLowerCase() === actor.toLocaleLowerCase())
      ?.id ||
      people[0]?.id ||
      "",
  );
  const [personName, setPersonName] = useState(actor);
  const [localError, setLocalError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError("");
    if (!item && quantity && !personId) {
      // Item creation accepts an existing participant. Create the named person first.
      try {
        const token = window.location.pathname.match(/^\/e\/([^/]+)/)?.[1];
        if (!token) throw new Error("Sélectionnez un repas.");
        const person = await api<Participant>(
          `/events/${token}/participants`,
          json("POST", { name: personName.trim() }),
          token,
        );
        onSubmit({
          name: name.trim(),
          category,
          unit,
          target: admin && hasTarget ? Number(target) : null,
          participantId: person.id,
          quantity: Number(quantity),
          capacity: unit === "place" ? Number(capacity) : null,
        });
      } catch (error) {
        setLocalError((error as Error).message);
      }
    } else
      onSubmit({
        name: name.trim(),
        category,
        unit,
        target: admin && hasTarget ? Number(target) : null,
        ...(!item && quantity
          ? {
              participantId: personId,
              quantity: Number(quantity),
              capacity: unit === "place" ? Number(capacity) : null,
            }
          : {}),
      });
  };
  return (
    <form className="modal-form" onSubmit={submit}>
      <p className="modal-intro">
        {item
          ? "Les apports déjà prévus sont conservés."
          : admin
            ? "Ajoutez un besoin précis ou un extra en libre."
            : "Une idée, une envie ? Ajoutez-la sans objectif. L’organisateur pourra ensuite ajuster cet élément."}
      </p>
      <label htmlFor="item-name">Qu’est-ce qu’on apporte ?</label>
      <input
        id="item-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={100}
        placeholder="Du pain, une salade, un appareil…"
      />
      <div className="form-columns">
        <div>
          <label htmlFor="item-category">Catégorie</label>
          <select
            id="item-category"
            value={category}
            onChange={(e) =>
              setCategory(e.target.value as "ingredient" | "equipment")
            }
          >
            <option value="ingredient">Ingrédient</option>
            <option value="equipment">Matériel</option>
          </select>
        </div>
        <div>
          <label htmlFor="item-unit">Unité</label>
          <select
            id="item-unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value as Unit)}
          >
            {Object.entries(unitNames).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {admin && (
        <div className="target-config">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={hasTarget}
              onChange={(e) => setHasTarget(e.target.checked)}
            />
            <span>
              Définir un objectif
              <strong>
                {hasTarget
                  ? "Une quantité fixe pour ce repas"
                  : "En libre, chacun apporte ce qu’il souhaite"}
              </strong>
            </span>
          </label>
          {hasTarget && (
            <div className="input-unit">
              <input
                type="number"
                aria-label="Objectif"
                min={unit === "place" || unit === "piece" ? 1 : 0.001}
                step={unit === "place" || unit === "piece" ? 1 : "any"}
                required
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="Quantité souhaitée"
              />
              <span>{unitLabels[unit]}</span>
            </div>
          )}
        </div>
      )}
      {!item && (
        <div className="first-contribution">
          <label htmlFor="item-first-quantity">
            Premier apport <span>Facultatif</span>
          </label>
          <div className="input-unit">
            <input
              id="item-first-quantity"
              type="number"
              min={unit === "place" || unit === "piece" ? 1 : 0.001}
              step={unit === "place" || unit === "piece" ? 1 : "any"}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="Je commence avec…"
            />
            <span>{unit === "place" ? "appareil(s)" : unitLabels[unit]}</span>
          </div>
          {quantity && (
            <>
              {unit === "place" && (
                <>
                  <label htmlFor="item-capacity">Places par appareil</label>
                  <input
                    id="item-capacity"
                    type="number"
                    min="1"
                    step="1"
                    required
                    value={capacity}
                    onChange={(e) => setCapacity(e.target.value)}
                  />
                </>
              )}
              <PersonSelect
                people={people}
                personId={personId}
                setPersonId={setPersonId}
                personName={personName}
                setPersonName={setPersonName}
              />
            </>
          )}
        </div>
      )}
      {localError && (
        <p className="field-error" role="alert">
          {localError}
        </p>
      )}
      <button className="button primary full-width" disabled={busy}>
        {busy ? (
          <LoaderCircle className="spin" size={17} />
        ) : (
          <Check size={17} />
        )}
        {item ? "Enregistrer les modifications" : "Ajouter à la liste"}
      </button>
      {item && (
        <button
          type="button"
          className="text-button danger-text form-delete"
          onClick={onDelete}
          disabled={busy}
        >
          <Trash2 size={15} /> Supprimer cet élément et ses apports
        </button>
      )}
    </form>
  );
}
function PersonSelect({
  people,
  personId,
  setPersonId,
  personName,
  setPersonName,
}: {
  people: Participant[];
  personId: string;
  setPersonId: (id: string) => void;
  personName: string;
  setPersonName: (name: string) => void;
}) {
  return (
    <>
      <label htmlFor="contribution-person">Qui apporte ?</label>
      <select
        id="contribution-person"
        value={personId}
        onChange={(e) => setPersonId(e.target.value)}
      >
        {people.map((p) => (
          <option value={p.id} key={p.id}>
            {p.name}
          </option>
        ))}
        <option value="">Une nouvelle personne…</option>
      </select>
      {!personId && (
        <>
          <label htmlFor="contribution-name">Prénom de la personne</label>
          <input
            id="contribution-name"
            value={personName}
            onChange={(e) => setPersonName(e.target.value)}
            required
            maxLength={60}
            placeholder="Prénom"
          />
        </>
      )}
    </>
  );
}
function ContributionForm({
  item,
  contribution,
  people,
  actor,
  personId: initialPersonId,
  busy,
  onSubmit,
  onDelete,
}: {
  item: Item;
  contribution?: Contribution;
  people: Participant[];
  actor: string;
  personId?: string;
  busy: boolean;
  onSubmit: (data: {
    participantId: string;
    personName: string;
    quantity: number;
    capacity: number | null;
    note: string;
  }) => void;
  onDelete?: () => void;
}) {
  const [personId, setPersonId] = useState(
    contribution?.participantId ||
      initialPersonId ||
      people.find(
        (p) => p.name.toLocaleLowerCase() === actor.toLocaleLowerCase(),
      )?.id ||
      "",
  );
  const [personName, setPersonName] = useState(actor);
  const [quantity, setQuantity] = useState(
    contribution?.quantity?.toString() || "",
  );
  const [capacity, setCapacity] = useState(
    contribution?.capacity?.toString() || "6",
  );
  const [note, setNote] = useState(contribution?.note || "");
  return (
    <form
      className="modal-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          participantId: personId,
          personName: personName.trim(),
          quantity: Number(quantity),
          capacity: item.unit === "place" ? Number(capacity) : null,
          note: note.trim(),
        });
      }}
    >
      <div className="contribution-subject">
        <span className="item-symbol">
          {item.category === "equipment" ? (
            <CookingPot size={22} />
          ) : (
            <Leaf size={22} />
          )}
        </span>
        <div>
          <strong>{item.name}</strong>
          <span>
            {item.target === null
              ? "En libre, chaque apport est bienvenu"
              : `Objectif : ${amount(item.target, item.unit)}`}
          </span>
        </div>
      </div>
      <PersonSelect
        people={people}
        personId={personId}
        setPersonId={setPersonId}
        personName={personName}
        setPersonName={setPersonName}
      />
      <label htmlFor="contribution-quantity">
        {item.unit === "place" ? "Nombre d’appareils" : "Quelle quantité ?"}
      </label>
      <div className="input-unit">
        <input
          id="contribution-quantity"
          type="number"
          min={item.unit === "place" || item.unit === "piece" ? 1 : 0.001}
          step={item.unit === "place" || item.unit === "piece" ? 1 : "any"}
          required
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder={item.unit === "g" ? "500" : "1"}
        />
        <span>
          {item.unit === "place" ? "appareil(s)" : unitLabels[item.unit]}
        </span>
      </div>
      {item.unit === "place" && (
        <>
          <label htmlFor="contribution-capacity">Places par appareil</label>
          <input
            id="contribution-capacity"
            type="number"
            min="1"
            step="1"
            required
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
          />
          <div className="capacity-preview">
            <Check size={15} />
            {number(Number(quantity || 0) * Number(capacity || 0))} places
            apportées au total
          </div>
        </>
      )}
      <label htmlFor="contribution-note">
        Une précision ? <span>Facultatif</span>
      </label>
      <textarea
        id="contribution-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={300}
        rows={2}
        placeholder="Sans alcool, fait maison, à partager…"
      />
      <p className="field-hint">
        <Users size={13} /> Vous pouvez aussi renseigner un apport pour
        quelqu’un d’autre.
      </p>
      <button className="button primary full-width" disabled={busy}>
        {busy ? (
          <LoaderCircle className="spin" size={17} />
        ) : (
          <Check size={17} />
        )}
        {contribution ? "Enregistrer cet apport" : "Confirmer cet apport"}
      </button>
      {contribution && (
        <button
          type="button"
          className="text-button danger-text form-delete"
          onClick={onDelete}
          disabled={busy}
        >
          <Trash2 size={15} /> Retirer cet apport
        </button>
      )}
    </form>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
