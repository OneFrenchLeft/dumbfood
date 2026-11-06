import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  Activity,
  Contribution,
  EventSnapshot,
  Item,
  MealEvent,
  Participant,
} from "../shared/types.js";

export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', shareToken TEXT NOT NULL UNIQUE, archived INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY, eventId TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, eventId TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, name TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('ingredient','equipment')), unit TEXT NOT NULL CHECK(unit IN ('g','L','portion','place','piece')), target REAL CHECK(target IS NULL OR target>0), version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS contributions (id TEXT PRIMARY KEY, itemId TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, participantId TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE, quantity REAL NOT NULL CHECK(quantity>0), capacity REAL CHECK(capacity IS NULL OR capacity>0), note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, eventId TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, actor TEXT NOT NULL, description TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS participants_event ON participants(eventId);
    CREATE INDEX IF NOT EXISTS items_event ON items(eventId);
    CREATE INDEX IF NOT EXISTS contributions_item ON contributions(itemId);
    CREATE INDEX IF NOT EXISTS activity_event ON activity(eventId, createdAt);
    PRAGMA user_version=1;`);
  return db;
}
export type Db = ReturnType<typeof openDatabase>;
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function eventRow(row: unknown): MealEvent | undefined {
  if (!row) return undefined;
  const value = row as MealEvent;
  return { ...value, archived: Boolean(value.archived) };
}
export function findEvent(db: Db, token: string) {
  return eventRow(
    db.prepare("SELECT * FROM events WHERE shareToken=?").get(token),
  );
}
export function snapshot(db: Db, event: MealEvent): EventSnapshot {
  return {
    event,
    participants: db
      .prepare("SELECT * FROM participants WHERE eventId=? ORDER BY rowid")
      .all(event.id) as unknown as Participant[],
    items: db
      .prepare("SELECT * FROM items WHERE eventId=? ORDER BY rowid")
      .all(event.id) as unknown as Item[],
    contributions: db
      .prepare(
        "SELECT c.* FROM contributions c JOIN items i ON i.id=c.itemId WHERE i.eventId=? ORDER BY c.rowid",
      )
      .all(event.id) as unknown as Contribution[],
    activity: db
      .prepare(
        "SELECT id,actor,description,createdAt FROM activity WHERE eventId=? ORDER BY rowid DESC LIMIT 50",
      )
      .all(event.id) as unknown as Activity[],
  };
}
export function audit(
  db: Db,
  eventId: string,
  actor: string,
  description: string,
) {
  db.prepare(
    "INSERT INTO activity(id,eventId,actor,description,createdAt) VALUES(?,?,?,?,?)",
  ).run(randomUUID(), eventId, actor, description, new Date().toISOString());
}
export const newToken = () => randomBytes(24).toString("base64url");
export function seedDemo(db: Db) {
  if (Number(db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n) > 0)
    return;
  transaction(db, () => {
    const eventId = randomUUID();
    db.prepare(
      "INSERT INTO events(id,title,date,location,description,shareToken) VALUES(?,?,?,?,?,?)",
    ).run(
      eventId,
      "Raclette entre amis",
      "2026-11-21T19:30",
      "Chez Anne & Thomas",
      "Une grande tablée, du fromage et de la bonne humeur. On s’occupe de tout, ensemble.",
      "demo-raclette-entre-amis",
    );
    const people = new Map<string, string>();
    for (const name of ["Anne", "Thomas", "Léa", "Hugo", "Camille"]) {
      const id = randomUUID();
      people.set(name, id);
      db.prepare("INSERT INTO participants(id,eventId,name) VALUES(?,?,?)").run(
        id,
        eventId,
        name,
      );
    }
    function item(
      name: string,
      category: string,
      unit: string,
      target: number | null,
      entries: [string, number, number?][],
    ) {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO items(id,eventId,name,category,unit,target) VALUES(?,?,?,?,?,?)",
      ).run(id, eventId, name, category, unit, target);
      for (const [person, quantity, capacity] of entries)
        db.prepare(
          "INSERT INTO contributions(id,itemId,participantId,quantity,capacity,note) VALUES(?,?,?,?,?,?)",
        ).run(
          randomUUID(),
          id,
          people.get(person)!,
          quantity,
          capacity ?? null,
          "",
        );
    }
    item("Fromage à raclette", "ingredient", "g", 2400, [
      ["Anne", 1200],
      ["Thomas", 1440],
    ]);
    item("Pommes de terre", "ingredient", "g", 4000, [["Léa", 2500]]);
    item("Charcuterie", "ingredient", "g", 1800, [["Hugo", 900]]);
    item("Vin blanc", "ingredient", "L", null, [["Camille", 1.5]]);
    item("Pain de campagne", "ingredient", "piece", null, [["Thomas", 2]]);
    item("Appareils à raclette", "equipment", "place", 12, [
      ["Anne", 1, 6],
      ["Hugo", 1, 8],
    ]);
    item("Cocotte", "equipment", "piece", 1, []);
    audit(db, eventId, "Anne", "a préparé le repas. À chacun sa part !");
  });
}
