import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createServer } from "node:http";
import {
  createHmac,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import {
  audit,
  eventRow,
  findEvent,
  newToken,
  openDatabase,
  seedDemo,
  snapshot,
  transaction,
  type Db,
} from "./db.js";
import type {
  Contribution,
  Item,
  MealEvent,
  Participant,
  Session,
} from "../shared/types.js";

export interface ApplicationOptions {
  databasePath: string;
  adminPassword: string;
  sessionSecret: string;
  demoData?: boolean;
  production?: boolean;
  publicUrl?: string;
  secureCookie?: boolean;
}
interface AuthPayload extends Session {
  expires: number;
}
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new ApiError(status, message);
}
const text = z.string().trim().min(1).max(120);
const quantity = z.number().finite().positive().max(1_000_000_000);
const version = z.number().int().positive();
function validCalendarDate(value: string): boolean {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(
      value,
    );
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts
    .slice(1)
    .map((v) => Number(v ?? 0));
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(value));
}
function validQuarterHour(value: string): boolean {
  const time = /T\d{2}:(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(value);
  if (!time) return false;
  return (
    Number(time[1]) % 15 === 0 &&
    Number(time[2] ?? 0) === 0 &&
    Number(time[3] ?? 0) === 0
  );
}
const date = z
  .string()
  .max(40)
  .refine(validCalendarDate, "Date invalide")
  .refine(validQuarterHour, "Choisissez une heure à 00, 15, 30 ou 45 minutes.");
const eventFields = {
  title: text,
  date,
  location: z.string().trim().max(200).default(""),
  address: z.string().trim().max(500).default(""),
  description: z.string().trim().max(2000).default(""),
};
const itemFields = {
  name: text,
  category: z.enum(["ingredient", "equipment"]),
  unit: z.enum(["g", "L", "portion", "place", "piece"]),
  target: quantity.nullable().default(null),
};
const contributionFields = {
  itemId: z.string().min(1),
  participantId: z.string().min(1),
  quantity,
  capacity: quantity.nullable().optional(),
  note: z.string().trim().max(500).default(""),
};
const cookieName = "dumbfood_session";
export function createApplication(options: ApplicationOptions) {
  if (options.adminPassword.length < 12)
    throw new Error("ADMIN_PASSWORD doit contenir au moins 12 caractères.");
  if (options.sessionSecret.length < 32)
    throw new Error("SESSION_SECRET doit contenir au moins 32 caractères.");
  const db = openDatabase(options.databasePath);
  if (options.demoData) seedDemo(db);
  const app = express();
  app.disable("x-powered-by");
  const server = createServer(app);
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const subscriptions = new Map<WebSocket, string>();
  const passwordHash = scryptSync(
    options.adminPassword,
    "dumbfood-admin-v1",
    64,
  );
  const secureCookie =
    options.secureCookie ?? Boolean(options.publicUrl?.startsWith("https://"));
  const mac = (value: string) =>
    createHmac("sha256", options.sessionSecret)
      .update(value)
      .digest("base64url");
  function decode(req: Request): AuthPayload {
    const raw = req.headers.cookie
      ?.split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (raw) {
      try {
        const [value, signature] = raw.split(".");
        const expected = mac(value);
        if (
          signature?.length === expected.length &&
          timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
        ) {
          const payload = JSON.parse(
            Buffer.from(value, "base64url").toString(),
          ) as AuthPayload;
          if (
            payload.expires > Date.now() &&
            typeof payload.admin === "boolean" &&
            (payload.actor === null || typeof payload.actor === "string")
          )
            return payload;
        }
      } catch {
        /* invalid cookies are anonymous */
      }
    }
    return { admin: false, actor: null, expires: 0 };
  }
  function saveSession(res: Response, session: Session) {
    const maxAge = session.admin ? 12 * 60 * 60 : 30 * 24 * 60 * 60;
    const value = Buffer.from(
      JSON.stringify({ ...session, expires: Date.now() + maxAge * 1000 }),
    ).toString("base64url");
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=${value}.${mac(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie ? "; Secure" : ""}`,
    );
  }
  function auth(req: Request, admin = false) {
    const session = decode(req);
    if (admin && !session.admin)
      fail(403, "Cette action est réservée à l’administrateur.");
    if (!admin && !session.admin && !session.actor)
      fail(401, "Indiquez votre prénom pour participer.");
    return session;
  }
  function actor(req: Request) {
    const session = auth(req);
    return session.actor || "Admin";
  }
  function requireEvent(token: string): MealEvent {
    const event = findEvent(db, token);
    if (!event) fail(404, "Ce repas est introuvable.");
    return event;
  }
  function scope(req: Request, eventId: string) {
    const token = req.header("X-Event-Token");
    const event = token ? findEvent(db, token) : undefined;
    if (!event || event.id !== eventId) fail(404, "Ce repas est introuvable.");
    return event;
  }
  function itemById(id: string) {
    const item = db
      .prepare("SELECT * FROM items WHERE id=?")
      .get(id) as unknown as Item | undefined;
    if (!item) fail(404, "Cet élément est introuvable.");
    return item;
  }
  function contributionById(id: string) {
    const contribution = db
      .prepare("SELECT * FROM contributions WHERE id=?")
      .get(id) as unknown as Contribution | undefined;
    if (!contribution) fail(404, "Cet apport est introuvable.");
    return contribution;
  }
  function participantFor(id: string, eventId: string) {
    const participant = db
      .prepare("SELECT * FROM participants WHERE id=? AND eventId=?")
      .get(id, eventId) as unknown as Participant | undefined;
    if (!participant) fail(400, "Cette personne ne participe pas à ce repas.");
    return participant;
  }
  function checkVersion(actual: number, expected: number) {
    if (actual !== expected)
      fail(
        409,
        "Cet élément a été modifié entre-temps. Rechargez les dernières informations et réessayez.",
      );
  }
  function validateContribution(
    item: Item,
    value: { quantity: number; capacity?: number | null },
    validateQuantity = true,
  ) {
    if (value.capacity != null && item.unit !== "place")
      fail(400, "La capacité est réservée aux éléments comptés en places.");
    if (
      validateQuantity &&
      item.unit !== "L" &&
      !Number.isInteger(value.quantity)
    )
      fail(
        400,
        "La quantité doit être entière. Seuls les litres acceptent les décimales.",
      );
    if (value.capacity != null && !Number.isInteger(value.capacity))
      fail(400, "La capacité doit être un nombre entier de places.");
    if (
      value.capacity != null &&
      !Number.isSafeInteger(value.quantity * value.capacity)
    )
      fail(400, "Le nombre total de places est trop élevé.");
  }
  function validateTarget(item: Pick<Item, "unit" | "target">) {
    if (
      item.target !== null &&
      item.unit !== "L" &&
      !Number.isInteger(item.target)
    )
      fail(
        400,
        "L’objectif doit être entier. Seuls les litres acceptent les décimales.",
      );
  }
  function notify(eventId: string) {
    for (const [client, subscription] of subscriptions)
      if (subscription === eventId && client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify({ type: "changed" }));
  }
  const buckets = new Map<string, { count: number; until: number }>();
  function limit(req: Request, key: string, max: number, windowMs: number) {
    const id = key + ":" + (req.socket.remoteAddress || "unknown");
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || b.until < now) {
      b = { count: 0, until: now + windowMs };
      buckets.set(id, b);
    }
    if (++b.count > max)
      fail(429, "Trop de tentatives. Réessayez dans quelques minutes.");
    if (buckets.size > 10000)
      for (const [k, v] of buckets) if (v.until < now) buckets.delete(k);
  }
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  });
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  app.use("/api", (req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.header("Origin");
      const allowed = new Set([`${req.protocol}://${req.get("host")}`]);
      if (options.publicUrl) allowed.add(new URL(options.publicUrl).origin);
      if (!options.production) {
        allowed.add("http://localhost:5173");
        allowed.add("http://127.0.0.1:5173");
      }
      if (
        (origin && !allowed.has(origin)) ||
        req.header("Sec-Fetch-Site") === "cross-site"
      )
        return next(new ApiError(403, "Origine de la requête refusée."));
      if (!req.is("application/json") && req.method !== "DELETE")
        return next(new ApiError(415, "Le format JSON est requis."));
      try {
        limit(req, "mutations", 300, 60_000);
      } catch (error) {
        return next(error);
      }
    }
    next();
  });
  app.get("/api/health", (_req, res) => {
    db.prepare("SELECT 1").get();
    res.json({ ok: true });
  });
  app.get("/api/session", (req, res) => {
    const { admin, actor } = decode(req);
    res.json({ admin, actor });
  });
  app.post("/api/identity", (req, res) => {
    limit(req, "identity", 30, 60_000);
    const { name } = z.object({ name: text }).parse(req.body);
    const session = decode(req);
    const result = { admin: session.admin, actor: name };
    saveSession(res, result);
    res.json(result);
  });
  app.post("/api/admin/login", (req, res) => {
    limit(req, "login", 10, 15 * 60_000);
    const { password } = z
      .object({ password: z.string().min(1).max(1024) })
      .parse(req.body);
    if (
      !timingSafeEqual(
        passwordHash,
        scryptSync(password, "dumbfood-admin-v1", 64),
      )
    )
      fail(401, "Mot de passe incorrect.");
    const result = { admin: true, actor: decode(req).actor || "Admin" };
    saveSession(res, result);
    res.json(result);
  });
  app.post("/api/admin/logout", (req, res) => {
    const result = { admin: false, actor: decode(req).actor };
    saveSession(res, result);
    res.json(result);
  });
  app.get("/api/events", (req, res) => {
    auth(req, true);
    res.json(
      db.prepare("SELECT * FROM events ORDER BY date DESC").all().map(eventRow),
    );
  });
  app.post("/api/events", (req, res) => {
    auth(req, true);
    const input = z.object(eventFields).strict().parse(req.body);
    const event: MealEvent = {
      id: randomUUID(),
      ...input,
      shareToken: newToken(),
      archived: false,
      version: 1,
    };
    transaction(db, () => {
      db.prepare(
        "INSERT INTO events(id,title,date,location,address,description,shareToken) VALUES(?,?,?,?,?,?,?)",
      ).run(
        event.id,
        event.title,
        event.date,
        event.location,
        event.address,
        event.description,
        event.shareToken,
      );
      audit(db, event.id, actor(req), "a créé le repas.");
    });
    res.status(201).json(event);
  });
  app.patch("/api/events/:eventId", (req, res) => {
    auth(req, true);
    const input = z
      .object({
        title: text,
        date,
        location: z.string().trim().max(200),
        address: z.string().trim().max(500),
        description: z.string().trim().max(2000),
        archived: z.boolean(),
      })
      .partial()
      .extend({ version })
      .strict()
      .parse(req.body);
    const old = eventRow(
      db
        .prepare("SELECT * FROM events WHERE id=?")
        .get(String(req.params.eventId)),
    );
    if (!old) fail(404, "Ce repas est introuvable.");
    const updated = transaction(db, () => {
      checkVersion(old.version, input.version);
      const value = { ...old, ...input, version: old.version + 1 };
      db.prepare(
        "UPDATE events SET title=?,date=?,location=?,address=?,description=?,archived=?,version=? WHERE id=?",
      ).run(
        value.title,
        value.date,
        value.location,
        value.address,
        value.description,
        Number(value.archived),
        value.version,
        value.id,
      );
      audit(db, value.id, actor(req), "a modifié les informations du repas.");
      return value;
    });
    notify(old.id);
    res.json(updated);
  });
  app.delete("/api/events/:eventId", (req, res) => {
    auth(req, true);
    const eventId = String(req.params.eventId);
    const old = eventRow(
      db.prepare("SELECT * FROM events WHERE id=?").get(eventId),
    );
    if (!old) fail(404, "Ce repas est introuvable.");
    const expected = z.coerce
      .number()
      .int()
      .positive()
      .parse(req.query.version);
    checkVersion(old.version, expected);
    db.prepare("DELETE FROM events WHERE id=?").run(eventId);
    notify(eventId);
    res.json({ ok: true });
  });
  app.get("/api/events/:shareToken", (req, res) => {
    const event = requireEvent(String(req.params.shareToken));
    res.json(snapshot(db, event));
  });
  app.post("/api/events/:shareToken/participants", (req, res) => {
    auth(req);
    const event = requireEvent(String(req.params.shareToken));
    const { name } = z.object({ name: text }).strict().parse(req.body);
    const existing = (
      db
        .prepare("SELECT * FROM participants WHERE eventId=?")
        .all(event.id) as unknown as Participant[]
    ).find(
      (p) => p.name.toLocaleLowerCase("fr") === name.toLocaleLowerCase("fr"),
    );
    if (existing) {
      res.json(existing);
      return;
    }
    const participant = { id: randomUUID(), eventId: event.id, name };
    transaction(db, () => {
      db.prepare("INSERT INTO participants(id,eventId,name) VALUES(?,?,?)").run(
        participant.id,
        event.id,
        name,
      );
      audit(db, event.id, actor(req), `a ajouté ${name} aux participants.`);
    });
    notify(event.id);
    res.status(201).json(participant);
  });
  app.post("/api/events/:shareToken/items", (req, res) => {
    const session = auth(req);
    const event = requireEvent(String(req.params.shareToken));
    const input = z
      .object({
        ...itemFields,
        participantId: z.string().min(1).optional(),
        quantity: quantity.optional(),
        capacity: quantity.nullable().optional(),
        note: z.string().trim().max(500).default(""),
      })
      .strict()
      .parse(req.body);
    if (!session.admin && input.target !== null)
      fail(403, "Seul l’administrateur peut définir un objectif.");
    if ((input.quantity !== undefined) !== (input.participantId !== undefined))
      fail(400, "Indiquez la personne et la quantité de l’apport.");
    if (input.capacity != null && input.quantity === undefined)
      fail(400, "Une capacité nécessite un apport.");
    const item: Item = {
      id: randomUUID(),
      eventId: event.id,
      name: input.name,
      category: input.category,
      unit: input.unit,
      target: input.target,
      version: 1,
    };
    transaction(db, () => {
      validateTarget(item);
      if (input.participantId) participantFor(input.participantId, event.id);
      if (input.quantity !== undefined)
        validateContribution(item, {
          quantity: input.quantity,
          capacity: input.capacity,
        });
      db.prepare(
        "INSERT INTO items(id,eventId,name,category,unit,target) VALUES(?,?,?,?,?,?)",
      ).run(
        item.id,
        item.eventId,
        item.name,
        item.category,
        item.unit,
        item.target,
      );
      if (input.quantity !== undefined)
        db.prepare(
          "INSERT INTO contributions(id,itemId,participantId,quantity,capacity,note) VALUES(?,?,?,?,?,?)",
        ).run(
          randomUUID(),
          item.id,
          input.participantId!,
          input.quantity,
          input.capacity ?? null,
          input.note,
        );
      audit(db, event.id, actor(req), `a ajouté « ${item.name} » à la liste.`);
    });
    notify(event.id);
    res.status(201).json(item);
  });
  app.patch("/api/items/:id", (req, res) => {
    auth(req, true);
    const old = itemById(String(req.params.id));
    const event = scope(req, old.eventId);
    const input = z
      .object({
        name: text,
        category: itemFields.category,
        unit: itemFields.unit,
        target: quantity.nullable(),
      })
      .partial()
      .extend({ version })
      .strict()
      .parse(req.body);
    const updated = transaction(db, () => {
      checkVersion(old.version, input.version);
      if (
        input.unit &&
        input.unit !== old.unit &&
        Number(
          db
            .prepare("SELECT COUNT(*) n FROM contributions WHERE itemId=?")
            .get(old.id)?.n,
        ) > 0
      )
        fail(409, "Retirez les apports avant de changer l’unité.");
      const value = { ...old, ...input, version: old.version + 1 };
      if (input.target !== undefined || input.unit !== undefined)
        validateTarget(value);
      db.prepare(
        "UPDATE items SET name=?,category=?,unit=?,target=?,version=? WHERE id=?",
      ).run(
        value.name,
        value.category,
        value.unit,
        value.target,
        value.version,
        value.id,
      );
      audit(db, event.id, actor(req), `a modifié « ${value.name} ».`);
      return value;
    });
    notify(event.id);
    res.json(updated);
  });
  app.delete("/api/items/:id", (req, res) => {
    auth(req, true);
    const old = itemById(String(req.params.id));
    const event = scope(req, old.eventId);
    const expected = z.coerce
      .number()
      .int()
      .positive()
      .parse(req.query.version);
    transaction(db, () => {
      checkVersion(old.version, expected);
      db.prepare("DELETE FROM items WHERE id=?").run(old.id);
      audit(
        db,
        event.id,
        actor(req),
        `a supprimé « ${old.name} » et ses apports.`,
      );
    });
    notify(event.id);
    res.json({ ok: true });
  });
  app.post("/api/events/:shareToken/contributions", (req, res) => {
    auth(req);
    const event = requireEvent(String(req.params.shareToken));
    scope(req, event.id);
    const input = z.object(contributionFields).strict().parse(req.body);
    const item = itemById(input.itemId);
    if (item.eventId !== event.id) fail(404, "Cet élément est introuvable.");
    const person = participantFor(input.participantId, event.id);
    validateContribution(item, input);
    const contribution: Contribution = {
      id: randomUUID(),
      ...input,
      capacity: input.capacity ?? null,
      version: 1,
    };
    transaction(db, () => {
      db.prepare(
        "INSERT INTO contributions(id,itemId,participantId,quantity,capacity,note) VALUES(?,?,?,?,?,?)",
      ).run(
        contribution.id,
        contribution.itemId,
        contribution.participantId,
        contribution.quantity,
        contribution.capacity,
        contribution.note,
      );
      audit(
        db,
        event.id,
        actor(req),
        `a ajouté un apport de ${person.name} pour « ${item.name} ».`,
      );
    });
    notify(event.id);
    res.status(201).json(contribution);
  });
  app.patch("/api/contributions/:id", (req, res) => {
    auth(req);
    const old = contributionById(String(req.params.id));
    const item = itemById(old.itemId);
    const event = scope(req, item.eventId);
    const input = z
      .object({
        participantId: contributionFields.participantId,
        quantity,
        capacity: quantity.nullable(),
        note: z.string().trim().max(500),
      })
      .partial()
      .extend({ version })
      .strict()
      .parse(req.body);
    const updated = transaction(db, () => {
      checkVersion(old.version, input.version);
      const value = { ...old, ...input, version: old.version + 1 };
      const person = participantFor(value.participantId, event.id);
      validateContribution(item, value, input.quantity !== undefined);
      db.prepare(
        "UPDATE contributions SET participantId=?,quantity=?,capacity=?,note=?,version=? WHERE id=?",
      ).run(
        value.participantId,
        value.quantity,
        value.capacity,
        value.note,
        value.version,
        value.id,
      );
      audit(
        db,
        event.id,
        actor(req),
        `a modifié l’apport de ${person.name} pour « ${item.name} ».`,
      );
      return value;
    });
    notify(event.id);
    res.json(updated);
  });
  app.delete("/api/contributions/:id", (req, res) => {
    auth(req);
    const old = contributionById(String(req.params.id));
    const item = itemById(old.itemId);
    const event = scope(req, item.eventId);
    const expected = z.coerce
      .number()
      .int()
      .positive()
      .parse(req.query.version);
    transaction(db, () => {
      checkVersion(old.version, expected);
      const person = participantFor(old.participantId, event.id);
      db.prepare("DELETE FROM contributions WHERE id=?").run(old.id);
      audit(
        db,
        event.id,
        actor(req),
        `a retiré l’apport de ${person.name} pour « ${item.name} ».`,
      );
    });
    notify(event.id);
    res.json({ ok: true });
  });
  app.use("/api", (_req, _res, next) =>
    next(new ApiError(404, "Cette adresse est introuvable.")),
  );
  if (options.production) {
    app.use(express.static(resolve("dist"), { index: false, maxAge: "1h" }));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve("dist/index.html")),
    );
  }
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: "Vérifiez les informations saisies.",
          details: error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (
        error &&
        typeof error === "object" &&
        "type" in error &&
        error.type === "entity.too.large"
      ) {
        res.status(413).json({
          error: "Le contenu envoyé est trop volumineux (16 Ko maximum).",
        });
        return;
      }
      if (error instanceof SyntaxError && "body" in error) {
        res.status(400).json({ error: "Le contenu JSON est invalide." });
        return;
      }
      console.error(
        "Erreur serveur:",
        error instanceof Error ? error.message : "erreur inconnue",
      );
      res.status(500).json({ error: "Une erreur est survenue. Réessayez." });
    },
  );
  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      const event = findEvent(db, url.searchParams.get("event") || "");
      if (!event) {
        socket.destroy();
        return;
      }
      const origin = req.headers.origin;
      const allowed = new Set([
        `http://${req.headers.host}`,
        `https://${req.headers.host}`,
      ]);
      if (options.publicUrl) allowed.add(new URL(options.publicUrl).origin);
      if (!options.production) {
        allowed.add("http://localhost:5173");
        allowed.add("http://127.0.0.1:5173");
      }
      if (origin && !allowed.has(origin)) {
        socket.destroy();
        return;
      }
      ws.handleUpgrade(req, socket, head, (client) => {
        subscriptions.set(client, event.id);
        client.on("close", () => subscriptions.delete(client));
        client.on("error", () => subscriptions.delete(client));
        client.send(JSON.stringify({ type: "connected" }));
      });
    } catch {
      socket.destroy();
    }
  });
  const heartbeat = setInterval(() => {
    for (const client of subscriptions.keys()) {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }, 25_000);
  heartbeat.unref();
  const close = async () => {
    clearInterval(heartbeat);
    for (const client of subscriptions.keys()) client.terminate();
    ws.close();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    db.close();
  };
  return { app, db, server, close };
}
