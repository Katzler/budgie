// Hämtar transaktioner från banken, sorterar dem i hinkar och skickar notiser.
import { computeBudget, formatKr, parseISODate, toISODate, todayInSweden } from "./budget.js";
import { classify, findMatchForBooked } from "./categorize.js";
import { Db, check, loadState } from "./db.ts";
import { eb, pickBalance, toTransaction } from "./enablebanking.ts";
import { sendPush } from "./push.ts";

type Psu = { ip: string; userAgent: string };

const addDays = (date: string, days: number) => {
  const d = parseISODate(date);
  d.setDate(d.getDate() + days);
  return toISODate(d);
};

/** Fler nya köp än så här ger en sammanfattande notis i stället för en per köp. */
const MAX_SINGLE_NOTIFICATIONS = 5;

export async function syncAll(db: Db, { psu, reminders = false }: { psu?: Psu; reminders?: boolean } = {}) {
  const connections = check(await db.from("bank_connections").select("*").eq("enabled", true)) as any[];
  if (!connections.length) return { imported: 0, message: "Ingen bank är kopplad" };

  const settings = check(await db.from("settings").select("*").single()) as any;
  const rules = check(await db.from("rules").select("*")) as any[];
  const today = todayInSweden();
  const inserted: any[] = [];
  const errors: string[] = [];

  for (const conn of connections) {
    try {
      const firstSync = !conn.last_sync_at;
      const rows = await syncConnection(db, conn, settings, rules, today, psu);
      if (!firstSync) inserted.push(...rows);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(message);
      await db.from("bank_connections").update({ last_error: message.slice(0, 500) }).eq("id", conn.id);
    }
  }

  if (inserted.length) await notifyNew(db, inserted);
  if (reminders) await remindExpiring(db, connections, today);

  if (errors.length && !inserted.length) throw new Error(errors[0]);
  return {
    imported: inserted.length,
    message: inserted.length ? `${inserted.length} nya transaktioner` : "Inga nya transaktioner",
    errors,
  };
}

async function syncConnection(db: Db, conn: any, settings: any, rules: any[], today: string, psu?: Psu) {
  // Börja en vecka före senaste hämtningen så att sena bokföringar kommer med.
  const lastSynced = conn.last_sync_at ? addDays(conn.last_sync_at.slice(0, 10), -7) : addDays(today, -30);
  const dateFrom = settings.start_date && settings.start_date > lastSynced ? settings.start_date : lastSynced;

  const raws: any[] = [];
  let continuationKey: string | undefined;
  do {
    const q = new URLSearchParams({ date_from: dateFrom });
    if (continuationKey) q.set("continuation_key", continuationKey);
    const res = await eb(`/accounts/${conn.account_uid}/transactions?${q}`, { psu });
    raws.push(...(res.transactions ?? []));
    continuationKey = res.continuation_key ?? undefined;
  } while (continuationKey);

  const fetched = await Promise.all(raws.map((r) => toTransaction(r, conn.id)));
  const fetchedIds = new Set(fetched.map((t) => t.external_id));

  // Befintliga rader i fönstret: för dubblettkontroll och matchning kommande → bokförd.
  const existing = check(
    await db.from("transactions").select("*").gte("date", addDays(dateFrom, -10)),
  ) as any[];
  const byExternal = new Map(existing.filter((t) => t.external_id).map((t) => [t.external_id, t]));
  const consumed = new Set<string>();
  const fresh: any[] = [];

  for (const tx of fetched) {
    if (settings.start_date && tx.date < settings.start_date) continue;
    const same = byExternal.get(tx.external_id);
    if (same) {
      consumed.add(same.id);
      if (same.status !== tx.status || same.date !== tx.date || !same.raw) {
        check(await db.from("transactions").update({ status: tx.status, date: tx.date, raw: tx.raw }).eq("id", same.id));
      }
      continue;
    }
    // En bokförd rad kan motsvara en kommande från samma konto eller en från Apple Pay-genvägen.
    // En kommande rad kan bara motsvara en från genvägen.
    const candidates = existing.filter(
      (c) => !consumed.has(c.id) && (c.status === "quick" || (tx.status === "booked" && c.connection_id === conn.id)),
    );
    const match = findMatchForBooked(tx, candidates);
    if (match) {
      consumed.add(match.id);
      const patch: any = { external_id: tx.external_id, connection_id: conn.id, status: tx.status, date: tx.date, counterparty: tx.counterparty, raw: tx.raw };
      // Bankens text på en kommande rad är ofta förkortad ("TSB"); den bokförda är tydligare.
      // Handlarnamnet från genvägen behålls.
      if (match.status === "pending") {
        patch.description = tx.description;
        if (match.categorized_by === "none") Object.assign(patch, classify(tx, rules));
      }
      check(await db.from("transactions").update(patch).eq("id", match.id));
      continue;
    }
    fresh.push({ ...tx, ...classify(tx, rules) });
  }

  // Kommande dragningar som inte längre finns i banken har makulerats.
  const cancelled = existing.filter(
    (t) => t.status === "pending" && t.connection_id === conn.id && t.date >= dateFrom && !consumed.has(t.id) && !fetchedIds.has(t.external_id),
  );
  if (cancelled.length) check(await db.from("transactions").delete().in("id", cancelled.map((t) => t.id)));

  let rows: any[] = [];
  if (fresh.length) {
    rows = check(await db.from("transactions").upsert(fresh, { onConflict: "external_id", ignoreDuplicates: true }).select()) as any[];
  }

  const { balances } = await eb(`/accounts/${conn.account_uid}/balances`, { psu });
  check(
    await db
      .from("bank_connections")
      .update({ last_sync_at: new Date().toISOString(), last_error: null, last_balance: pickBalance(balances ?? []), last_balance_at: new Date().toISOString() })
      .eq("id", conn.id),
  );
  return rows;
}

async function notifyNew(db: Db, rows: any[]) {
  const state = await loadState(db);
  const budget = computeBudget(state);
  const kr = (ore: number) => formatKr(ore, { decimals: "never" });

  if (rows.length > MAX_SINGLE_NOTIFICATIONS) {
    const unsorted = rows.filter((t) => t.kind === "expense" && !t.bucket_id).length;
    await sendPush(db, {
      title: `${rows.length} nya transaktioner`,
      body: unsorted ? `${unsorted} behöver sorteras` : "Allt sorterat automatiskt",
      url: unsorted ? "./#/sortera" : "./",
      tag: "budgie-summary",
    });
    return;
  }

  for (const t of rows) {
    const amount = formatKr(t.amount, { sign: true });
    if (t.kind === "income") {
      await sendPush(db, { title: `${t.description} ${amount}`, body: `💰 Att fördela: ${kr(budget.attFordela)}`, url: `./#/tx/${t.id}`, tag: t.id });
      continue;
    }
    const bucket = state.buckets.find((b: any) => b.id === t.bucket_id);
    const body = bucket
      ? `${bucket.icon} ${bucket.name}: ${kr(budget.buckets.get(bucket.id)?.balance ?? 0)} kvar`
      : "📥 Osorterat – tryck för att välja hink";
    await sendPush(db, { title: `${t.description} ${amount}`, body, url: `./#/tx/${t.id}`, tag: t.id });
  }
}

async function remindExpiring(db: Db, connections: any[], today: string) {
  for (const c of connections) {
    if (!c.valid_until || c.reminded_at === today) continue;
    const days = Math.ceil((Date.parse(c.valid_until) - Date.now()) / 86400000);
    if (days > 7) continue;
    await sendPush(db, {
      title: "Förnya bankkopplingen",
      body: days > 0 ? `Medgivandet till Swedbank går ut om ${days} ${days === 1 ? "dag" : "dagar"}. Förnya med BankID.` : "Medgivandet har gått ut. Koppla Swedbank igen med BankID.",
      url: "./#/installningar/bank",
      tag: "budgie-consent",
    });
    await db.from("bank_connections").update({ reminded_at: today }).eq("id", c.id);
  }
}
