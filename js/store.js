// Datalager. Samma gränssnitt för Supabase och demoläget, så att vyerna
// inte behöver veta var datan ligger.
import { config } from "./config.js";
import { demoSeed } from "./demo-data.js";

const TABLES = ["members", "settings", "buckets", "allocations", "transfers", "transactions", "rules", "bank_connections", "quick_tokens"];

export async function createStore() {
  const demo = !config.SUPABASE_URL || new URLSearchParams(location.search).has("demo");
  return demo ? createDemoStore() : createSupabaseStore();
}

// --- Supabase ---------------------------------------------------------------

async function createSupabaseStore() {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm");
  const sb = createClient(config.SUPABASE_URL, config.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  const check = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };

  async function selectAll(table) {
    // Supabase returnerar max 1000 rader per anrop.
    const rows = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(table).select("*").range(from, from + 999);
      if (table === "transactions") q = q.order("date", { ascending: false }).order("created_at", { ascending: false });
      const page = check(await q);
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  }

  return {
    demo: false,
    async session() {
      return check(await sb.auth.getSession()).session;
    },
    onAuthChange(cb) {
      sb.auth.onAuthStateChange((_event, session) => cb(session));
    },
    async signIn(email, password) {
      check(await sb.auth.signInWithPassword({ email, password }));
    },
    async signOut() {
      await sb.auth.signOut();
    },
    async loadAll() {
      const results = await Promise.all(TABLES.map(selectAll));
      const db = Object.fromEntries(TABLES.map((t, i) => [t, results[i]]));
      db.settings = db.settings[0] ?? { period_start_day: 25, start_balance: 0, start_date: null };
      return db;
    },
    subscribe(onChange) {
      let timer;
      const fire = () => {
        clearTimeout(timer);
        timer = setTimeout(onChange, 400);
      };
      const channel = sb.channel("budgie");
      for (const table of ["transactions", "transfers", "buckets", "allocations"]) {
        channel.on("postgres_changes", { event: "*", schema: "public", table }, fire);
      }
      channel.subscribe();
    },
    async insert(table, rows) {
      return check(await sb.from(table).insert(rows).select());
    },
    async insertIgnoreDuplicates(table, rows, onConflict) {
      if (!rows.length) return;
      check(await sb.from(table).upsert(rows, { onConflict, ignoreDuplicates: true }));
    },
    async update(table, match, patch) {
      check(await sb.from(table).update(patch).match(match));
    },
    async updateMany(table, ids, patch) {
      if (!ids.length) return;
      check(await sb.from(table).update(patch).in("id", ids));
    },
    async remove(table, match) {
      check(await sb.from(table).delete().match(match));
    },
    async api(action, payload = {}) {
      const { data, error } = await sb.functions.invoke("api", { body: { action, ...payload } });
      if (error) {
        let message = error.message;
        try {
          message = (await error.context.json()).error || message;
        } catch {}
        throw new Error(message);
      }
      return data;
    },
    functionsUrl: `${config.SUPABASE_URL}/functions/v1`,
  };
}

// --- Demoläge ---------------------------------------------------------------

const DEMO_KEY = "budgie-demo-v1";

function createDemoStore() {
  let db;
  try {
    db = JSON.parse(localStorage.getItem(DEMO_KEY));
  } catch {}
  if (!db) db = demoSeed();

  const save = () => {
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(db));
    } catch {}
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  const matches = (row, match) => Object.entries(match).every(([k, v]) => row[k] === v);
  const tableRows = (table) => (table === "settings" ? [db.settings] : (db[table] ??= []));
  const withDefaults = (table, row) => ({
    ...(table === "transactions" ? { status: "manual", categorized_by: "none", kind: "expense" } : {}),
    ...(row.id || table === "settings" || table === "push_subscriptions" || table === "quick_tokens" ? {} : { id: uuid() }),
    created_at: new Date().toISOString(),
    ...row,
  });

  return {
    demo: true,
    async session() {
      return { user: { id: db.members[0].user_id, email: "demo@budgie" } };
    },
    onAuthChange() {},
    async signIn() {},
    async signOut() {
      localStorage.removeItem(DEMO_KEY);
      location.reload();
    },
    async loadAll() {
      return structuredClone(db);
    },
    subscribe() {},
    async insert(table, rows) {
      const list = (Array.isArray(rows) ? rows : [rows]).map((r) => withDefaults(table, r));
      tableRows(table).push(...list);
      save();
      return structuredClone(list);
    },
    async insertIgnoreDuplicates(table, rows, onConflict) {
      const keys = onConflict.split(",");
      const existing = new Set(tableRows(table).map((r) => keys.map((k) => r[k]).join("|")));
      const fresh = rows.filter((r) => !existing.has(keys.map((k) => r[k]).join("|")));
      tableRows(table).push(...fresh.map((r) => withDefaults(table, r)));
      save();
    },
    async update(table, match, patch) {
      for (const row of tableRows(table)) if (matches(row, match)) Object.assign(row, patch);
      save();
    },
    async updateMany(table, ids, patch) {
      for (const row of tableRows(table)) if (ids.includes(row.id)) Object.assign(row, patch);
      save();
    },
    async remove(table, match) {
      db[table] = tableRows(table).filter((row) => !matches(row, match));
      save();
    },
    async api(action) {
      if (action === "sync") return { imported: 0, message: "Demoläge: ingen riktig bank är kopplad." };
      if (action === "start") throw new Error("I demoläget går det inte att koppla banken.");
      if (action === "push-test") throw new Error("I demoläget skickas inga notiser.");
      return {};
    },
    functionsUrl: "https://<projekt>.supabase.co/functions/v1",
    resetDemo() {
      localStorage.removeItem(DEMO_KEY);
      location.reload();
    },
  };
}
