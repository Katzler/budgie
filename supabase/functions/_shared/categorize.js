// Regler för vilken hink ett köp hamnar i. Delas mellan webbappen och edge functions.

/**
 * Sant om `pattern` finns i `text` och börjar på en ordgräns.
 * Korta mönster (≤ 3 tecken, t.ex. "sl") måste även sluta på en ordgräns
 * så att "sl" inte matchar "slakteri".
 */
function containsWord(text, pattern) {
  const isLetter = (c) => !!c && /[a-z0-9åäöéü]/.test(c);
  let from = 0;
  for (;;) {
    const i = text.indexOf(pattern, from);
    if (i < 0) return false;
    const startOk = !isLetter(text[i - 1]);
    const endOk = pattern.length > 3 || !isLetter(text[i + pattern.length]);
    if (startOk && endOk) return true;
    from = i + 1;
  }
}

export function transactionText(tx) {
  return `${tx.description || ""} ${tx.counterparty || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Mest specifika (längsta) matchande regeln, eller null. */
export function matchRule(tx, rules) {
  const text = transactionText(tx);
  let best = null;
  for (const r of rules) {
    const p = (r.pattern || "").toLowerCase().trim();
    if (!p) continue;
    if (containsWord(text, p) && (!best || p.length > best.pattern.trim().length)) best = r;
  }
  return best;
}

/**
 * Bestämmer typ och hink för en ny transaktion.
 * Positiva belopp utan regel räknas som inkomst (Att fördela).
 */
export function classify(tx, rules) {
  const rule = matchRule(tx, rules);
  if (rule) {
    if (rule.kind === "income") return { kind: "income", bucket_id: null, categorized_by: "rule" };
    return { kind: "expense", bucket_id: rule.bucket_id, categorized_by: "rule" };
  }
  if (tx.amount > 0) return { kind: "income", bucket_id: null, categorized_by: "none" };
  return { kind: "expense", bucket_id: null, categorized_by: "none" };
}

/**
 * Föreslår ett regelmönster från en bankbeskrivning.
 * "K*ICA MAXI LINDHAGEN 25/10" → "ica maxi"
 */
export function suggestPattern(description) {
  const words = (description || "")
    .toLowerCase()
    .replace(/^[a-z]{1,2}\*/, "")
    .replace(/[*#/\\_]/g, " ")
    .split(/\s+/)
    .filter((w) => w && /[a-zåäö]/.test(w) && !/\d{2,}/.test(w));
  return words.slice(0, 2).join(" ");
}

/** Förslag på regler som läggs in för hinkar med de här namnen. */
export const DEFAULT_RULES = [
  { bucket: "Livsmedel", patterns: ["ica", "coop", "willys", "hemköp", "hemkop", "lidl", "city gross", "mathem", "tempo", "netto", "matsmart", "mat.se"] },
  { bucket: "Transport", patterns: ["sl", "circle k", "preem", "okq8", "st1", "ingo", "sj", "voi", "easypark", "parkster", "aimo", "vy ", "västtrafik", "skånetrafiken", "bolt", "uber"] },
  { bucket: "Räkningar", patterns: ["vattenfall", "ellevio", "eon", "e.on", "fortum", "telia", "tele2", "telenor", "comviq", "hallon", "tre ", "bahnhof", "netflix", "spotify", "hbo", "max.com", "viaplay", "disney", "folksam", "länsförsäkringar", "trygg-hansa", "if skadeförs", "csn", "hyra", "brf"] },
  { bucket: "Lyx", patterns: ["restaurang", "systembolaget", "filmstaden", "foodora", "wolt", "uber eats", "max burgers", "mcdonalds", "espresso house", "starbucks", "pressbyrån", "7-eleven", "bar", "pizzeria", "sushi"] },
  { bucket: "Skönhet", patterns: ["apotek", "kronans", "ikea", "clas ohlson", "jula", "biltema", "rusta", "normal", "åhléns", "kicks", "lyko", "granit", "byggmax", "bauhaus"] },
  { bucket: "Resa", patterns: ["sas", "norwegian", "booking.com", "airbnb", "hotels.com", "ving", "tui", "apollo", "ryanair", "flygbussarna", "arlanda express", "scandic", "strawberry"] },
  { kind: "income", patterns: ["lön", "salary", "försäkringskassan", "skatteverket"] },
];

/** Bygger regelrader för de hinkar som finns. */
export function defaultRulesFor(buckets) {
  const out = [];
  for (const group of DEFAULT_RULES) {
    if (group.kind === "income") {
      for (const p of group.patterns) out.push({ pattern: p, kind: "income", bucket_id: null });
      continue;
    }
    const bucket = buckets.find((b) => !b.archived && b.name.toLowerCase() === group.bucket.toLowerCase());
    if (!bucket) continue;
    for (const p of group.patterns) out.push({ pattern: p.trim(), kind: "expense", bucket_id: bucket.id });
  }
  return out;
}

/**
 * Hittar en väntande eller genvägsregistrerad rad som en bokförd banktransaktion
 * motsvarar: samma belopp, inom ±5 dagar, närmast i tid.
 */
export function findMatchForBooked(booked, candidates) {
  const dayMs = 86400000;
  let best = null;
  let bestDiff = Infinity;
  for (const c of candidates) {
    if (c.status !== "pending" && c.status !== "quick") continue;
    if (c.amount !== booked.amount) continue;
    const diff = Math.abs(Date.parse(c.date) - Date.parse(booked.date)) / dayMs;
    if (diff <= 5 && diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return best;
}
