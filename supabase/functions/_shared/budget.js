// Budgetlogik som delas mellan webbappen och Supabase-funktionerna.
// Ren JavaScript utan beroenden så att den kan importeras både från
// webbläsaren (via GitHub Pages) och från Deno (edge functions).
//
// Belopp är heltal i öre. Datum är strängar på formen "YYYY-MM-DD".

/** @param {Date} d */
export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** @param {string} s */
export function parseISODate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Dagens datum i svensk tid, oavsett vilken tidszon koden körs i. */
export function todayInSweden(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(now);
}

function addDays(dateStr, days) {
  const d = parseISODate(dateStr);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/**
 * Första dagen i lönemånaden för en nominell månad. Infaller startdagen
 * på en helg flyttas den till närmaste vardag innan, som lönen.
 * @param {number} year
 * @param {number} monthIndex 0–11, får vara utanför intervallet
 * @param {number} startDay
 */
export function periodStartOf(year, monthIndex, startDay) {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const d = new Date(year, monthIndex, Math.min(startDay, lastDay));
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return toISODate(d);
}

/**
 * Lönemånaden som ett datum tillhör.
 * `key` är den nominella månaden ("2026-10" för perioden som börjar runt 25 okt).
 * @param {string} dateStr
 * @param {number} startDay
 */
export function periodFor(dateStr, startDay) {
  const d = parseISODate(dateStr);
  let y = d.getFullYear();
  let m = d.getMonth();
  // Startdagen 1 kan flyttas bakåt in i föregående månad, så kolla även nästa månad.
  if (dateStr >= periodStartOf(y, m + 1, startDay)) m += 1;
  else if (dateStr < periodStartOf(y, m, startDay)) m -= 1;
  const norm = new Date(y, m, 1);
  y = norm.getFullYear();
  m = norm.getMonth();
  const start = periodStartOf(y, m, startDay);
  const end = addDays(periodStartOf(y, m + 1, startDay), -1);
  return { key: `${y}-${String(m + 1).padStart(2, "0")}`, start, end };
}

/** Aktiva hinkar i prioritetsordning, samma som på startsidan: gemensamma först, sedan privata. */
export function priorityOrder(buckets) {
  const list = buckets.filter((b) => !b.archived).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "sv"));
  return [...list.filter((b) => b.kind !== "personal"), ...list.filter((b) => b.kind === "personal")];
}

/** Privata hinkar syns bara för sin ägare. Gemensamma hinkar och privata utan ägare syns för alla. */
export function visibleTo(bucket, userId) {
  return bucket.kind !== "personal" || !bucket.owner_id || bucket.owner_id === userId;
}

/**
 * Så många dagar före nästa lönedag pausas fördelningen. En lön som kommer
 * tidigt, t.ex. före jul, ska fylla nästa månad och inte gå till överskottet.
 */
export const HOLD_DAYS = 7;

/**
 * Fördelar Att fördela automatiskt i innevarande lönemånad.
 *
 *  1. Grundbelopp: hinkarna i prioritetsordning får det som fattas av
 *     månadsbeloppet för perioden, men saldot går aldrig över taket.
 *  2. Överskott: det som blir kvar går till hinkar med överskottsordning
 *     1, 2, 3 … upp till taket. Hinkar med samma ordning delar lika.
 *
 * En period som började före startdatumet fördelas inte; den fylldes på
 * för hand. Raderna är periodens nya totalbelopp per hink och källa, så
 * samma tillstånd ger alltid samma rader och dubbla körningar gör inget.
 * `added` är det som lades till nu, `waitUntil` när en pausad fördelning sker.
 */
export function autoAllocate(state) {
  const { settings, allocations } = state;
  const budget = computeBudget(state);
  const { start, end } = budget.period;
  const out = { rows: [], added: [], waitUntil: null };
  if (!settings.start_date || start < settings.start_date || addDays(end, 1 - HOLD_DAYS) <= state.today) {
    if (budget.attFordela > 0) out.waitUntil = addDays(end, 1);
    return out;
  }
  let left = budget.attFordela;
  if (left <= 0) return out;

  const order = priorityOrder(state.buckets);
  const added = new Map();
  const addedTo = (id) => (added.get(`${id}|base`) ?? 0) + (added.get(`${id}|overflow`) ?? 0);
  const room = (b) => (b.cap_amount == null ? Infinity : Math.max(0, b.cap_amount - budget.buckets.get(b.id).balance - addedTo(b.id)));
  const give = (b, source, amount) => {
    if (amount <= 0) return;
    const key = `${b.id}|${source}`;
    added.set(key, (added.get(key) ?? 0) + amount);
    left -= amount;
  };
  const existing = (id, source) =>
    allocations.filter((a) => a.bucket_id === id && a.period_start === start && (a.source ?? "base") === source).reduce((s, a) => s + a.amount, 0);

  for (const b of order) {
    if (left <= 0) break;
    give(b, "base", Math.min(left, room(b), b.monthly_amount - existing(b.id, "base")));
  }

  const ranks = [...new Set(order.map((b) => b.overflow_rank).filter((r) => r != null))].sort((a, b) => a - b);
  for (const rank of ranks) {
    let group = order.filter((b) => b.overflow_rank === rank);
    // Dela lika i hela kronor. Når en hink taket går resten till de andra.
    while (left > 0 && (group = group.filter((b) => room(b) > 0)).length) {
      const share = Math.floor(left / group.length / 100) * 100;
      if (!share) {
        give(group[0], "overflow", Math.min(left, room(group[0])));
        continue;
      }
      for (const b of group) give(b, "overflow", Math.min(share, room(b)));
    }
  }

  for (const [key, amount] of added) {
    const [bucket_id, source] = key.split("|");
    out.rows.push({ bucket_id, period_start: start, source, amount: existing(bucket_id, source) + amount });
    out.added.push({ bucket_id, source, amount });
  }
  return out;
}

/** Lägger in nya totalbelopp från autoAllocate i en lista med påfyllningar. */
export function mergeAllocations(allocations, rows) {
  for (const row of rows) {
    const same = allocations.find((a) => a.bucket_id === row.bucket_id && a.period_start === row.period_start && (a.source ?? "base") === row.source);
    if (same) same.amount = row.amount;
    else allocations.push({ ...row });
  }
  return allocations;
}

/** Tar bort rader från bankkonton som är avstängda. De kommer tillbaka om kontot slås på igen. */
export function activeTransactions(transactions, connections = []) {
  const off = new Set(connections.filter((c) => !c.enabled).map((c) => c.id));
  return off.size ? transactions.filter((t) => !off.has(t.connection_id)) : transactions;
}

/**
 * Räknar ut saldot i alla hinkar.
 *
 * Saldot är kumulativt sedan startdatumet: alla påfyllningar + flyttar in
 * − flyttar ut + köp och återbetalningar. Därför rullar överskott vidare
 * och överdrag dras av nästa månad utan någon särskild logik.
 *
 * Transaktionstyper:
 *  - "expense": hör till en hink (negativ = köp, positiv = återbetalning).
 *    Utan hink räknas den som osorterad.
 *  - "income": lön, överföringar till/från sparkonto m.m. Påverkar Att fördela.
 *
 * Flyttar där from_bucket eller to_bucket är null går till/från Att fördela.
 */
export function computeBudget({ settings, buckets, allocations, transfers, transactions, today }) {
  const startDay = settings.period_start_day;
  const period = periodFor(today, startDay);
  const startDate = settings.start_date;

  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const b of buckets) {
    byId.set(b.id, {
      bucket: b,
      allocated: 0,
      allocatedPeriod: 0,
      transferIn: 0,
      transferOut: 0,
      transferPeriod: 0,
      spent: 0,
      spentPeriod: 0,
      balance: 0,
      periodTotal: 0,
      ratio: 0,
    });
  }

  let attFordela = settings.start_balance || 0;
  let uncategorized = 0;
  let uncategorizedCount = 0;

  for (const a of allocations) {
    if (a.period_start > today) continue;
    attFordela -= a.amount;
    const s = byId.get(a.bucket_id);
    if (!s) continue;
    s.allocated += a.amount;
    if (a.period_start >= period.start) s.allocatedPeriod += a.amount;
  }

  for (const t of transfers) {
    const day = (t.created_at || "").slice(0, 10);
    const from = t.from_bucket ? byId.get(t.from_bucket) : null;
    const to = t.to_bucket ? byId.get(t.to_bucket) : null;
    if (t.from_bucket) {
      if (from) {
        from.transferOut += t.amount;
        if (day >= period.start) from.transferPeriod -= t.amount;
      }
    } else attFordela -= t.amount;
    if (t.to_bucket) {
      if (to) {
        to.transferIn += t.amount;
        if (day >= period.start) to.transferPeriod += t.amount;
      }
    } else attFordela += t.amount;
  }

  for (const t of transactions) {
    if (startDate && t.date < startDate) continue;
    if (t.kind === "income") {
      attFordela += t.amount;
      continue;
    }
    const s = t.bucket_id ? byId.get(t.bucket_id) : null;
    if (!s) {
      uncategorized += t.amount;
      uncategorizedCount += 1;
      continue;
    }
    s.spent += t.amount;
    if (t.date >= period.start) s.spentPeriod += t.amount;
  }

  let bucketSum = 0;
  for (const s of byId.values()) {
    s.balance = s.allocated + s.transferIn - s.transferOut + s.spent;
    // Det som fanns att använda den här perioden = saldot + det som redan gjorts av med.
    s.periodTotal = s.balance - s.spentPeriod;
    s.ratio = s.periodTotal > 0 ? Math.max(0, Math.min(1, s.balance / s.periodTotal)) : 0;
    bucketSum += s.balance;
  }

  return {
    period,
    buckets: byId,
    attFordela,
    uncategorized,
    uncategorizedCount,
    total: bucketSum + attFordela + uncategorized,
  };
}

/** Saldo för en enskild hink, används i notiser. */
export function bucketBalance(state, bucketId) {
  return computeBudget(state).buckets.get(bucketId)?.balance ?? 0;
}

/** Tolkar belopp från bank, genvägar och formulär till öre. "342,50 kr" → 34250 */
export function parseAmountToOre(input) {
  if (typeof input === "number") return Math.round(input * 100);
  let s = String(input ?? "").replace(/[^\d,.\-−]/g, "").replace("−", "-");
  if (!s || s === "-") return NaN;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const decimalSep = lastComma > lastDot ? "," : ".";
  const decimalPos = Math.max(lastComma, lastDot);
  // "1.234" eller "1,234" utan decimaler tolkas som tusental om tre siffror följer.
  if (decimalPos >= 0 && s.length - decimalPos - 1 === 3 && s.indexOf(decimalSep) === decimalPos && !s.includes(decimalSep === "," ? "." : ",")) {
    s = s.replace(/[.,]/g, "");
  } else {
    const thousands = decimalSep === "," ? /\./g : /,/g;
    s = s.replace(thousands, "").replace(decimalSep, ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** 34250 → "342,50 kr" (decimaler bara om de behövs) */
export function formatKr(ore, { sign = false, decimals = "auto" } = {}) {
  const kr = ore / 100;
  const showDecimals = decimals === "always" || (decimals === "auto" && ore % 100 !== 0);
  const s = new Intl.NumberFormat("sv-SE", {
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: showDecimals ? 2 : 0,
  }).format(Math.abs(kr));
  const prefix = ore < 0 ? "−" : sign && ore > 0 ? "+" : "";
  return `${prefix}${s} kr`;
}
