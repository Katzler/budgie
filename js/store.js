// Datalager. Samma gränssnitt för Supabase och demoläget, så att vyerna
// inte behöver veta var datan ligger.
import { config } from "./config.js";
import { demoSeed } from "./demo-data.js";
import { computeBudget, todayInSweden } from "../supabase/functions/_shared/budget.js";
import { addDays, dayLocked, planClaim } from "./quests.js";

const TABLES = ["members", "settings", "buckets", "allocations", "transfers", "transactions", "rules", "bank_connections", "quick_tokens", "quests", "quest_checks", "quest_claims"];

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
      for (const table of ["transactions", "transfers", "buckets", "allocations", "quest_checks", "quest_claims"]) {
        channel.on("postgres_changes", { event: "*", schema: "public", table }, fire);
      }
      channel.subscribe();
    },
    async insert(table, rows) {
      return check(await sb.from(table).insert(rows).select());
    },
    async upsert(table, rows, onConflict) {
      if (!rows.length) return;
      check(await sb.from(table).upsert(rows, { onConflict }));
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
    async rpc(name, args) {
      return check(await sb.rpc(name, args));
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

const DEMO_KEY = "budgie-demo-v6";

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
    async upsert(table, rows, onConflict) {
      const keys = onConflict.split(",");
      for (const r of rows) {
        const same = tableRows(table).find((row) => keys.every((k) => row[k] === r[k]));
        if (same) Object.assign(same, r);
        else tableRows(table).push(withDefaults(table, r));
      }
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
      const gone = tableRows(table).filter((row) => matches(row, match));
      db[table] = tableRows(table).filter((row) => !matches(row, match));
      // Som i databasen: ångras flytten försvinner belöningen.
      if (table === "transfers") db.quest_claims = db.quest_claims.filter((c) => !gone.some((t) => t.id === c.transfer_id));
      save();
    },
    /** Samma regler som funktionerna i 005_quests.sql. */
    async rpc(name, args) {
      const today = todayInSweden();
      const me = db.members[0].user_id;
      const q = db.quests.find((x) => x.id === args.p_quest && !x.archived);
      if (!q) throw new Error("Questet finns inte");
      if (q.owner_id !== me) throw new Error("Det är inte ditt quest");
      if (name === "set_quest_check") {
        if (![today, addDays(today, -1)].includes(args.p_day)) throw new Error("Du kan bara bocka i idag eller igår");
        const has = db.quest_checks.some((c) => c.quest_id === q.id && c.day === args.p_day);
        if (args.p_done && !has) db.quest_checks.push({ quest_id: q.id, day: args.p_day, created_at: new Date().toISOString() });
        if (!args.p_done) {
          if (dayLocked(q, db.quest_claims, args.p_day)) throw new Error("Dagen ingår i en belöning du redan har tagit");
          db.quest_checks = db.quest_checks.filter((c) => !(c.quest_id === q.id && c.day === args.p_day));
        }
        save();
        return null;
      }
      if (name === "claim_quest") {
        const source = db.buckets.find((b) => b.id === db.settings.quest_bucket_id && !b.archived);
        if (!source) throw new Error("Det finns ingen Quests-hink än");
        const target = db.buckets
          .filter((b) => b.kind === "personal" && b.owner_id === me && !b.archived && b.id !== source.id)
          .sort((a, b) => a.sort_order - b.sort_order)[0];
        if (!target) throw new Error("Du har ingen egen hink att ta pengarna till");
        const plan = planClaim(q, db.quest_checks, db.quest_claims, today);
        if ((computeBudget({ ...db, today }).buckets.get(source.id)?.balance ?? 0) < plan.amount) {
          throw new Error("Quests-hinken har inte tillräckligt med pengar just nu");
        }
        const transfer = withDefaults("transfers", { from_bucket: source.id, to_bucket: target.id, amount: plan.amount, note: `Quest: ${q.title}`, created_by: me });
        db.transfers.push(transfer);
        for (const r of plan.rows) {
          db.quest_claims.push(withDefaults("quest_claims", { quest_id: q.id, owner_id: me, day: today, ...r, amount: q.reward_amount, transfer_id: transfer.id }));
        }
        save();
        return { amount: plan.amount, bucket: target.name, count: plan.rows.length };
      }
      throw new Error(`Okänd funktion ${name}`);
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
