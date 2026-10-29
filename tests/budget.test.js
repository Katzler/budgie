import {
  periodFor,
  periodStartOf,
  autoAllocate,
  mergeAllocations,
  computeBudget,
  activeTransactions,
  parseAmountToOre,
  formatKr,
} from "../supabase/functions/_shared/budget.js";
import { classify, matchRule, suggestPattern, findMatchForBooked, defaultRulesFor } from "../supabase/functions/_shared/categorize.js";

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const eq = (actual, expected, msg = "") => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg} väntade ${e}, fick ${a}`);
};

// --- Lönemånad ---------------------------------------------------------

test("den 25:e på en vardag är periodstart", () => {
  eq(periodStartOf(2026, 8, 25), "2026-09-25"); // fredag
});

test("den 25:e på en lördag flyttas till fredag", () => {
  eq(periodStartOf(2026, 9, 25), "2026-10-23"); // 25 okt 2026 är söndag → fre 23
  eq(periodStartOf(2026, 6, 25), "2026-07-24"); // 25 jul 2026 är lördag → fre 24
});

test("datum före periodstart hör till föregående period", () => {
  eq(periodFor("2026-10-22", 25), { key: "2026-09", start: "2026-09-25", end: "2026-10-22" });
  eq(periodFor("2026-10-23", 25), { key: "2026-10", start: "2026-10-23", end: "2026-11-24" });
});

test("perioden över årsskiftet", () => {
  eq(periodFor("2027-01-10", 25), { key: "2026-12", start: "2026-12-25", end: "2027-01-24" });
});

test("startdag 1 som hamnar på helg flyttas in i föregående månad", () => {
  // 1 nov 2026 är söndag → perioden börjar fre 30 okt
  eq(periodFor("2026-10-30", 1).key, "2026-11");
  eq(periodFor("2026-10-29", 1).key, "2026-10");
});

// --- Automatisk fördelning ----------------------------------------------

/** Lönemånaden 25 nov–24 dec 2026, startsaldo 0 och en lön som kommer in. */
function allocState({ buckets, income = 0, allocations = [], transactions = [], today = "2026-11-25", start_date = "2026-10-27" }) {
  return {
    settings: { start_date, start_balance: 0, period_start_day: 25 },
    buckets: buckets.map((b, i) => ({ kind: "spending", monthly_amount: 0, cap_amount: null, overflow_rank: null, sort_order: i, name: b.id, ...b })),
    allocations,
    transfers: [],
    transactions: income ? [{ date: "2026-11-25", amount: income, kind: "income" }, ...transactions] : transactions,
    today,
  };
}
const added = (r) => Object.fromEntries(r.added.map((a) => [`${a.bucket_id}|${a.source}`, a.amount]));

test("lönen fyller månadsbeloppen i ordning", () => {
  const r = autoAllocate(allocState({ income: 1000000, buckets: [{ id: "mat", monthly_amount: 700000 }, { id: "lyx", monthly_amount: 500000 }] }));
  eq(added(r), { "mat|base": 700000, "lyx|base": 300000 });
  eq(r.rows, [
    { bucket_id: "mat", period_start: "2026-11-25", source: "base", amount: 700000 },
    { bucket_id: "lyx", period_start: "2026-11-25", source: "base", amount: 300000 },
  ]);
});

test("privata hinkar fylls efter de gemensamma", () => {
  const r = autoAllocate(
    allocState({ income: 500000, buckets: [{ id: "egna", kind: "personal", monthly_amount: 500000 }, { id: "mat", monthly_amount: 400000 }] }),
  );
  eq(added(r), { "mat|base": 400000, "egna|base": 100000 });
});

test("taket stoppar påfyllningen och resten blir överskott", () => {
  const s = allocState({
    income: 1600000,
    buckets: [{ id: "mat", monthly_amount: 700000, cap_amount: 1000000 }, { id: "buffert", kind: "savings", cap_amount: 10000000, overflow_rank: 1 }],
    // 6 000 kr kvar i Livsmedel sedan förra månaden
    allocations: [{ bucket_id: "mat", period_start: "2026-10-23", source: "base", amount: 600000 }],
    start_date: "2026-10-01",
  });
  eq(added(autoAllocate(s)), { "mat|base": 400000, "buffert|overflow": 600000 });
});

test("överskottet fyller ordning 1 till taket, sedan delar ordning 2 lika", () => {
  const r = autoAllocate(
    allocState({
      income: 1000000,
      buckets: [
        { id: "buffert", kind: "savings", cap_amount: 400000, overflow_rank: 1 },
        { id: "resa", kind: "savings", cap_amount: 100000, overflow_rank: 2 },
        { id: "jack", kind: "personal", overflow_rank: 2 },
        { id: "julia", kind: "personal", overflow_rank: 2 },
      ],
    }),
  );
  // 6 000 kvar efter bufferten: 2 000 var, men Resa når taket vid 1 000 och resten delas av de andra.
  eq(added(r), { "buffert|overflow": 400000, "resa|overflow": 100000, "jack|overflow": 250000, "julia|overflow": 250000 });
});

test("lika delning i hela kronor, öresresten till den första", () => {
  const r = autoAllocate(allocState({ income: 100050, buckets: [{ id: "a", overflow_rank: 1 }, { id: "b", overflow_rank: 1 }, { id: "c", overflow_rank: 1 }] }));
  eq(added(r), { "a|overflow": 33450, "b|overflow": 33300, "c|overflow": 33300 });
});

test("andra lönen samma månad fyller bara det som fattas", () => {
  const s = allocState({
    income: 1600000,
    buckets: [{ id: "mat", monthly_amount: 700000 }, { id: "lyx", monthly_amount: 500000 }, { id: "buffert", overflow_rank: 1 }],
    allocations: [
      { bucket_id: "mat", period_start: "2026-11-25", source: "base", amount: 700000 },
      { bucket_id: "lyx", period_start: "2026-11-25", source: "base", amount: 100000 },
    ],
    today: "2026-12-01",
  });
  const r = autoAllocate(s);
  eq(added(r), { "lyx|base": 400000, "buffert|overflow": 400000 });
  eq(r.rows.find((x) => x.bucket_id === "lyx").amount, 500000, "nytt totalbelopp");
});

test("samma tillstånd fördelas bara en gång", () => {
  const s = allocState({ income: 1000000, buckets: [{ id: "mat", monthly_amount: 700000 }, { id: "buffert", overflow_rank: 1 }] });
  mergeAllocations(s.allocations, autoAllocate(s).rows);
  eq(computeBudget(s).attFordela, 0);
  eq(autoAllocate(s).rows, []);
});

test("perioden före startdatumet fördelas inte", () => {
  const s = allocState({ buckets: [{ id: "mat", monthly_amount: 700000 }], today: "2026-11-14", start_date: "2026-10-27" });
  s.transactions = [{ date: "2026-11-14", amount: 3000000, kind: "income" }];
  const r = autoAllocate(s);
  eq(r.rows, []);
  eq(r.waitUntil, "2026-11-25");
});

test("lön som kommer sista veckan väntar till nästa lönemånad", () => {
  // Lönen före jul kommer den 23 december, perioden slutar den 24.
  const s = allocState({ buckets: [{ id: "buffert", overflow_rank: 1 }], today: "2026-12-23" });
  s.transactions = [{ date: "2026-12-23", amount: 6000000, kind: "income" }];
  const r = autoAllocate(s);
  eq(r.rows, []);
  eq(r.waitUntil, "2026-12-25");
  eq(autoAllocate({ ...s, today: "2026-12-25" }).added.length, 1);
});

test("inget fördelas när Att fördela är tomt eller negativt", () => {
  const s = allocState({ buckets: [{ id: "mat", monthly_amount: 700000 }] });
  s.transactions = [{ date: "2026-11-26", amount: -50000, kind: "income" }];
  eq(autoAllocate(s).rows, []);
});

// --- Saldon -----------------------------------------------------------

function state(overrides = {}) {
  return {
    settings: { start_date: "2026-10-01", start_balance: 2000000, period_start_day: 25 },
    buckets: [
      { id: "mat", name: "Livsmedel" },
      { id: "lyx", name: "Lyx" },
    ],
    allocations: [],
    transfers: [],
    transactions: [],
    today: "2026-11-30",
    ...overrides,
  };
}

test("överskott rullar över till nästa månad", () => {
  const s = state({
    allocations: [
      { bucket_id: "mat", period_start: "2026-10-23", amount: 500000 },
      { bucket_id: "mat", period_start: "2026-11-25", amount: 500000 },
    ],
    transactions: [{ date: "2026-11-01", amount: -400000, kind: "expense", bucket_id: "mat" }],
  });
  const b = computeBudget(s).buckets.get("mat");
  eq(b.balance, 600000, "saldo");
  eq(b.spentPeriod, 0, "spenderat denna period");
  eq(b.ratio, 1, "stapel");
});

test("överdrag dras av nästa månad", () => {
  const s = state({
    allocations: [
      { bucket_id: "lyx", period_start: "2026-10-23", amount: 100000 },
      { bucket_id: "lyx", period_start: "2026-11-25", amount: 100000 },
    ],
    transactions: [
      { date: "2026-11-10", amount: -130000, kind: "expense", bucket_id: "lyx" },
      { date: "2026-11-26", amount: -20000, kind: "expense", bucket_id: "lyx" },
    ],
  });
  const b = computeBudget(s).buckets.get("lyx");
  eq(b.balance, 50000, "saldo");
  eq(b.spentPeriod, -20000);
  eq(b.periodTotal, 70000, "tillgängligt i perioden = 1000 − 300 i överdrag");
});

test("återbetalning ökar hinkens saldo", () => {
  const s = state({
    allocations: [{ bucket_id: "mat", period_start: "2026-11-25", amount: 100000 }],
    transactions: [
      { date: "2026-11-26", amount: -50000, kind: "expense", bucket_id: "mat" },
      { date: "2026-11-27", amount: 5000, kind: "expense", bucket_id: "mat" },
    ],
  });
  eq(computeBudget(s).buckets.get("mat").balance, 55000);
});

test("flytt mellan hinkar och från Att fördela", () => {
  const s = state({
    allocations: [{ bucket_id: "lyx", period_start: "2026-11-25", amount: 100000 }],
    transfers: [
      { from_bucket: "lyx", to_bucket: "mat", amount: 30000, created_at: "2026-11-26T10:00:00Z" },
      { from_bucket: null, to_bucket: "mat", amount: 10000, created_at: "2026-11-26T10:00:00Z" },
    ],
  });
  const r = computeBudget(s);
  eq(r.buckets.get("lyx").balance, 70000);
  eq(r.buckets.get("mat").balance, 40000);
  eq(r.attFordela, 2000000 - 100000 - 10000);
});

test("Att fördela: startsaldo + inkomster − påfyllningar", () => {
  const s = state({
    allocations: [
      { bucket_id: "mat", period_start: "2026-11-25", amount: 600000 },
      { bucket_id: "mat", period_start: "2026-12-25", amount: 600000 }, // framtida räknas inte
    ],
    transactions: [{ date: "2026-11-25", amount: 3500000, kind: "income", bucket_id: null }],
  });
  eq(computeBudget(s).attFordela, 2000000 + 3500000 - 600000);
});

test("kontrollsumman blir startsaldo + alla transaktioner", () => {
  const txs = [
    { date: "2026-11-25", amount: 3500000, kind: "income" },
    { date: "2026-11-26", amount: -45000, kind: "expense", bucket_id: "mat" },
    { date: "2026-11-27", amount: -12000, kind: "expense", bucket_id: null },
    { date: "2026-11-28", amount: -500000, kind: "income" }, // överföring till sparkonto
    { date: "2026-09-01", amount: -99999, kind: "expense", bucket_id: "mat" }, // före start, räknas inte
  ];
  const s = state({
    allocations: [{ bucket_id: "mat", period_start: "2026-11-25", amount: 600000 }],
    transfers: [{ from_bucket: "mat", to_bucket: "lyx", amount: 1000, created_at: "2026-11-26" }],
    transactions: txs,
  });
  const r = computeBudget(s);
  eq(r.total, 2000000 + 3500000 - 45000 - 12000 - 500000);
  eq(r.uncategorized, -12000);
  eq(r.uncategorizedCount, 1);
});

// --- Belopp ------------------------------------------------------------

test("belopp tolkas till öre", () => {
  eq(parseAmountToOre("342,50 kr"), 34250);
  eq(parseAmountToOre("SEK 1,234.50"), 123450);
  eq(parseAmountToOre("1 234,50 kr"), 123450);
  eq(parseAmountToOre("12.5"), 1250);
  eq(parseAmountToOre("-99"), -9900);
  eq(parseAmountToOre(42), 4200);
  eq(Number.isNaN(parseAmountToOre("abc")), true);
});

test("belopp formateras på svenska", () => {
  eq(formatKr(215800).replace(/\s/g, " "), "2 158 kr");
  eq(formatKr(-34250).replace(/\s/g, " "), "−342,50 kr");
});

// --- Regler -------------------------------------------------------------

const rules = [
  { pattern: "ica", kind: "expense", bucket_id: "mat" },
  { pattern: "ica maxi", kind: "expense", bucket_id: "maxi" },
  { pattern: "sl", kind: "expense", bucket_id: "transport" },
  { pattern: "lön", kind: "income", bucket_id: null },
];

test("längsta matchande regeln vinner", () => {
  eq(matchRule({ description: "ICA MAXI LINDHAGEN" }, rules).bucket_id, "maxi");
  eq(matchRule({ description: "ICA NARA" }, rules).bucket_id, "mat");
});

test("korta mönster kräver helt ord", () => {
  eq(matchRule({ description: "SL ACCESS" }, rules)?.bucket_id, "transport");
  eq(matchRule({ description: "SLAKTERIET" }, rules), null);
  eq(matchRule({ description: "MUSICA" }, rules), null);
});

test("klassificering av inkomst och okänt", () => {
  eq(classify({ description: "LÖN OKT", amount: 3000000 }, rules), { kind: "income", bucket_id: null, categorized_by: "rule" });
  eq(classify({ description: "SWISH FRÅN ANNA", amount: 20000 }, rules).kind, "income");
  eq(classify({ description: "OKÄND BUTIK", amount: -1000 }, rules), { kind: "expense", bucket_id: null, categorized_by: "none" });
});

test("mönsterförslag från bankbeskrivning", () => {
  eq(suggestPattern("K*ICA MAXI LINDHAGEN 25/10"), "ica maxi");
  eq(suggestPattern("SYSTEMBOLAGET 0123"), "systembolaget");
});

test("standardregler skapas för hinkar som finns", () => {
  const r = defaultRulesFor([{ id: "m", name: "Livsmedel" }]);
  eq(r.some((x) => x.pattern === "willys" && x.bucket_id === "m"), true);
  eq(r.some((x) => x.pattern === "lön" && x.kind === "income"), true);
  eq(r.some((x) => x.pattern === "systembolaget"), false);
});

test("bokförd transaktion matchas mot reserverad", () => {
  const cands = [
    { id: "a", status: "pending", amount: -34250, date: "2026-11-01" },
    { id: "b", status: "pending", amount: -34250, date: "2026-11-03" },
    { id: "c", status: "booked", amount: -34250, date: "2026-11-03" },
    { id: "d", status: "quick", amount: -999, date: "2026-11-03" },
  ];
  eq(findMatchForBooked({ amount: -34250, date: "2026-11-04" }, cands).id, "b");
  eq(findMatchForBooked({ amount: -999, date: "2026-11-09" }, cands)?.id, undefined);
  eq(findMatchForBooked({ amount: -999, date: "2026-11-08" }, cands).id, "d");
});

test("rader från avstängda bankkonton räknas inte", () => {
  const conns = [
    { id: "på", enabled: true },
    { id: "av", enabled: false },
  ];
  const txs = [
    { id: "a", connection_id: "på" },
    { id: "b", connection_id: "av" },
    { id: "c", connection_id: null },
  ];
  eq(activeTransactions(txs, conns).map((t) => t.id).join(","), "a,c");
  eq(activeTransactions(txs, []).length, 3);
});
