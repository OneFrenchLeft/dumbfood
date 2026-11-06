import { ChevronRight, Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import type { MealEvent } from "../shared/types";

interface AdminHomeProps {
  events: MealEvent[];
  onOpen: (event: MealEvent) => void;
  onEdit: (event: MealEvent) => void;
  onCreate: () => void;
}

const eventDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("fr-FR", {
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
};

export default function AdminHome({
  events,
  onOpen,
  onEdit,
  onCreate,
}: AdminHomeProps) {
  const [showArchives, setShowArchives] = useState(false);
  const active = events.filter((event) => !event.archived);
  const archived = events.filter((event) => event.archived);
  const rows = (list: MealEvent[]) =>
    list.map((event) => (
      <article className="admin-event-row" key={event.id}>
        <button
          className="admin-event-open"
          onClick={() => onOpen(event)}
          aria-label={`Ouvrir le repas ${event.title}`}
        >
          <span className="admin-event-copy">
            <strong>{event.title}</strong>
            <small>
              {eventDate(event.date)}
              {event.location ? ` · ${event.location}` : ""}
            </small>
          </span>
          <ChevronRight size={17} />
        </button>
        <button
          className="icon-button admin-event-edit"
          aria-label={`Modifier le repas ${event.title}`}
          title="Modifier le repas"
          onClick={() => onEdit(event)}
        >
          <Settings2 size={18} />
        </button>
      </article>
    ));
  return (
    <div className="admin-page">
      <div className="admin-heading">
        <h1>Repas</h1>
        <button className="button primary" onClick={onCreate}>
          <Plus size={18} /> Nouveau repas
        </button>
      </div>
      {active.length ? (
        <div className="admin-events-list">{rows(active)}</div>
      ) : (
        <div className="admin-empty">
          <p>Aucun repas prévu</p>
        </div>
      )}
      {archived.length > 0 && (
        <section className="admin-archives">
          <button
            className="text-button"
            aria-expanded={showArchives}
            onClick={() => setShowArchives(!showArchives)}
          >
            Archives <span>{archived.length}</span>
          </button>
          {showArchives && (
            <div className="admin-events-list">{rows(archived)}</div>
          )}
        </section>
      )}
    </div>
  );
}
