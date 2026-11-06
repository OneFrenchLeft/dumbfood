import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import WebSocket from "ws";
import type {
  Contribution,
  EventSnapshot,
  Item,
  MealEvent,
  Participant,
} from "../shared/types.js";

const password = "integration-password-not-for-production";
const temporary = await mkdtemp(join(tmpdir(), "dumbfood-test-"));
const reservation = createServer().listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = (reservation.address() as { port: number }).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
let process: ChildProcess | undefined;
let output = "";

async function startServer() {
  output = "";
  process = spawn(
    globalThis.process.execPath,
    ["--import", "tsx", "server/index.ts"],
    {
      cwd: globalThis.process.cwd(),
      env: {
        ...globalThis.process.env,
        PORT: String(port),
        DB_PATH: join(temporary, "test.db"),
        ADMIN_PASSWORD: password,
        SESSION_SECRET:
          "integration-secret-with-at-least-thirty-two-characters",
        NODE_ENV: "test",
        DEMO_DATA: "false",
        COOKIE_SECURE: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  process.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  process.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {
      /* wait for bind */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become healthy: ${output}`);
}

async function stopServer() {
  const child = process;
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timer);
  process = undefined;
}

class Client {
  cookie = "";
  async request(
    method: string,
    path: string,
    body?: unknown,
    eventToken?: string,
  ) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(eventToken ? { "X-Event-Token": eventToken } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length)
      this.cookie = cookies.map((cookie) => cookie.split(";")[0]).join("; ");
    const data = await response.json().catch(() => null);
    return { status: response.status, data, headers: response.headers };
  }
  async ok(method: string, path: string, body?: unknown, token?: string) {
    const result = await this.request(method, path, body, token);
    assert.ok(
      result.status >= 200 && result.status < 300,
      `${method} ${path}: ${result.status} ${JSON.stringify(result.data)}`,
    );
    return result.data;
  }
}

const admin = new Client();
const anne = new Client();
const thomas = new Client();
const anonymous = new Client();
let sequence = 0;
async function createEvent(): Promise<MealEvent> {
  const title = `Repas de test ${++sequence}`;
  await admin.ok("POST", "/api/events", {
    title,
    date: "2026-11-21T19:30",
    location: "Chez Anne",
    description: "Un repas partagé",
  });
  const events: MealEvent[] = await admin.ok("GET", "/api/events");
  const event = events.find((entry) => entry.title === title);
  assert.ok(event);
  return event;
}
async function read(event: MealEvent): Promise<EventSnapshot> {
  return anonymous.ok("GET", `/api/events/${event.shareToken}`);
}
async function person(
  client: Client,
  event: MealEvent,
  name: string,
): Promise<Participant> {
  await client.ok("POST", `/api/events/${event.shareToken}/participants`, {
    name,
  });
  const result = (await read(event)).participants.find(
    (entry) => entry.name === name,
  );
  assert.ok(result);
  return result;
}
async function item(
  event: MealEvent,
  name: string,
  unit: string = "g",
  target: number | null = 1000,
): Promise<Item> {
  await admin.ok("POST", `/api/events/${event.shareToken}/items`, {
    name,
    unit,
    target,
    category: unit === "place" ? "equipment" : "ingredient",
  });
  const result = (await read(event)).items.find((entry) => entry.name === name);
  assert.ok(result);
  return result;
}
async function contribution(
  client: Client,
  event: MealEvent,
  entry: Item,
  participant: Participant,
  quantity: number,
  capacity?: number,
): Promise<Contribution> {
  await client.ok(
    "POST",
    `/api/events/${event.shareToken}/contributions`,
    { itemId: entry.id, participantId: participant.id, quantity, capacity },
    event.shareToken,
  );
  const result = (await read(event)).contributions
    .filter(
      (row) => row.itemId === entry.id && row.participantId === participant.id,
    )
    .at(-1);
  assert.ok(result);
  return result;
}

before(async () => {
  await startServer();
  await admin.ok("POST", "/api/admin/login", { password });
  await anne.ok("POST", "/api/identity", { name: "Anne" });
  await thomas.ok("POST", "/api/identity", { name: "Thomas" });
});
after(async () => {
  await stopServer();
  await rm(temporary, { recursive: true, force: true });
});

test("administration requires the password, and a shared event can be read without editing rights", async () => {
  assert.equal(
    (
      await anonymous.request("POST", "/api/admin/login", {
        password: "incorrect",
      })
    ).status,
    401,
  );
  assert.equal((await anonymous.request("GET", "/api/events")).status, 403);
  assert.equal((await admin.ok("GET", "/api/session")).admin, true);
  const event = await createEvent();
  assert.equal((await read(event)).event.title, event.title);
  assert.equal(
    (
      await anonymous.request(
        "POST",
        `/api/events/${event.shareToken}/participants`,
        { name: "Invité" },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await anne.request("PATCH", `/api/events/${event.id}`, {
        title: "Titre détourné",
        version: event.version,
      })
    ).status,
    403,
  );
  assert.equal(
    (await anne.request("DELETE", `/api/events/${event.id}`)).status,
    403,
  );
});

test("participants add free items, while only the admin can set goals or change the shared structure", async () => {
  const event = await createEvent();
  const participant = await person(anne, event, "Anne");
  await anne.ok("POST", `/api/events/${event.shareToken}/items`, {
    name: "Pain",
    category: "ingredient",
    unit: "piece",
    target: null,
    participantId: participant.id,
    quantity: 2,
  });
  const snapshot = await read(event);
  const bread = snapshot.items.find((row) => row.name === "Pain")!;
  assert.equal(bread.target, null);
  assert.equal(
    snapshot.contributions.find((row) => row.itemId === bread.id)?.quantity,
    2,
  );
  assert.equal(
    (
      await anne.request("POST", `/api/events/${event.shareToken}/items`, {
        name: "Objectif interdit",
        category: "ingredient",
        unit: "g",
        target: 200,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await anne.request(
        "PATCH",
        `/api/items/${bread.id}`,
        { name: "Baguettes", version: bread.version },
        event.shareToken,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await anne.request(
        "DELETE",
        `/api/items/${bread.id}?version=${bread.version}`,
        undefined,
        event.shareToken,
      )
    ).status,
    403,
  );
  await admin.ok(
    "PATCH",
    `/api/items/${bread.id}`,
    { target: 6, version: bread.version },
    event.shareToken,
  );
  assert.equal(
    (await read(event)).items.find((row) => row.id === bread.id)?.target,
    6,
  );
});

test("fixed goals and free items coexist, including over-target quantities and appliance capacities", async () => {
  const event = await createEvent();
  const participant = await person(anne, event, "Anne");
  const cheese = await item(event, "Fromage", "g", 2400);
  const drinks = await item(event, "Boissons", "L", null);
  const appliance = await item(event, "Raclette", "place", 12);
  await contribution(anne, event, cheese, participant, 2640);
  await contribution(anne, event, drinks, participant, 1.5);
  await contribution(anne, event, appliance, participant, 2, 8);
  const snapshot = await read(event);
  assert.equal(
    snapshot.items.find((row) => row.id === drinks.id)?.target,
    null,
  );
  assert.equal(
    snapshot.contributions.find((row) => row.itemId === cheese.id)?.quantity,
    2640,
  );
  const devices = snapshot.contributions.find(
    (row) => row.itemId === appliance.id,
  )!;
  assert.equal(devices.quantity * devices.capacity!, 16);
});

test("renaming a meal or item preserves its date, location, unit and goal", async () => {
  const event = await createEvent();
  const cheese = await item(event, "Fromage", "g", 2400);
  await admin.ok("PATCH", `/api/events/${event.id}`, {
    title: "Raclette renommée",
    version: event.version,
  });
  await admin.ok(
    "PATCH",
    `/api/items/${cheese.id}`,
    { name: "Fromage de Savoie", version: cheese.version },
    event.shareToken,
  );
  const snapshot = await read(event);
  assert.equal(snapshot.event.title, "Raclette renommée");
  assert.equal(snapshot.event.date, event.date);
  assert.equal(snapshot.event.location, event.location);
  assert.equal(snapshot.event.description, event.description);
  const renamed = snapshot.items.find((row) => row.id === cheese.id)!;
  assert.equal(renamed.name, "Fromage de Savoie");
  assert.equal(renamed.unit, "g");
  assert.equal(renamed.category, "ingredient");
  assert.equal(renamed.target, 2400);
});

test("Thomas can edit Anne’s contribution, with the contributor and audit author kept distinct", async () => {
  const event = await createEvent();
  const participant = await person(anne, event, "Anne");
  const cheese = await item(event, "Fromage");
  const initial = await contribution(anne, event, cheese, participant, 300);
  await thomas.ok(
    "PATCH",
    `/api/contributions/${initial.id}`,
    { quantity: 500, note: "Pour Anne", version: initial.version },
    event.shareToken,
  );
  const snapshot = await read(event);
  const updated = snapshot.contributions.find((row) => row.id === initial.id)!;
  assert.equal(updated.quantity, 500);
  assert.equal(updated.participantId, participant.id);
  assert.equal(snapshot.activity[0].actor, "Thomas");
  assert.match(snapshot.activity[0].description, /Anne/);
  await thomas.ok(
    "DELETE",
    `/api/contributions/${updated.id}?version=${updated.version}`,
    undefined,
    event.shareToken,
  );
  assert.ok(
    !(await read(event)).contributions.some((row) => row.id === initial.id),
  );
  assert.ok(
    (await read(event)).items.some((row) => row.id === cheese.id),
    "Removing an apport must preserve the shared item",
  );
});

test("invalid quantities and capacities are rejected without creating partial records", async () => {
  const event = await createEvent();
  const participant = await person(anne, event, "Anne");
  const cheese = await item(event, "Fromage");
  for (const quantity of [0, -1, null, "100"]) {
    assert.equal(
      (
        await anne.request(
          "POST",
          `/api/events/${event.shareToken}/contributions`,
          { itemId: cheese.id, participantId: participant.id, quantity },
          event.shareToken,
        )
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await anne.request(
        "POST",
        `/api/events/${event.shareToken}/contributions`,
        {
          itemId: cheese.id,
          participantId: participant.id,
          quantity: 1,
          capacity: 8,
        },
        event.shareToken,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await admin.request("POST", `/api/events/${event.shareToken}/items`, {
        name: "Objectif nul",
        category: "ingredient",
        unit: "g",
        target: 0,
      })
    ).status,
    400,
  );
  assert.equal((await read(event)).contributions.length, 0);
});

test("calendar dates reject nonexistent days and accept the next leap-year February 29", async () => {
  const initialEvents: MealEvent[] = await admin.ok("GET", "/api/events");
  for (const date of [
    "2026-02-30T19:30",
    "2026-02-29T19:30",
    "2026-04-31T19:30",
    "2026-13-01T19:30",
    "2026-11-21T24:00",
    "2026-11-21T19:60",
  ]) {
    const result = await admin.request("POST", "/api/events", {
      title: "Date impossible",
      date,
      location: "",
      description: "",
    });
    assert.equal(result.status, 400, `The date ${date} must be rejected`);
  }
  assert.equal(
    (await admin.ok("GET", "/api/events")).length,
    initialEvents.length,
  );
  await admin.ok("POST", "/api/events", {
    title: "Repas bissextile",
    date: "2028-02-29T19:30",
    location: "",
    description: "",
  });
  const leapEvent = (
    (await admin.ok("GET", "/api/events")) as MealEvent[]
  ).find((event) => event.title === "Repas bissextile");
  assert.ok(leapEvent);
  assert.equal(leapEvent.date, "2028-02-29T19:30");
  assert.equal(
    (
      await admin.request("PATCH", `/api/events/${leapEvent.id}`, {
        date: "2028-02-30T19:30",
        version: leapEvent.version,
      })
    ).status,
    400,
  );
  assert.equal((await read(leapEvent)).event.date, "2028-02-29T19:30");
});

test("oversized JSON payloads return a structured HTTP 413 error", async () => {
  const result = await admin.request("POST", "/api/events", {
    title: "Contenu trop volumineux",
    date: "2026-11-21T19:30",
    description: "x".repeat(20_000),
  });
  assert.equal(result.status, 413);
  assert.match(result.headers.get("content-type") || "", /application\/json/);
  assert.equal(typeof result.data?.error, "string");
  assert.ok(result.data.error.length > 0);
});

test("appliance capacities cannot produce an unsafe total on creation, edit, or combined item creation", async () => {
  const event = await createEvent();
  const participant = await person(anne, event, "Anne");
  const appliance = await item(event, "Appareils", "place", 12);
  const body = {
    itemId: appliance.id,
    participantId: participant.id,
    quantity: 1_000_000_000,
    capacity: 1_000_000_000,
  };
  assert.equal(
    (
      await anne.request(
        "POST",
        `/api/events/${event.shareToken}/contributions`,
        body,
        event.shareToken,
      )
    ).status,
    400,
  );
  assert.equal((await read(event)).contributions.length, 0);
  const valid = await contribution(anne, event, appliance, participant, 1, 6);
  assert.equal(
    (
      await anne.request(
        "PATCH",
        `/api/contributions/${valid.id}`,
        {
          quantity: body.quantity,
          capacity: body.capacity,
          version: valid.version,
        },
        event.shareToken,
      )
    ).status,
    400,
  );
  const unchanged = (await read(event)).contributions.find(
    (entry) => entry.id === valid.id,
  )!;
  assert.equal(unchanged.quantity, 1);
  assert.equal(unchanged.capacity, 6);
  assert.equal(unchanged.version, valid.version);
  assert.equal(
    (
      await anne.request("POST", `/api/events/${event.shareToken}/items`, {
        name: "Trop de places",
        category: "equipment",
        unit: "place",
        target: null,
        participantId: participant.id,
        quantity: body.quantity,
        capacity: body.capacity,
      })
    ).status,
    400,
  );
  assert.equal(
    (await read(event)).items.length,
    1,
    "Rejected combined creation must not leave a partial item",
  );
});

test("a stale contribution version cannot silently overwrite or delete another person’s change", async () => {
  const event = await createEvent();
  const participant = await person(anne, event, "Anne");
  const cheese = await item(event, "Fromage");
  const initial = await contribution(anne, event, cheese, participant, 300);
  await anne.ok(
    "PATCH",
    `/api/contributions/${initial.id}`,
    { quantity: 400, version: initial.version },
    event.shareToken,
  );
  assert.equal(
    (
      await thomas.request(
        "PATCH",
        `/api/contributions/${initial.id}`,
        { quantity: 900, version: initial.version },
        event.shareToken,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await thomas.request(
        "DELETE",
        `/api/contributions/${initial.id}?version=${initial.version}`,
        undefined,
        event.shareToken,
      )
    ).status,
    409,
  );
  assert.equal(
    (await read(event)).contributions.find((row) => row.id === initial.id)
      ?.quantity,
    400,
  );
});

test("the event link scopes mutations and prevents mixing people or items from different meals", async () => {
  const first = await createEvent();
  const second = await createEvent();
  const firstPerson = await person(anne, first, "Anne");
  const secondPerson = await person(thomas, second, "Thomas");
  const firstItem = await item(first, "Fromage");
  const initial = await contribution(anne, first, firstItem, firstPerson, 300);
  const forged = await thomas.request(
    "PATCH",
    `/api/contributions/${initial.id}`,
    { quantity: 999, version: initial.version },
    second.shareToken,
  );
  assert.ok(
    [403, 404].includes(forged.status),
    `Expected scope denial, got ${forged.status}`,
  );
  const crossPerson = await anne.request(
    "POST",
    `/api/events/${first.shareToken}/contributions`,
    { itemId: firstItem.id, participantId: secondPerson.id, quantity: 200 },
    first.shareToken,
  );
  assert.ok([400, 403, 404].includes(crossPerson.status));
  assert.equal((await read(first)).contributions.length, 1);
  assert.equal((await read(first)).contributions[0].quantity, 300);
});

test("two connected phones receive updates for their meal only", async () => {
  const event = await createEvent();
  const unrelated = await createEvent();
  const participant = await person(anne, event, "Anne");
  const cheese = await item(event, "Fromage");
  const connections = [
    event.shareToken,
    event.shareToken,
    unrelated.shareToken,
  ].map(
    (token) =>
      new WebSocket(`ws://127.0.0.1:${port}/ws?event=${token}`, { origin }),
  );
  try {
    await Promise.all(connections.map((socket) => once(socket, "open")));
    let unrelatedChanged = false;
    connections[2].on("message", (message) => {
      if (JSON.parse(String(message)).type === "changed")
        unrelatedChanged = true;
    });
    const changes = connections.slice(0, 2).map(
      (socket) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("No real-time update received")),
            2000,
          );
          socket.on("message", (message) => {
            if (JSON.parse(String(message)).type === "changed") {
              clearTimeout(timer);
              resolve();
            }
          });
        }),
    );
    await contribution(anne, event, cheese, participant, 250);
    await Promise.all(changes);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(unrelatedChanged, false);
  } finally {
    for (const socket of connections) socket.terminate();
  }
});

test("meals and contributions survive a server restart", async () => {
  const event = await createEvent();
  const participant = await person(anne, event, "Anne");
  const cheese = await item(event, "Fromage");
  const initial = await contribution(anne, event, cheese, participant, 750);
  await stopServer();
  await startServer();
  const snapshot = await read(event);
  assert.equal(snapshot.event.title, event.title);
  assert.equal(
    snapshot.contributions.find((row) => row.id === initial.id)?.quantity,
    750,
  );
  assert.equal(
    (await admin.ok("GET", "/api/session")).admin,
    true,
    "Signed admin session remains valid after restart",
  );
});
