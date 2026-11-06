import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CookingPot,
  Copy,
  History,
  Link2,
  LoaderCircle,
  LogOut,
  ListFilter,
  MapPin,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
  Users,
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
import AdminHome from "./AdminHome";
import QuantityInput, { parseQuantity } from "./QuantityInput";

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
    : d.toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
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
  | { kind: "share" }
  | { kind: "options" }
  | { kind: "info" }
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
function AddressLink({ address }: { address: string }) {
  if (!address.trim()) return null;
  return (
    <a
      className="event-address"
      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Ouvrir l’adresse dans Maps : ${address}`}
    >
      <MapPin size={14} />
      <span>{address}</span>
    </a>
  );
}
function App() {
  const initialToken =
    window.location.pathname.match(/^\/e\/([^/]+)/)?.[1] || "";
  const [token, setToken] = useState(initialToken);
  const [path, setPath] = useState(window.location.pathname);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<MealEvent[]>([]);
  const [snapshot, setSnapshot] = useState<EventSnapshot | null>(null);
  const [loading, setLoading] = useState(!!initialToken);
  const [pageError, setPageError] = useState("");
  const [tab, setTab] = useState<"items" | "people" | "missing">("items");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
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
  const toastTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const isAdminPage = path === "/admin";
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
    setPath(`/e/${newToken}`);
  }, []);
  const goAdmin = useCallback(() => {
    tokenRef.current = "";
    setToken("");
    setSnapshot(null);
    setLoading(false);
    setPageError("");
    setModal(null);
    window.history.pushState({}, "", "/admin");
    setPath("/admin");
  }, []);
  useEffect(() => {
    api<Session>("/session")
      .then(setSession)
      .catch(() => setSession({ admin: false, actor: null }));
  }, []);
  useEffect(() => {
    if (session?.admin) refreshEvents().catch((e) => notify(e.message, true));
  }, [session?.admin, token, refreshEvents, notify]);
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
      setPath(window.location.pathname);
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
    message = "Enregistré.",
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
        if (session?.admin) await refreshEvents().catch(() => {});
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
  const targeted = snapshot?.items.filter((i) => i.target !== null) || [];
  const filteredItems =
    snapshot?.items.filter(
      (i) =>
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
      notify("Lien copié.");
    } catch {
      setModal({ kind: "share" });
    }
  };

  return (
    <>
      <div className={`app-shell ${session?.admin ? "" : "guest-layout"}`}>
        <div className="main-column">
          {!token && (
            <header className="topbar">
              <a href="/admin" className="mobile-brand">
                dumbfood
              </a>
              {session?.admin && (
                <div className="admin-account">
                  <span>
                    {session.actor && session.actor !== "Admin"
                      ? session.actor
                      : "Administration"}
                  </span>
                  <button className="text-button" onClick={signOut}>
                    Déconnexion
                  </button>
                </div>
              )}
            </header>
          )}
          <main>
            {session === null ? (
              <div className="page-state">
                <LoaderCircle className="spin" />
                <p>Chargement…</p>
              </div>
            ) : isAdminPage && !session.admin ? (
              <div className="welcome-wrap">
                <h1>Administration</h1>
                <form className="login-form" onSubmit={signIn}>
                  <label htmlFor="admin-password">Mot de passe</label>
                  <input
                    id="admin-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoFocus
                  />
                  {loginError && (
                    <p className="field-error" role="alert">
                      {loginError}
                    </p>
                  )}
                  <button className="button primary" disabled={loginBusy}>
                    {loginBusy && <LoaderCircle size={17} className="spin" />}Se
                    connecter
                  </button>
                </form>
              </div>
            ) : !token ? (
              session.admin ? (
                <AdminHome
                  events={events}
                  onOpen={(event) => selectEvent(event.shareToken)}
                  onEdit={(event) => setModal({ kind: "event", event })}
                  onCreate={() => setModal({ kind: "event" })}
                />
              ) : (
                <div className="welcome-wrap">
                  <h1>dumbfood</h1>
                  <p>Ouvrez le lien partagé par l’organisateur.</p>
                  <a className="button secondary" href="/admin">
                    Administration
                  </a>
                </div>
              )
            ) : pageError ? (
              <div className="page-state">
                <h1>Repas introuvable</h1>
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
                  Administration
                </a>
              </div>
            ) : loading || !snapshot ? (
              <div className="page-state">
                <LoaderCircle className="spin" />
                <p>Chargement…</p>
              </div>
            ) : (
              <>
                <div className="event-heading">
                  {session.admin && (
                    <button
                      className="icon-button event-back"
                      aria-label="Tous les repas"
                      title="Tous les repas"
                      onClick={goAdmin}
                    >
                      <ArrowLeft size={20} />
                    </button>
                  )}
                  <h1>{event!.title}</h1>
                  <button
                    className="icon-button"
                    aria-label="Options du repas"
                    title="Options du repas"
                    onClick={() => setModal({ kind: "options" })}
                  >
                    <MoreHorizontal size={23} />
                  </button>
                </div>
                <div className="event-meta">
                  <span>
                    {formatDate(event!.date, { day: "numeric", month: "long" })}{" "}
                    · {timeOf(event!.date)}
                  </span>
                  {event!.location && <span>{event!.location}</span>}
                  {event!.address && <AddressLink address={event!.address} />}
                  {event!.archived && <span>Archivé</span>}
                </div>
                {connection === "offline" && (
                  <div className="offline-notice" role="status">
                    Connexion interrompue. Reconnexion en cours.
                  </div>
                )}
                <div className="tabs-toolbar">
                  <div
                    className="view-tabs"
                    role="tablist"
                    aria-label="Vue des apports"
                  >
                    <button
                      role="tab"
                      aria-selected={tab !== "people"}
                      className={tab !== "people" ? "active" : ""}
                      onClick={() => setTab("items")}
                    >
                      Liste
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "people"}
                      className={tab === "people" ? "active" : ""}
                      onClick={() => setTab("people")}
                    >
                      Personnes
                    </button>
                  </div>
                  {tab !== "people" && (
                    <div className="list-tools">
                      <button
                        className={`icon-button ${tab === "missing" ? "selected" : ""}`}
                        aria-label="Afficher les éléments manquants"
                        aria-pressed={tab === "missing"}
                        title={`${totalMissing} éléments à compléter`}
                        onClick={() =>
                          setTab(tab === "missing" ? "items" : "missing")
                        }
                      >
                        <ListFilter size={20} />
                      </button>
                      <button
                        className={`icon-button ${searchOpen ? "selected" : ""}`}
                        aria-label="Rechercher dans la liste"
                        aria-expanded={searchOpen}
                        title="Rechercher"
                        onClick={() => {
                          setSearchOpen(!searchOpen);
                          if (searchOpen) setQuery("");
                        }}
                      >
                        <Search size={19} />
                      </button>
                    </div>
                  )}
                </div>
                {searchOpen && tab !== "people" && (
                  <div className="search-field">
                    <Search size={17} />
                    <input
                      autoFocus
                      aria-label="Rechercher un élément"
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Rechercher"
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setQuery("");
                          setSearchOpen(false);
                        }
                      }}
                    />
                    <button
                      className="icon-button"
                      aria-label="Fermer la recherche"
                      onClick={() => {
                        setQuery("");
                        setSearchOpen(false);
                      }}
                    >
                      <X size={18} />
                    </button>
                  </div>
                )}
                {tab !== "people" ? (
                  <div className="item-grid">
                    {(["ingredient", "equipment"] as const).map((group) => {
                      const rows = filteredItems.filter(
                        (item) => item.category === group,
                      );
                      return rows.length ? (
                        <section
                          className="item-section"
                          key={group}
                          aria-label={
                            group === "ingredient" ? "Ingrédients" : "Matériel"
                          }
                        >
                          <h2>
                            {group === "ingredient"
                              ? "Ingrédients"
                              : "Matériel"}
                          </h2>
                          <div className="item-section-list">
                            {rows.map((item) => {
                              const contributions =
                                snapshot.contributions.filter(
                                  (c) => c.itemId === item.id,
                                );
                              const total = totalFor(
                                item,
                                snapshot.contributions,
                              );
                              const percent = item.target
                                ? Math.round((total / item.target) * 100)
                                : null;
                              const complete =
                                item.target !== null && total >= item.target;
                              const names = Array.from(
                                new Set(
                                  contributions.map((c) =>
                                    participantName(c.participantId),
                                  ),
                                ),
                              ).join(", ");
                              return (
                                <article
                                  className={`item-card ${complete ? "complete" : ""}`}
                                  key={item.id}
                                >
                                  <details className="item-details">
                                    <summary
                                      className="item-summary"
                                      aria-label={`Voir les apports pour ${item.name}`}
                                    >
                                      <h3>{item.name}</h3>
                                      <div className="quantity-row">
                                        {item.target !== null ? (
                                          <>
                                            <strong>{number(total)}</strong>
                                            <span>
                                              {" "}
                                              / {amount(item.target, item.unit)}
                                            </span>
                                            <span className="percent">
                                              {" "}
                                              · {percent} %
                                            </span>
                                          </>
                                        ) : (
                                          <strong>
                                            {amount(total, item.unit)}
                                          </strong>
                                        )}
                                      </div>
                                      {names && (
                                        <span className="item-people">
                                          {names}
                                        </span>
                                      )}
                                      {item.target !== null && (
                                        <div
                                          className="progress-track"
                                          role="progressbar"
                                          aria-label={`Progression ${item.name}`}
                                          aria-valuenow={total}
                                          aria-valuemin={0}
                                          aria-valuemax={Math.max(
                                            total,
                                            item.target,
                                          )}
                                          aria-valuetext={`${percent} % de l’objectif`}
                                        >
                                          <span
                                            style={{
                                              width: `${Math.min(100, (total / item.target) * 100)}%`,
                                            }}
                                          />
                                        </div>
                                      )}
                                    </summary>
                                    <div className="contributions-list">
                                      {contributions.length ? (
                                        contributions.map((c) => (
                                          <button
                                            className="contribution-line"
                                            key={c.id}
                                            onClick={() =>
                                              editContribution(item, c)
                                            }
                                            aria-label={`Modifier l’apport de ${participantName(c.participantId)} pour ${item.name}`}
                                          >
                                            <span>
                                              {participantName(c.participantId)}
                                              {c.note && (
                                                <small>{c.note}</small>
                                              )}
                                            </span>
                                            <strong>
                                              {item.unit === "place"
                                                ? `${number(c.quantity)} × ${number(c.capacity || 1)} places`
                                                : amount(c.quantity, item.unit)}
                                            </strong>
                                            <ChevronRight size={15} />
                                          </button>
                                        ))
                                      ) : (
                                        <p className="no-contribution">
                                          Aucun apport
                                        </p>
                                      )}
                                    </div>
                                    {session.admin && (
                                      <button
                                        className="item-edit text-button"
                                        aria-label={`Modifier ${item.name}`}
                                        onClick={() =>
                                          setModal({ kind: "item", item })
                                        }
                                      >
                                        <Settings2 size={15} /> Modifier
                                        l’élément
                                      </button>
                                    )}
                                  </details>
                                  <button
                                    className="row-add icon-button"
                                    aria-label={`Ajouter un apport pour ${item.name}`}
                                    title="Ajouter un apport"
                                    onClick={() => editContribution(item)}
                                  >
                                    <Plus size={23} />
                                  </button>
                                </article>
                              );
                            })}
                          </div>
                        </section>
                      ) : null;
                    })}
                    {!filteredItems.length && (
                      <div className="empty-list">
                        <p>
                          {tab === "missing" && !query
                            ? "Rien à compléter"
                            : snapshot.items.length
                              ? "Aucun résultat"
                              : "Aucun élément"}
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="people-grid">
                    {snapshot.participants.map((person) => {
                      const list = snapshot.contributions.filter(
                        (c) => c.participantId === person.id,
                      );
                      return (
                        <section className="person-card" key={person.id}>
                          <div className="person-heading">
                            <h3>{person.name}</h3>
                            <span>
                              {list.length} apport{list.length > 1 ? "s" : ""}
                            </span>
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
                                  <ChevronRight size={15} />
                                </button>
                              ) : null;
                            })
                          ) : (
                            <p className="person-empty">Aucun apport</p>
                          )}
                        </section>
                      );
                    })}
                    {!snapshot.participants.length && (
                      <div className="empty-list">
                        <p>Aucun participant</p>
                      </div>
                    )}
                  </div>
                )}
                <button className="add-item-end text-button" onClick={addItem}>
                  <Plus size={19} /> Ajouter un élément
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
          key={modal.kind}
          title={
            modal.kind === "identity"
              ? "Votre prénom"
              : modal.kind === "event"
                ? modal.event
                  ? "Modifier le repas"
                  : "Nouveau repas"
                : modal.kind === "item"
                  ? modal.item
                    ? "Modifier l’élément"
                    : "Nouvel élément"
                  : modal.kind === "contribution"
                    ? modal.contribution
                      ? "Modifier un apport"
                      : "Ajouter un apport"
                    : modal.kind === "activity"
                      ? "Historique"
                      : modal.kind === "share"
                        ? "Partager le repas"
                        : modal.kind === "options"
                          ? "Repas"
                          : modal.kind === "info"
                            ? "Informations"
                            : modal.title
          }
          onClose={() => !submitting && setModal(null)}
        >
          {modal.kind === "options" && (
            <div className="options-list">
              <button
                aria-label="Modifier mon prénom"
                onClick={() => setModal({ kind: "identity" })}
              >
                <Users size={18} />
                <span>{session?.actor || "Mon prénom"}</span>
                <ChevronRight size={16} />
              </button>
              <button
                onClick={() => {
                  setModal(null);
                  void copyLink();
                }}
              >
                <Link2 size={18} />
                <span>Partager</span>
              </button>
              <button onClick={() => setModal({ kind: "info" })}>
                <CalendarDays size={18} />
                <span>Informations</span>
              </button>
              <button onClick={() => setModal({ kind: "activity" })}>
                <History size={18} />
                <span>Historique</span>
              </button>
              {session?.admin ? (
                <>
                  <button
                    aria-label="Modifier le repas"
                    onClick={() => setModal({ kind: "event", event })}
                  >
                    <Settings2 size={18} />
                    <span>Modifier le repas</span>
                  </button>
                  <button aria-label="Choisir un repas" onClick={goAdmin}>
                    <Menu size={18} />
                    <span>Autres repas</span>
                  </button>
                  <button
                    onClick={() => {
                      setModal(null);
                      void signOut();
                    }}
                  >
                    <LogOut size={18} />
                    <span>Déconnexion</span>
                  </button>
                </>
              ) : (
                <a href="/admin">
                  <ShieldCheck size={18} />
                  <span>Administration</span>
                </a>
              )}
            </div>
          )}
          {modal.kind === "info" && event && (
            <div className="event-info">
              <p>
                {formatDate(event.date)} · {timeOf(event.date)}
              </p>
              {event.location && <p>{event.location}</p>}
              {event.address && <AddressLink address={event.address} />}
              {event.description && <p>{event.description}</p>}
            </div>
          )}
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
                  modal.event ? "Repas enregistré." : "Repas créé.",
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
                          ? "Repas réactivé."
                          : "Repas archivé.",
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
                          goAdmin();
                          await refreshEvents();
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
                        title: "Retirer l’apport ?",
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
          {modal.kind === "activity" && (
            <div className="activity-list">
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
                          hourCycle: "h23",
                        })}
                      </time>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-list">
                  <History size={27} />
                  <p>Aucune modification.</p>
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
      <button
        className="button primary full-width"
        disabled={busy || !name.trim()}
      >
        {busy ? (
          <LoaderCircle className="spin" size={17} />
        ) : (
          <ArrowRight size={17} />
        )}{" "}
        Continuer
      </button>
    </form>
  );
}
type EventFormData = {
  title: string;
  date?: string;
  location: string;
  address: string;
  description: string;
};
function EventForm({
  event,
  busy,
  onSubmit,
  onArchive,
  onDelete,
}: {
  event?: MealEvent;
  busy: boolean;
  onSubmit: (data: EventFormData) => void;
  onArchive?: () => void;
  onDelete?: () => void;
}) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const initial = event ? new Date(event.date) : null;
  const quarters = ["00", "15", "30", "45"];
  const originalMinute = initial ? pad(initial.getMinutes()) : "00";
  const legacyTime = !!initial && !quarters.includes(originalMinute);
  const [title, setTitle] = useState(event?.title || "");
  const [day, setDay] = useState(
    initial
      ? `${initial.getFullYear()}-${pad(initial.getMonth() + 1)}-${pad(initial.getDate())}`
      : "",
  );
  const [hour, setHour] = useState(initial ? pad(initial.getHours()) : "19");
  const [minute, setMinute] = useState(legacyTime ? "" : originalMinute);
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [location, setLocation] = useState(event?.location || "");
  const [address, setAddress] = useState(event?.address || "");
  const [description, setDescription] = useState(event?.description || "");
  const [localError, setLocalError] = useState("");
  const scheduleRequired = !event || scheduleTouched;
  return (
    <form
      className="modal-form"
      onSubmit={(e) => {
        e.preventDefault();
        setLocalError("");
        const data: EventFormData = {
          title: title.trim(),
          location: location.trim(),
          address: address.trim(),
          description: description.trim(),
        };
        if (scheduleRequired) {
          if (!day || !hour || !quarters.includes(minute)) {
            setLocalError("Choisissez une date et une heure complète.");
            return;
          }
          const chosen = new Date(`${day}T${hour}:${minute}:00`);
          if (
            Number.isNaN(chosen.getTime()) ||
            chosen.getHours() !== Number(hour) ||
            chosen.getMinutes() !== Number(minute)
          ) {
            setLocalError("Cette heure n’existe pas pour la date choisie.");
            return;
          }
          data.date = chosen.toISOString();
        }
        onSubmit(data);
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
      <div className="schedule-fields">
        <div className="schedule-date">
          <label htmlFor="event-date">Date</label>
          <input
            id="event-date"
            type="date"
            value={day}
            onChange={(e) => {
              setDay(e.target.value);
              setScheduleTouched(true);
            }}
            required={scheduleRequired}
          />
        </div>
        <div>
          <label htmlFor="event-hour">Heure</label>
          <div className="schedule-time">
            <select
              id="event-hour"
              aria-label="Heure"
              value={hour}
              onChange={(e) => {
                setHour(e.target.value);
                setScheduleTouched(true);
              }}
              required={scheduleRequired}
            >
              {Array.from({ length: 24 }, (_, i) => pad(i)).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <span className="time-separator">:</span>
            <select
              id="event-minute"
              aria-label="Minutes"
              value={minute}
              onChange={(e) => {
                setMinute(e.target.value);
                setScheduleTouched(true);
              }}
              required={scheduleRequired}
            >
              {legacyTime && (
                <option value="" disabled>
                  —
                </option>
              )}
              {quarters.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      {legacyTime && !scheduleTouched && (
        <p className="field-hint legacy-time">
          Horaire actuel : {timeOf(event!.date)}. Il sera conservé si vous ne le
          modifiez pas.
        </p>
      )}
      <label htmlFor="event-location">
        Lieu <span>Facultatif</span>
      </label>
      <input
        id="event-location"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        maxLength={200}
        placeholder="Chez Camille"
      />
      <label htmlFor="event-address">
        Adresse <span>Facultatif</span>
      </label>
      <input
        id="event-address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        maxLength={500}
        autoComplete="street-address"
        placeholder="Numéro, rue, ville"
      />
      <label htmlFor="event-description">
        Description <span>Facultatif</span>
      </label>
      <textarea
        id="event-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={1000}
        rows={2}
        placeholder="Informations utiles"
      />
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
        {event ? "Enregistrer" : "Créer"}
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
          target: admin && hasTarget ? parseQuantity(target) : null,
          participantId: person.id,
          quantity: parseQuantity(quantity),
          capacity: unit === "place" ? parseQuantity(capacity) : null,
        });
      } catch (error) {
        setLocalError((error as Error).message);
      }
    } else
      onSubmit({
        name: name.trim(),
        category,
        unit,
        target: admin && hasTarget ? parseQuantity(target) : null,
        ...(!item && quantity
          ? {
              participantId: personId,
              quantity: parseQuantity(quantity),
              capacity: unit === "place" ? parseQuantity(capacity) : null,
            }
          : {}),
      });
  };
  return (
    <form className="modal-form" onSubmit={submit}>
      <label htmlFor="item-name">Nom</label>
      <input
        id="item-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={100}
        placeholder="Pain, salade, appareil…"
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
            <span>Définir un objectif</span>
          </label>
          {hasTarget && (
            <QuantityInput
              id="item-target"
              label="Objectif"
              unit={unit}
              required
              value={target}
              onChange={setTarget}
              placeholder="Quantité souhaitée"
              unitLabel={unitLabels[unit]}
            />
          )}
        </div>
      )}
      {!item && (
        <div className="first-contribution">
          <label htmlFor="item-first-quantity">
            Premier apport <span>Facultatif</span>
          </label>
          <QuantityInput
            id="item-first-quantity"
            label="Premier apport"
            unit={unit}
            value={quantity}
            onChange={setQuantity}
            placeholder="Quantité"
            unitLabel={unit === "place" ? "appareil(s)" : unitLabels[unit]}
          />
          {quantity && (
            <>
              {unit === "place" && (
                <>
                  <label htmlFor="item-capacity">Places par appareil</label>
                  <QuantityInput
                    id="item-capacity"
                    label="Places par appareil"
                    unit="place"
                    required
                    value={capacity}
                    onChange={setCapacity}
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
        {item ? "Enregistrer" : "Ajouter"}
      </button>
      {item && (
        <button
          type="button"
          className="text-button danger-text form-delete"
          onClick={onDelete}
          disabled={busy}
        >
          <Trash2 size={15} /> Supprimer l’élément
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
          quantity: parseQuantity(quantity),
          capacity: item.unit === "place" ? parseQuantity(capacity) : null,
          note: note.trim(),
        });
      }}
    >
      <div className="contribution-subject">
        <div>
          <strong>{item.name}</strong>
          <span>
            {item.target === null
              ? "Sans objectif"
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
        {item.unit === "place" ? "Nombre d’appareils" : "Quantité"}
      </label>
      <QuantityInput
        id="contribution-quantity"
        label={item.unit === "place" ? "Nombre d’appareils" : "Quantité"}
        unit={item.unit}
        required
        value={quantity}
        onChange={setQuantity}
        placeholder={item.unit === "g" ? "500" : "1"}
        unitLabel={
          item.unit === "place" ? "appareil(s)" : unitLabels[item.unit]
        }
      />
      {item.unit === "place" && (
        <>
          <label htmlFor="contribution-capacity">Places par appareil</label>
          <QuantityInput
            id="contribution-capacity"
            label="Places par appareil"
            unit="place"
            required
            value={capacity}
            onChange={setCapacity}
          />
          <div className="capacity-preview">
            <Check size={15} />
            {number(
              parseQuantity(quantity || "0") * parseQuantity(capacity || "0"),
            )}{" "}
            places apportées au total
          </div>
        </>
      )}
      <label htmlFor="contribution-note">
        Note <span>Facultatif</span>
      </label>
      <textarea
        id="contribution-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={300}
        rows={2}
        placeholder="Facultatif"
      />
      <button className="button primary full-width" disabled={busy}>
        {busy ? (
          <LoaderCircle className="spin" size={17} />
        ) : (
          <Check size={17} />
        )}
        {contribution ? "Enregistrer" : "Ajouter"}
      </button>
      {contribution && (
        <button
          type="button"
          className="text-button danger-text form-delete"
          onClick={onDelete}
          disabled={busy}
        >
          <Trash2 size={15} /> Retirer l’apport
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
