// Påhittad data för demoläget, så att appen går att prova utan Supabase.
import { periodFor, periodStartOf, toISODate, todayInSweden, parseISODate } from "../supabase/functions/_shared/budget.js";
import { defaultRulesFor } from "../supabase/functions/_shared/categorize.js";

export function demoSeed() {
  const today = todayInSweden();
  const startDay = 25;
  const current = periodFor(today, startDay);
  const [cy, cm] = current.key.split("-").map(Number);
  const previousStart = periodStartOf(cy, cm - 2, startDay);
  const daysAgo = (n) => {
    const d = parseISODate(today);
    d.setDate(d.getDate() - n);
    return toISODate(d);
  };
  let n = 0;
  const id = (p) => `${p}-${++n}`;

  const members = [
    { user_id: "u-jack", name: "Jack" },
    { user_id: "u-partner", name: "Partner" },
  ];

  const bucketDefs = [
    ["Räkningar", "🧾", "spending", null, 1850000],
    ["Livsmedel", "🛒", "spending", null, 700000],
    ["Hushåll", "🧴", "spending", null, 150000],
    ["Transport", "🚇", "spending", null, 180000],
    ["Lyx", "🍷", "spending", null, 250000],
    ["Presenter", "🎁", "savings", null, 80000],
    ["Resa", "✈️", "savings", null, 300000],
    ["Oregelbundet", "🔧", "savings", null, 150000],
    ["Buffert", "🛟", "savings", null, 1000000],
    ["Jacks pengar", "🧢", "personal", "u-jack", 150000],
    ["Partners pengar", "👜", "personal", "u-partner", 150000],
  ];
  const buckets = bucketDefs.map(([name, icon, kind, owner_id, monthly_amount], i) => ({
    id: id("b"),
    name,
    icon,
    kind,
    owner_id,
    monthly_amount,
    sort_order: i,
    archived: false,
    created_at: `${previousStart}T08:00:00.000Z`,
  }));
  const B = Object.fromEntries(buckets.map((b) => [b.name, b.id]));

  const allocations = [];
  for (const start of [previousStart, current.start]) {
    for (const b of buckets) allocations.push({ id: id("a"), bucket_id: b.id, period_start: start, amount: b.monthly_amount });
  }

  const tx = (date, amount, description, bucket, extra = {}) => ({
    id: id("t"),
    external_id: null,
    date,
    amount,
    description,
    counterparty: null,
    status: "booked",
    kind: bucket === "income" ? "income" : "expense",
    bucket_id: bucket && bucket !== "income" ? B[bucket] : null,
    categorized_by: bucket ? "rule" : "none",
    note: null,
    created_at: `${date}T12:00:00.000Z`,
    ...extra,
  });

  const sinceStart = Math.max(0, Math.round((parseISODate(today) - parseISODate(current.start)) / 86400000));
  const inPeriod = (n) => daysAgo(Math.min(n, sinceStart));

  const transactions = [
    tx(previousStart, 3480000, "LÖN ARBETSGIVAREN AB", "income"),
    tx(previousStart, 3125000, "LÖN KOMMUNEN", "income"),
    tx(current.start, 3480000, "LÖN ARBETSGIVAREN AB", "income"),
    tx(current.start, 3125000, "LÖN KOMMUNEN", "income"),
    // Förra perioden
    tx(daysAgo(sinceStart + 25), -1450000, "AUTOGIRO BRF ESKILSTUNAN", "Räkningar"),
    tx(daysAgo(sinceStart + 22), -64900, "ICA MAXI LINDHAGEN", "Livsmedel"),
    tx(daysAgo(sinceStart + 18), -189000, "RESTAURANG TRANAN", "Lyx"),
    tx(daysAgo(sinceStart + 12), -52300, "WILLYS ODENPLAN", "Livsmedel"),
    tx(daysAgo(sinceStart + 6), -97000, "SL ACCESS", "Transport"),
    // Den här perioden
    tx(inPeriod(0), -1450000, "AUTOGIRO BRF ESKILSTUNAN", "Räkningar"),
    tx(inPeriod(0), -45900, "VATTENFALL AB", "Räkningar"),
    tx(inPeriod(1), -18900, "SPOTIFY", "Räkningar"),
    tx(inPeriod(1), -97000, "SL ACCESS", "Transport"),
    tx(inPeriod(2), -71245, "ICA MAXI LINDHAGEN", "Livsmedel"),
    tx(inPeriod(2), -34900, "SYSTEMBOLAGET 0123", "Lyx"),
    tx(inPeriod(1), -24900, "KRONANS APOTEK", "Hushåll"),
    tx(inPeriod(1), -38800, "WILLYS ODENPLAN", "Livsmedel"),
    tx(inPeriod(0), -12500, "ESPRESSO HOUSE", "Jacks pengar", { categorized_by: "user" }),
    tx(inPeriod(0), -42900, "LINDEX GALLERIAN", null),
    tx(inPeriod(0), -15900, "K*ADLIBRIS", null),
    tx(inPeriod(0), -27450, "COOP KONSUM", "Livsmedel", { status: "pending" }),
  ];

  const rules = defaultRulesFor(buckets).map((r) => ({ id: id("r"), ...r }));
  rules.push({ id: id("r"), pattern: "brf eskilstunan", kind: "expense", bucket_id: B["Räkningar"] });

  return {
    members,
    settings: { id: 1, period_start_day: startDay, start_date: previousStart, start_balance: 1250000 },
    buckets,
    allocations,
    transfers: [{ id: id("f"), from_bucket: B["Lyx"], to_bucket: B["Livsmedel"], amount: 50000, note: "Middagsbjudning", created_by: "u-jack", created_at: `${previousStart}T18:00:00.000Z` }],
    transactions,
    rules,
    bank_connections: [],
    quick_tokens: [],
    push_subscriptions: [],
  };
}
