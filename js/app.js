import { config } from "./config.js";
import { createStore } from "./store.js";
import {
  computeBudget,
  missingAllocations,
  todayInSweden,
  formatKr,
  parseAmountToOre,
  periodFor,
  parseISODate,
} from "../supabase/functions/_shared/budget.js";
import { classify, matchRule, suggestPattern, defaultRulesFor } from "../supabase/functions/_shared/categorize.js";

const app = document.getElementById("app");
const S = { store: null, session: null, db: null, me: null, budget: null, handlers: {} };

// --- Hjälpfunktioner ----------------------------------------------------------

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const kr = (ore, opts) => esc(formatKr(ore, opts));
/** Hela kronor, för saldon och summor. */
const krR = (ore, opts) => kr(ore, { decimals: "never", ...opts });
const today = () => todayInSweden();
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  const name = capitalize(new Date(y, m - 1, 1).toLocaleDateString("sv-SE", { month: "long" }));
  return y === new Date().getFullYear() ? name : `${name} ${y}`;
}
const shortDate = (iso) => parseISODate(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }).replace(".", "");
function relDate(iso) {
  const diff = Math.round((parseISODate(today()) - parseISODate(iso)) / 86400000);
  if (diff === 0) return "Idag";
  if (diff === 1) return "Igår";
  return shortDate(iso);
}
function timeAgo(ts) {
  if (!ts) return "aldrig";
  const min = Math.round((Date.now() - Date.parse(ts)) / 60000);
  if (min < 1) return "nyss";
  if (min < 60) return `för ${min} min sedan`;
  if (min < 24 * 60) return `för ${Math.round(min / 60)} h sedan`;
  return new Date(ts).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
const daysBetween = (a, b) => Math.round((parseISODate(b) - parseISODate(a)) / 86400000);
const query = () => new URLSearchParams(location.hash.split("?")[1] || "");

function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, type === "error" ? 6000 : 3000);
}

async function run(fn) {
  try {
    document.body.classList.add("busy");
    await fn();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), "error");
  } finally {
    document.body.classList.remove("busy");
  }
}

const activeBuckets = () =>
  S.db.buckets.filter((b) => !b.archived).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "sv"));
const bucketById = (id) => S.db.buckets.find((b) => b.id === id);
const memberName = (id) => S.db.members.find((m) => m.user_id === id)?.name ?? "";
const inBudget = (t) => !S.db.settings.start_date || t.date >= S.db.settings.start_date;

// --- Data ---------------------------------------------------------------------

async function reload() {
  S.db = await S.store.loadAll();
  S.db.transactions.sort((a, b) => b.date.localeCompare(a.date) || (b.created_at || "").localeCompare(a.created_at || ""));
  S.me = S.db.members.find((m) => m.user_id === S.session.user.id) ?? null;
  if (!S.me) return;
  const missing = missingAllocations({ ...S.db, today: today() });
  if (missing.length) {
    await S.store.insertIgnoreDuplicates("allocations", missing, "bucket_id,period_start");
    S.db.allocations.push(...missing);
  }
  S.budget = computeBudget({ ...S.db, today: today() });
}

async function refresh() {
  await reload();
  render();
}

/** Laddar om datan och visar sedan vyn, så att den aldrig visar gammal data. */
async function reloadAndGo(hash) {
  await reload();
  if (location.hash === hash) render();
  else location.hash = hash;
}

/** Sparar en regel och sorterar andra osorterade köp som matchar den. */
async function saveRuleAndApply({ pattern, kind, bucket_id }, exceptId) {
  pattern = pattern.trim().toLowerCase();
  if (!pattern) return 0;
  if (!S.db.rules.some((r) => r.pattern === pattern)) {
    await S.store.insert("rules", [{ pattern, kind, bucket_id }]);
  }
  const rule = [{ pattern, kind, bucket_id }];
  const ids = S.db.transactions
    .filter((t) => t.id !== exceptId && t.kind === "expense" && !t.bucket_id && inBudget(t) && matchRule(t, rule))
    .map((t) => t.id);
  await S.store.updateMany("transactions", ids, { kind, bucket_id, categorized_by: "rule" });
  return ids.length;
}

async function syncBank({ silent = false } = {}) {
  const result = await S.store.api("sync");
  if (!silent) toast(result?.message || `${result?.imported ?? 0} nya transaktioner`);
  await refresh();
}

// --- Layout -------------------------------------------------------------------

const icons = {
  home: '<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  inbox: '<path d="M4 4h16v10h-5l-1.5 2h-3L9 14H4z"/><path d="M4 14v6h16v-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;

function page({ title, back, action = "", body, tabs = true }) {
  const hash = location.hash.split("?")[0] || "#/";
  const tab = (href, name, label, badge = 0) => {
    const active = href === "#/" ? hash === "#/" || hash === "" : hash.startsWith(href);
    return `<a href="${href}" class="tab${active ? " active" : ""}" aria-label="${label}">${icon(name)}<span>${label}</span>${badge ? `<b class="badge">${badge}</b>` : ""}</a>`;
  };
  const count = S.budget?.uncategorizedCount ?? 0;
  app.innerHTML = `
    ${S.store.demo ? '<div class="demo-banner">Demoläge – påhittad data. <a href="#/installningar">Mer info</a></div>' : ""}
    <header class="topbar">
      ${back ? `<a class="icon-btn" href="${back}" aria-label="Tillbaka">${icon("back")}</a>` : '<span class="icon-btn-placeholder"></span>'}
      <h1>${title}</h1>
      ${action || '<span class="icon-btn-placeholder"></span>'}
    </header>
    <main>${body}</main>
    ${
      tabs
        ? `<nav class="tabbar">
        ${tab("#/", "home", "Hem")}
        ${tab("#/sortera", "inbox", "Sortera", count)}
        ${tab("#/ny", "plus", "Nytt köp")}
        ${tab("#/flytta", "swap", "Flytta")}
        ${tab("#/installningar", "gear", "Inställningar")}
      </nav>`
        : ""
    }`;
  window.scrollTo(0, 0);
}

function bucketChips(selectedId, { includeIncome = true, selectedIncome = false } = {}) {
  return `<div class="chips">
    ${activeBuckets()
      .map((b) => `<button type="button" class="chip${b.id === selectedId ? " selected" : ""}" data-act="pick" data-bucket="${b.id}">${esc(b.icon)} ${esc(b.name)}</button>`)
      .join("")}
    ${includeIncome ? `<button type="button" class="chip income${selectedIncome ? " selected" : ""}" data-act="pick" data-bucket="income">💰 Inkomst / Att fördela</button>` : ""}
  </div>`;
}

function txRow(t, { showBucket = true } = {}) {
  const b = t.bucket_id ? bucketById(t.bucket_id) : null;
  const where = t.kind === "income" ? "Att fördela" : b ? `${b.icon} ${b.name}` : '<span class="warn">Osorterad</span>';
  const badge =
    t.status === "pending" ? '<span class="pill">Reserverad</span>' : t.status === "quick" ? '<span class="pill">Apple Pay</span>' : t.status === "manual" ? '<span class="pill">Manuell</span>' : "";
  return `<a class="row tx" href="#/tx/${t.id}">
    <div class="row-main">
      <div class="row-title">${esc(t.description)}</div>
      <div class="row-sub">${relDate(t.date)}${showBucket ? ` · ${t.kind === "income" || b ? esc(where) : where}` : ""} ${badge}</div>
    </div>
    <div class="row-amount ${t.amount > 0 ? "pos" : ""}">${kr(t.amount, { sign: true })}</div>
  </a>`;
}

function bucketOptions(selected, { includeAttFordela = false, includeIncome = false, includeNone = false } = {}) {
  const B = S.budget.buckets;
  return [
    includeNone ? `<option value="">Välj automatiskt</option>` : "",
    includeAttFordela ? `<option value="" ${selected === "" ? "selected" : ""}>💰 Att fördela (${krR(S.budget.attFordela)})</option>` : "",
    includeIncome ? `<option value="income" ${selected === "income" ? "selected" : ""}>💰 Inkomst / Att fördela</option>` : "",
    ...activeBuckets().map(
      (b) => `<option value="${b.id}" ${selected === b.id ? "selected" : ""}>${esc(b.icon)} ${esc(b.name)} (${krR(B.get(b.id)?.balance ?? 0)})</option>`,
    ),
  ].join("");
}

// --- Vyer ---------------------------------------------------------------------

function viewLogin() {
  app.innerHTML = `
    <div class="login">
      <div class="logo">🪣</div>
      <h1>Budgie</h1>
      <p class="muted">Er gemensamma hinkbudget</p>
      <form data-submit="login" class="card form">
        <label>E-post<input name="email" type="email" autocomplete="username" required></label>
        <label>Lösenord<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary" type="submit">Logga in</button>
      </form>
    </div>`;
  S.handlers = {
    login: (f) =>
      run(async () => {
        await S.store.signIn(f.get("email"), f.get("password"));
        S.session = await S.store.session();
        await start();
      }),
  };
}

function viewNotMember() {
  page({
    title: "Budgie",
    tabs: false,
    body: `<div class="card">
      <p>Du är inloggad som <b>${esc(S.session.user.email)}</b>, men kontot är inte kopplat till hushållet än.</p>
      <p class="muted">Lägg till kontot i tabellen <code>members</code> i Supabase (se README).</p>
      <button class="btn" data-act="logout">Logga ut</button>
    </div>`,
  });
  S.handlers = { logout: () => run(async () => (await S.store.signOut(), location.reload())) };
}

function viewHome() {
  const B = S.budget;
  const p = B.period;
  const daysLeft = daysBetween(today(), p.end) + 1;
  const group = (title, list) =>
    list.length
      ? `<h2 class="section">${title}</h2><div class="card list">${list.map(bucketRow).join("")}</div>`
      : "";
  const buckets = activeBuckets();
  const conns = S.db.bank_connections.filter((c) => c.enabled);
  const lastSync = conns.map((c) => c.last_sync_at).filter(Boolean).sort().pop();
  const bankBalance = conns.length && conns.every((c) => c.last_balance != null) ? conns.reduce((s, c) => s + c.last_balance, 0) : null;
  const diff = bankBalance == null ? null : B.total - bankBalance;

  page({
    title: `${monthLabel(p.key)}`,
    action: conns.length ? `<button class="icon-btn" data-act="sync" aria-label="Hämta från banken">${icon("refresh")}</button>` : "",
    body: `
      <p class="period muted">${shortDate(p.start)} – ${shortDate(p.end)} · ${daysLeft} ${daysLeft === 1 ? "dag" : "dagar"} kvar</p>
      ${
        B.attFordela !== 0
          ? `<a class="card att-fordela ${B.attFordela < 0 ? "neg" : ""}" href="#/flytta?from=">
              <div><div class="label">Att fördela</div>
              <div class="muted small">${B.attFordela < 0 ? "Ni har fördelat mer än ni har" : "Pengar som inte ligger i någon hink"}</div></div>
              <div class="big">${krR(B.attFordela)}</div>
            </a>`
          : ""
      }
      ${B.uncategorizedCount ? `<a class="card notice" href="#/sortera">📥 ${B.uncategorizedCount} köp att sortera (${krR(B.uncategorized)}) →</a>` : ""}
      ${group("Gemensamma", buckets.filter((b) => b.kind !== "personal"))}
      ${group("Privata", buckets.filter((b) => b.kind === "personal"))}
      <p class="footer-note muted small">
        ${
          diff == null
            ? `Totalt i budgeten: ${krR(B.total)}`
            : diff === 0
              ? `✓ Stämmer med banken (${krR(bankBalance)})`
              : `⚠️ Budgeten (${kr(B.total)}) skiljer ${kr(Math.abs(diff))} mot banken (${kr(bankBalance)})`
        }
        ${conns.length ? `<br>Hämtat från banken ${timeAgo(lastSync)}` : ""}
      </p>`,
  });
  S.handlers = { sync: () => run(() => syncBank()) };
}

function bucketRow(b) {
  const s = S.budget.buckets.get(b.id);
  const spent = -s.spentPeriod;
  const sub =
    s.balance < 0
      ? `Över med ${krR(-s.balance)}`
      : b.kind === "savings"
        ? `Sparhink · +${krR(b.monthly_amount)}/mån`
        : `${krR(Math.max(0, spent))} av ${krR(s.periodTotal)} använt`;
  const owner = b.kind === "personal" && b.owner_id ? ` <span class="muted small">${esc(memberName(b.owner_id))}</span>` : "";
  const level = s.balance < 0 ? "neg" : s.ratio < 0.2 && b.kind !== "savings" ? "low" : "";
  return `<a class="row bucket ${level}" href="#/hink/${b.id}">
    <div class="bucket-icon">${esc(b.icon)}</div>
    <div class="row-main">
      <div class="row-title">${esc(b.name)}${owner}</div>
      <div class="row-sub">${sub}</div>
      <div class="bar"><span style="width:${Math.round((b.kind === "savings" && s.balance > 0 ? 1 : s.ratio) * 100)}%"></span></div>
    </div>
    <div class="row-amount big">${krR(s.balance)}</div>
  </a>`;
}

function viewSort() {
  const list = S.db.transactions.filter((t) => t.kind === "expense" && !t.bucket_id && inBudget(t));
  let remember = true;
  try {
    remember = localStorage.getItem("budgie-remember") !== "0";
  } catch {}
  page({
    title: "Sortera",
    body: list.length
      ? `<label class="toggle card"><input type="checkbox" id="remember" ${remember ? "checked" : ""}> Kom ihåg butiken till nästa gång</label>
         ${list
           .map(
             (t) => `<div class="card sort-item" data-tx="${t.id}">
               <div class="sort-head"><div><div class="row-title">${esc(t.description)}</div><div class="row-sub">${relDate(t.date)}${t.status === "pending" ? " · Reserverad" : ""}</div></div>
               <div class="row-amount">${kr(t.amount, { sign: true })}</div></div>
               ${bucketChips(null)}
             </div>`,
           )
           .join("")}`
      : `<div class="empty">🎉<p>Allt är sorterat!</p></div>`,
  });
  S.handlers = {
    pick: (el) =>
      run(async () => {
        const item = el.closest("[data-tx]");
        const t = S.db.transactions.find((x) => x.id === item.dataset.tx);
        const income = el.dataset.bucket === "income";
        const patch = { kind: income ? "income" : "expense", bucket_id: income ? null : el.dataset.bucket, categorized_by: "user" };
        const rememberOn = document.getElementById("remember").checked;
        try {
          localStorage.setItem("budgie-remember", rememberOn ? "1" : "0");
        } catch {}
        await S.store.update("transactions", { id: t.id }, patch);
        let extra = 0;
        const pattern = suggestPattern(t.description);
        if (rememberOn && pattern) extra = await saveRuleAndApply({ pattern, ...patch }, t.id);
        const name = income ? "Att fördela" : bucketById(patch.bucket_id).name;
        toast(`${name}${rememberOn && pattern ? ` · kommer ihåg "${pattern}"` : ""}${extra ? ` (+${extra} till)` : ""}`);
        await refresh();
      }),
  };
}

function viewBucket(id) {
  const b = bucketById(id);
  if (!b) return viewHome();
  const s = S.budget.buckets.get(id);
  const sd = S.db.settings.period_start_day;
  const txs = S.db.transactions.filter((t) => t.bucket_id === id && t.kind === "expense" && inBudget(t));
  const byPeriod = new Map();
  for (const t of txs) {
    const key = periodFor(t.date, sd).key;
    if (!byPeriod.has(key)) byPeriod.set(key, []);
    byPeriod.get(key).push(t);
  }
  const transfers = S.db.transfers
    .filter((t) => (t.from_bucket === id || t.to_bucket === id) && t.created_at.slice(0, 10) >= S.budget.period.start)
    .map((t) => {
      const out = t.from_bucket === id;
      const other = out ? t.to_bucket : t.from_bucket;
      const otherName = other ? bucketById(other)?.name : "Att fördela";
      return `<div class="row"><div class="row-main"><div class="row-title">${out ? "Till" : "Från"} ${esc(otherName)}</div>
        <div class="row-sub">${relDate(t.created_at.slice(0, 10))}${t.created_by ? ` · ${esc(memberName(t.created_by))}` : ""}${t.note ? ` · ${esc(t.note)}` : ""}</div></div>
        <div class="row-amount ${out ? "" : "pos"}">${kr(out ? -t.amount : t.amount, { sign: true })}</div></div>`;
    });

  page({
    title: `${esc(b.icon)} ${esc(b.name)}`,
    back: "#/",
    body: `
      <div class="card hero ${s.balance < 0 ? "neg" : ""}">
        <div class="label">Kvar</div>
        <div class="huge">${krR(s.balance)}</div>
        <div class="stats">
          <div><span>Påfyllt</span>${krR(s.allocatedPeriod)}</div>
          <div><span>Flyttat</span>${krR(s.transferPeriod, { sign: true })}</div>
          <div><span>Använt</span>${krR(-s.spentPeriod)}</div>
        </div>
      </div>
      <div class="btn-row">
        <a class="btn" href="#/flytta?from=${id}">Flytta härifrån</a>
        <a class="btn" href="#/flytta?to=${id}">Fyll på</a>
        <a class="btn" href="#/installningar/hink/${id}">Ändra</a>
      </div>
      ${transfers.length ? `<h2 class="section">Flyttar den här månaden</h2><div class="card list">${transfers.join("")}</div>` : ""}
      ${
        byPeriod.size
          ? [...byPeriod.entries()]
              .slice(0, 6)
              .map(([key, list]) => {
                const sum = list.reduce((a, t) => a + t.amount, 0);
                return `<h2 class="section">${monthLabel(key)} <span class="muted">${kr(sum)}</span></h2><div class="card list">${list.map((t) => txRow(t, { showBucket: false })).join("")}</div>`;
              })
              .join("")
          : `<div class="empty"><p>Inga köp i den här hinken än.</p></div>`
      }`,
  });
  S.handlers = {};
}

function viewTx(id) {
  const t = S.db.transactions.find((x) => x.id === id);
  if (!t) return viewHome();
  const statusText = { pending: "Reserverad i banken", booked: "Bokförd", manual: "Inlagd för hand", quick: "Från Apple Pay-genvägen" }[t.status];
  page({
    title: "Köp",
    back: "#/",
    body: `
      <div class="card hero">
        <div class="huge ${t.amount > 0 ? "pos" : ""}">${kr(t.amount, { sign: true })}</div>
        <div class="row-title">${esc(t.description)}</div>
        <div class="muted small">${shortDate(t.date)} · ${statusText}${t.created_by ? ` · ${esc(memberName(t.created_by))}` : ""}</div>
      </div>
      <h2 class="section">Hink</h2>
      <div class="card">
        ${bucketChips(t.kind === "expense" ? t.bucket_id : null, { selectedIncome: t.kind === "income" })}
        <label class="toggle"><input type="checkbox" id="remember"> Kom ihåg för</label>
        <input id="pattern" value="${esc(suggestPattern(t.description))}" aria-label="Mönster för regel">
        <p class="muted small">Framtida köp vars text innehåller mönstret hamnar automatiskt i den hink du väljer.</p>
      </div>
      <h2 class="section">Anteckning</h2>
      <form class="card form" data-submit="note">
        <textarea name="note" rows="2" placeholder="T.ex. present till mamma">${esc(t.note)}</textarea>
        <button class="btn" type="submit">Spara anteckning</button>
      </form>
      ${t.status === "manual" || t.status === "quick" ? `<button class="btn danger full" data-act="delete">Ta bort köpet</button>` : ""}`,
  });
  S.handlers = {
    pick: (el) =>
      run(async () => {
        const income = el.dataset.bucket === "income";
        const patch = { kind: income ? "income" : "expense", bucket_id: income ? null : el.dataset.bucket, categorized_by: "user" };
        await S.store.update("transactions", { id }, patch);
        let extra = 0;
        if (document.getElementById("remember").checked) {
          extra = await saveRuleAndApply({ pattern: document.getElementById("pattern").value, ...patch }, id);
        }
        toast(`Flyttat till ${income ? "Att fördela" : bucketById(patch.bucket_id).name}${extra ? ` (+${extra} till)` : ""}`);
        await refresh();
      }),
    note: (f) =>
      run(async () => {
        await S.store.update("transactions", { id }, { note: f.get("note").trim() || null });
        toast("Sparat");
        await refresh();
      }),
    delete: () =>
      run(async () => {
        if (!confirm("Ta bort köpet?")) return;
        await S.store.remove("transactions", { id });
        await reloadAndGo("#/");
      }),
  };
}

function viewNewTx() {
  page({
    title: "Nytt köp",
    body: `
      <form class="card form" data-submit="add">
        <div class="segmented">
          <label><input type="radio" name="kind" value="expense" checked><span>Utgift</span></label>
          <label><input type="radio" name="kind" value="income"><span>Inkomst</span></label>
        </div>
        <label>Belopp (kr)<input name="amount" inputmode="decimal" placeholder="0" required autofocus></label>
        <label>Vad<input name="description" placeholder="T.ex. Bio med vänner" required></label>
        <label>Datum<input name="date" type="date" value="${today()}" required></label>
        <label>Hink<select name="bucket">${bucketOptions("", { includeNone: true })}</select></label>
        <button class="btn primary" type="submit">Lägg till</button>
      </form>
      <p class="muted small center">Köp med kortet kommer in automatiskt från banken. Här lägger ni in sådant som betalats på annat sätt, t.ex. kontanter.</p>`,
  });
  S.handlers = {
    add: (f) =>
      run(async () => {
        const ore = Math.abs(parseAmountToOre(f.get("amount")));
        if (!ore) throw new Error("Ange ett belopp");
        const kind = f.get("kind");
        const tx = { date: f.get("date"), amount: kind === "income" ? ore : -ore, description: f.get("description").trim(), status: "manual", created_by: S.me.user_id };
        let cls = { kind, bucket_id: null, categorized_by: "none" };
        if (kind === "expense") cls = f.get("bucket") ? { kind, bucket_id: f.get("bucket"), categorized_by: "user" } : classify(tx, S.db.rules);
        await S.store.insert("transactions", [{ ...tx, ...cls }]);
        toast("Tillagt");
        await reloadAndGo(cls.bucket_id ? `#/hink/${cls.bucket_id}` : "#/");
      }),
  };
}

function viewTransfer() {
  const q = query();
  const from = q.has("from") ? q.get("from") : activeBuckets()[0]?.id ?? "";
  const to = q.has("to") ? q.get("to") : q.has("from") && q.get("from") === "" ? activeBuckets()[0]?.id ?? "" : "";
  const recent = [...S.db.transfers].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 15);
  const name = (id) => (id ? `${bucketById(id)?.icon ?? ""} ${bucketById(id)?.name ?? "?"}` : "💰 Att fördela");
  page({
    title: "Flytta pengar",
    body: `
      <form class="card form" data-submit="transfer">
        <label>Från<select name="from">${bucketOptions(from, { includeAttFordela: true })}</select></label>
        <label>Till<select name="to">${bucketOptions(to, { includeAttFordela: true })}</select></label>
        <label>Belopp (kr)<input name="amount" inputmode="decimal" placeholder="0" required></label>
        <label>Anteckning<input name="note" placeholder="Valfritt"></label>
        <button class="btn primary" type="submit">Flytta</button>
      </form>
      ${
        recent.length
          ? `<h2 class="section">Senaste flyttarna</h2><div class="card list">${recent
              .map(
                (t) => `<div class="row"><div class="row-main"><div class="row-title">${esc(name(t.from_bucket))} → ${esc(name(t.to_bucket))}</div>
                  <div class="row-sub">${relDate(t.created_at.slice(0, 10))}${t.created_by ? ` · ${esc(memberName(t.created_by))}` : ""}${t.note ? ` · ${esc(t.note)}` : ""}</div></div>
                  <div class="row-amount">${kr(t.amount)}</div>
                  <button class="icon-btn small" data-act="undo" data-id="${t.id}" aria-label="Ångra flytt">✕</button></div>`,
              )
              .join("")}</div>`
          : ""
      }`,
  });
  S.handlers = {
    transfer: (f) =>
      run(async () => {
        const amount = Math.abs(parseAmountToOre(f.get("amount")));
        const fromId = f.get("from") || null;
        const toId = f.get("to") || null;
        if (!amount) throw new Error("Ange ett belopp");
        if (fromId === toId) throw new Error("Välj två olika hinkar");
        await S.store.insert("transfers", [{ from_bucket: fromId, to_bucket: toId, amount, note: f.get("note").trim() || null, created_by: S.me.user_id }]);
        toast(`${formatKr(amount)} flyttat`);
        await reloadAndGo(toId ? `#/hink/${toId}` : "#/");
      }),
    undo: (el) =>
      run(async () => {
        if (!confirm("Ångra flytten?")) return;
        await S.store.remove("transfers", { id: el.dataset.id });
        await refresh();
      }),
  };
}

function viewSettings() {
  const st = S.db.settings;
  const sumMonthly = activeBuckets().reduce((a, b) => a + b.monthly_amount, 0);
  const conn = S.db.bank_connections[0];
  page({
    title: "Inställningar",
    body: `
      <h2 class="section">Hinkar <span class="muted">${kr(sumMonthly)}/mån</span></h2>
      <div class="card list">
        ${activeBuckets()
          .map((b) => `<a class="row" href="#/installningar/hink/${b.id}"><div class="bucket-icon">${esc(b.icon)}</div><div class="row-main"><div class="row-title">${esc(b.name)}</div><div class="row-sub">${{ spending: "Löpande", savings: "Sparhink", personal: `Privat · ${esc(memberName(b.owner_id))}` }[b.kind]}</div></div><div class="row-amount">${kr(b.monthly_amount)}</div></a>`)
          .join("")}
        <a class="row add" href="#/installningar/hink/ny">＋ Ny hink</a>
      </div>

      <h2 class="section">Sortering och bank</h2>
      <div class="card list">
        <a class="row" href="#/installningar/regler"><div class="row-main"><div class="row-title">Regler</div><div class="row-sub">${S.db.rules.length} regler för automatisk sortering</div></div>›</a>
        <a class="row" href="#/installningar/bank"><div class="row-main"><div class="row-title">Bankkoppling</div><div class="row-sub">${conn ? `Swedbank · hämtat ${timeAgo(conn.last_sync_at)}` : "Inte kopplad"}</div></div>›</a>
        <a class="row" href="#/installningar/genvag"><div class="row-main"><div class="row-title">Apple Pay-genväg</div><div class="row-sub">Direkt besked när ni betalar med telefonen</div></div>›</a>
      </div>

      <h2 class="section">Notiser</h2>
      <div class="card">
        <p class="small muted" id="push-status">Kollar…</p>
        <div class="btn-row"><button class="btn" data-act="push">Slå på notiser</button><button class="btn" data-act="pushTest">Skicka testnotis</button></div>
      </div>

      <h2 class="section">Budget</h2>
      <form class="card form" data-submit="budget">
        <label>Lönedag (månaden börjar)<input name="day" type="number" min="1" max="28" value="${st.period_start_day}"></label>
        <label>Startdatum<input name="start_date" type="date" value="${esc(st.start_date || today())}"></label>
        <label>Startsaldo (kr)<input name="start_balance" inputmode="decimal" value="${st.start_balance / 100}"></label>
        <p class="muted small">Startsaldot är vad som fanns på kontot på startdatumet. Köp före startdatumet räknas inte.</p>
        <button class="btn" type="submit">Spara</button>
      </form>

      <h2 class="section">Konto</h2>
      <div class="card">
        <p class="small">${S.store.demo ? "Demoläge. Fyll i <code>js/config.js</code> för att koppla till Supabase." : `Inloggad som <b>${esc(S.session.user.email)}</b> (${esc(S.me.name)})`}</p>
        <div class="btn-row">
          ${S.store.demo ? '<button class="btn" data-act="resetDemo">Återställ demodata</button>' : '<button class="btn" data-act="logout">Logga ut</button>'}
        </div>
      </div>
      <p class="muted small center">Budgie · <a href="tests/">tester</a></p>`,
  });
  pushStatus();
  S.handlers = {
    budget: (f) =>
      run(async () => {
        const day = Number(f.get("day"));
        if (!(day >= 1 && day <= 28)) throw new Error("Lönedagen måste vara 1–28");
        const balance = parseAmountToOre(f.get("start_balance"));
        if (Number.isNaN(balance)) throw new Error("Ogiltigt startsaldo");
        await S.store.update("settings", { id: 1 }, { period_start_day: day, start_date: f.get("start_date"), start_balance: balance });
        toast("Sparat");
        await refresh();
      }),
    push: () => run(enablePush),
    pushTest: () =>
      run(async () => {
        await S.store.api("push-test");
        toast("Testnotis skickad");
      }),
    logout: () => run(async () => (await S.store.signOut(), location.reload())),
    resetDemo: () => confirm("Återställa demodatan?") && S.store.resetDemo(),
  };
}

function viewBucketEdit(id) {
  const isNew = id === "ny";
  const b = isNew ? { name: "", icon: "🪣", kind: "spending", owner_id: null, monthly_amount: 0, sort_order: S.db.buckets.length } : bucketById(id);
  if (!b) return viewSettings();
  const balance = isNew ? 0 : S.budget.buckets.get(id).balance;
  page({
    title: isNew ? "Ny hink" : "Ändra hink",
    back: isNew ? "#/installningar" : `#/hink/${id}`,
    body: `
      <form class="card form" data-submit="save">
        <div class="two-col">
          <label class="narrow">Ikon<input name="icon" value="${esc(b.icon)}" maxlength="4"></label>
          <label>Namn<input name="name" value="${esc(b.name)}" required></label>
        </div>
        <label>Typ<select name="kind">
          <option value="spending" ${b.kind === "spending" ? "selected" : ""}>Löpande – t.ex. Livsmedel</option>
          <option value="savings" ${b.kind === "savings" ? "selected" : ""}>Sparhink – t.ex. Resa, växer över tid</option>
          <option value="personal" ${b.kind === "personal" ? "selected" : ""}>Privat – egna pengar</option>
        </select></label>
        <label>Ägare (för privata hinkar)<select name="owner">
          <option value="">–</option>
          ${S.db.members.map((m) => `<option value="${m.user_id}" ${b.owner_id === m.user_id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
        </select></label>
        <label>Månadsbelopp (kr)<input name="monthly" inputmode="decimal" value="${b.monthly_amount / 100}"></label>
        ${isNew ? "" : `<label class="toggle"><input type="checkbox" name="thisMonth"> Ändra även den här månadens påfyllning</label>`}
        <label>Ordning<input name="sort" type="number" value="${b.sort_order}"></label>
        <button class="btn primary" type="submit">Spara</button>
      </form>
      ${isNew ? "" : `<button class="btn danger full" data-act="archive">Ta bort hinken</button><p class="muted small center">${balance ? `Saldot (${kr(balance)}) flyttas till Att fördela.` : ""} Gamla köp blir osorterade.</p>`}`,
  });
  S.handlers = {
    save: (f) =>
      run(async () => {
        const monthly = parseAmountToOre(f.get("monthly") || "0");
        if (Number.isNaN(monthly) || monthly < 0) throw new Error("Ogiltigt belopp");
        const row = {
          name: f.get("name").trim(),
          icon: f.get("icon").trim() || "🪣",
          kind: f.get("kind"),
          owner_id: f.get("kind") === "personal" ? f.get("owner") || null : null,
          monthly_amount: monthly,
          sort_order: Number(f.get("sort")) || 0,
        };
        if (isNew) {
          const [created] = await S.store.insert("buckets", [row]);
          toast("Hinken skapad");
          await reloadAndGo(`#/hink/${created.id}`);
        } else {
          await S.store.update("buckets", { id }, row);
          if (f.get("thisMonth")) {
            await S.store.update("allocations", { bucket_id: id, period_start: S.budget.period.start }, { amount: monthly });
          }
          toast("Sparat");
          await reloadAndGo(`#/hink/${id}`);
        }
      }),
    archive: () =>
      run(async () => {
        if (!confirm(`Ta bort ${b.name}?`)) return;
        if (balance > 0) await S.store.insert("transfers", [{ from_bucket: id, to_bucket: null, amount: balance, note: `${b.name} borttagen`, created_by: S.me.user_id }]);
        if (balance < 0) await S.store.insert("transfers", [{ from_bucket: null, to_bucket: id, amount: -balance, note: `${b.name} borttagen`, created_by: S.me.user_id }]);
        await S.store.update("buckets", { id }, { archived: true });
        await S.store.updateMany(
          "transactions",
          S.db.transactions.filter((t) => t.bucket_id === id).map((t) => t.id),
          { bucket_id: null, categorized_by: "none" },
        );
        await S.store.remove("rules", { bucket_id: id });
        await reloadAndGo("#/installningar");
      }),
  };
}

function viewRules() {
  const rules = [...S.db.rules].sort((a, b) => a.pattern.localeCompare(b.pattern, "sv"));
  const target = (r) => (r.kind === "income" ? "💰 Att fördela" : `${bucketById(r.bucket_id)?.icon ?? ""} ${bucketById(r.bucket_id)?.name ?? "?"}`);
  page({
    title: "Regler",
    back: "#/installningar",
    body: `
      <form class="card form" data-submit="add">
        <label>Om texten innehåller<input name="pattern" placeholder="t.ex. ica" required></label>
        <label>Lägg i<select name="bucket">${bucketOptions("", { includeIncome: true })}</select></label>
        <button class="btn primary" type="submit">Lägg till regel</button>
      </form>
      <div class="btn-row">
        <button class="btn" data-act="defaults">Lägg till förslag</button>
        <button class="btn" data-act="apply">Sortera osorterade nu</button>
      </div>
      <div class="card list">
        ${rules.map((r) => `<div class="row"><div class="row-main"><div class="row-title">${esc(r.pattern)}</div><div class="row-sub">${esc(target(r))}</div></div><button class="icon-btn small" data-act="del" data-id="${r.id}" aria-label="Ta bort regel">✕</button></div>`).join("") || '<div class="row muted">Inga regler än.</div>'}
      </div>`,
  });
  S.handlers = {
    add: (f) =>
      run(async () => {
        const income = f.get("bucket") === "income";
        const n = await saveRuleAndApply({ pattern: f.get("pattern"), kind: income ? "income" : "expense", bucket_id: income ? null : f.get("bucket") });
        toast(`Regel sparad${n ? `, ${n} köp sorterade` : ""}`);
        await refresh();
      }),
    defaults: () =>
      run(async () => {
        const have = new Set(S.db.rules.map((r) => r.pattern));
        const fresh = defaultRulesFor(S.db.buckets).filter((r) => !have.has(r.pattern));
        if (fresh.length) await S.store.insert("rules", fresh);
        toast(`${fresh.length} regler tillagda`);
        await refresh();
      }),
    apply: () =>
      run(async () => {
        let n = 0;
        for (const t of S.db.transactions.filter((t) => t.kind === "expense" && !t.bucket_id && inBudget(t))) {
          const r = matchRule(t, S.db.rules);
          if (!r) continue;
          await S.store.update("transactions", { id: t.id }, { kind: r.kind, bucket_id: r.kind === "income" ? null : r.bucket_id, categorized_by: "rule" });
          n++;
        }
        toast(`${n} köp sorterade`);
        await refresh();
      }),
    del: (el) =>
      run(async () => {
        await S.store.remove("rules", { id: el.dataset.id });
        await refresh();
      }),
  };
}

function viewBank() {
  const conns = S.db.bank_connections;
  page({
    title: "Bankkoppling",
    back: "#/installningar",
    body: `
      ${
        conns.length
          ? `<div class="card list">${conns
              .map((c) => {
                const days = c.valid_until ? Math.ceil((Date.parse(c.valid_until) - Date.now()) / 86400000) : null;
                return `<div class="row"><div class="row-main">
                  <div class="row-title">${esc(c.account_name || "Swedbank")} <span class="muted small">${esc(c.iban || "")}</span></div>
                  <div class="row-sub">Hämtat ${timeAgo(c.last_sync_at)}${c.last_balance != null ? ` · saldo ${kr(c.last_balance)}` : ""}</div>
                  <div class="row-sub ${days != null && days < 8 ? "warn" : ""}">${days == null ? "" : days > 0 ? `BankID-förnyelse om ${days} dagar` : "Medgivandet har gått ut – koppla igen"}</div>
                  ${c.last_error ? `<div class="row-sub warn">Fel: ${esc(c.last_error)}</div>` : ""}
                </div>
                <label class="switch"><input type="checkbox" data-act="toggle" data-id="${c.id}" ${c.enabled ? "checked" : ""}><span></span></label></div>`;
              })
              .join("")}</div>
            <div class="btn-row"><button class="btn primary" data-act="sync">Hämta nu</button><button class="btn" data-act="connect">Förnya med BankID</button></div>`
          : `<div class="card">
              <p>Koppla ert Swedbank-konto så kommer köpen in automatiskt, fyra gånger per dygn och varje gång ni öppnar appen.</p>
              <p class="muted small">Hämtningen går via Enable Banking (PSD2). Ni godkänner med BankID och kan dra tillbaka medgivandet när som helst.</p>
              <button class="btn primary full" data-act="connect">Koppla Swedbank med BankID</button>
            </div>`
      }
      <p class="muted small center">Slå bara på ert gemensamma lönekonto. Flyttar till sparkonton registreras då som utgifter eller överföringar från det kontot.</p>`,
  });
  S.handlers = {
    connect: () =>
      run(async () => {
        const { url } = await S.store.api("start");
        location.href = url;
      }),
    sync: () => run(() => syncBank()),
    toggle: (el) =>
      run(async () => {
        await S.store.update("bank_connections", { id: el.dataset.id }, { enabled: el.checked });
        if (el.checked) await syncBank();
        else await refresh();
      }),
  };
}

function viewShortcut() {
  const tokens = S.db.quick_tokens;
  const endpoint = `${S.store.functionsUrl}/quick`;
  page({
    title: "Apple Pay-genväg",
    back: "#/installningar",
    body: `
      <div class="card">
        <p>Banken skickar köp med några timmars fördröjning. Betalar ni med Apple Pay kan iPhone skicka köpet till Budgie direkt och visa vad som är kvar i hinken.</p>
        <div id="new-token"></div>
        <button class="btn primary full" data-act="create">Skapa token för den här telefonen</button>
      </div>
      <h2 class="section">Så sätter du upp genvägen</h2>
      <ol class="card steps">
        <li>Öppna <b>Genvägar</b> → <b>Automation</b> → <b>＋</b> → <b>Transaktion</b>. Välj kortet, låt "Vid tryck" vara valt och välj <b>Kör omedelbart</b>.</li>
        <li>Lägg till åtgärden <b>Hämta innehållet i URL</b> med URL<br><code class="copy">${esc(endpoint)}</code></li>
        <li>Tryck på pilen: Metod <b>POST</b>, Begärans brödtext <b>JSON</b>. Lägg till tre fält:
          <br><code>token</code> = din token
          <br><code>amount</code> = Genvägsinmatning → <i>Belopp</i>
          <br><code>merchant</code> = Genvägsinmatning → <i>Handlare</i></li>
        <li>Lägg till <b>Hämta ordboksvärde</b> för nyckeln <code>text</code> och sedan <b>Visa notis</b> med värdet.</li>
      </ol>
      <p class="muted small">Tailscale behövs inte. Om något går fel kommer köpet ändå in från banken senare.</p>
      ${
        tokens.length
          ? `<h2 class="section">Dina tokens</h2><div class="card list">${tokens
              .map((t) => `<div class="row"><div class="row-main"><div class="row-title">${esc(t.label || "Token")}</div><div class="row-sub">Skapad ${shortDate(t.created_at.slice(0, 10))}</div></div><button class="icon-btn small" data-act="del" data-hash="${t.token_hash}" aria-label="Ta bort token">✕</button></div>`)
              .join("")}</div>`
          : ""
      }`,
  });
  S.handlers = {
    create: () =>
      run(async () => {
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
        const token_hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        const label = `${S.me.name}s iPhone`;
        await S.store.insert("quick_tokens", [{ token_hash, user_id: S.me.user_id, label }]);
        await reload();
        viewShortcut();
        document.getElementById("new-token").innerHTML = `<p class="small">Din token (visas bara nu, kopiera den till genvägen):</p><code class="copy token">${esc(token)}</code>`;
      }),
    del: (el) =>
      run(async () => {
        if (!confirm("Ta bort token? Genvägen slutar fungera.")) return;
        await S.store.remove("quick_tokens", { token_hash: el.dataset.hash });
        await refresh();
      }),
  };
}

const SUGGESTED = [
  ["🧾", "Räkningar", "spending", 15000],
  ["🛒", "Livsmedel", "spending", 7000],
  ["🧴", "Hushåll", "spending", 1500],
  ["🚇", "Transport", "spending", 1500],
  ["🍷", "Lyx", "spending", 2500],
  ["🎁", "Presenter", "savings", 800],
  ["✈️", "Resa", "savings", 3000],
  ["🔧", "Oregelbundet", "savings", 1500],
  ["🛟", "Buffert", "savings", 2000],
];

function viewSetup() {
  const rows = [
    ...SUGGESTED.map(([icon, name, kind, amount]) => ({ icon, name, kind, amount, owner: "" })),
    ...S.db.members.map((m) => ({ icon: "👛", name: `${m.name}s pengar`, kind: "personal", amount: 1500, owner: m.user_id })),
  ];
  page({
    title: "Kom igång",
    tabs: false,
    body: `
      <form class="form" data-submit="setup">
        <div class="card">
          <p><b>Välj era hinkar</b> och hur mycket som ska fyllas på varje lönedag. Allt går att ändra senare.</p>
          ${rows
            .map(
              (r, i) => `<div class="setup-row">
                <input type="checkbox" name="use${i}" checked aria-label="Använd">
                <input name="icon${i}" value="${r.icon}" class="emoji" aria-label="Ikon">
                <input name="name${i}" value="${esc(r.name)}" aria-label="Namn">
                <input name="amount${i}" value="${r.amount}" inputmode="decimal" class="amount" aria-label="Belopp per månad">
                <input type="hidden" name="kind${i}" value="${r.kind}"><input type="hidden" name="owner${i}" value="${r.owner}">
              </div>`,
            )
            .join("")}
          <p class="muted small" id="setup-sum"></p>
        </div>
        <div class="card">
          <label>Lönedag (budgetmånaden börjar)<input name="day" type="number" min="1" max="28" value="25"></label>
          <label>Saldo på kontot idag (kr)<input name="balance" inputmode="decimal" placeholder="0" required></label>
          <label class="toggle"><input type="checkbox" name="fill" checked> Fyll hinkarna redan nu från saldot</label>
          <p class="muted small">Annars ligger saldot i Att fördela tills ni flyttar det, och hinkarna fylls på nästa lönedag.</p>
        </div>
        <button class="btn primary full" type="submit">Starta</button>
      </form>`,
  });
  const sum = () => {
    const out = document.getElementById("setup-sum");
    if (!out) return app.removeEventListener("input", sum);
    let total = 0;
    rows.forEach((_, i) => {
      if (document.querySelector(`[name=use${i}]`).checked) total += parseAmountToOre(document.querySelector(`[name=amount${i}]`).value || "0") || 0;
    });
    out.textContent = `Totalt ${formatKr(total)} per månad`;
  };
  app.addEventListener("input", sum);
  sum();
  S.handlers = {
    setup: (f) =>
      run(async () => {
        const balance = parseAmountToOre(f.get("balance"));
        if (Number.isNaN(balance)) throw new Error("Ange saldot på kontot");
        const day = Number(f.get("day")) || 25;
        const buckets = rows
          .map((_, i) => ({
            use: f.get(`use${i}`),
            name: f.get(`name${i}`).trim(),
            icon: f.get(`icon${i}`).trim() || "🪣",
            kind: f.get(`kind${i}`),
            owner_id: f.get(`owner${i}`) || null,
            monthly_amount: parseAmountToOre(f.get(`amount${i}`) || "0") || 0,
          }))
          .filter((b) => b.use && b.name)
          .map(({ use, ...b }, i) => ({ ...b, sort_order: i }));
        const startDate = today();
        await S.store.update("settings", { id: 1 }, { period_start_day: day, start_date: startDate, start_balance: balance });
        const created = await S.store.insert("buckets", buckets);
        await S.store.insert("rules", defaultRulesFor(created));
        // Är det lönedag idag fyller den vanliga påfyllningen hinkarna.
        if (f.get("fill") && periodFor(startDate, day).start !== startDate) {
          const fills = created.filter((b) => b.monthly_amount > 0).map((b) => ({ from_bucket: null, to_bucket: b.id, amount: b.monthly_amount, note: "Startsaldo", created_by: S.me.user_id }));
          if (fills.length) await S.store.insert("transfers", fills);
        }
        app.removeEventListener("input", sum);
        await reloadAndGo("#/");
        toast("Klart! Koppla banken under Inställningar.");
      }),
  };
}

// --- Notiser ------------------------------------------------------------------

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

async function pushStatus() {
  const el = document.getElementById("push-status");
  if (!el) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    el.textContent = /iphone|ipad/i.test(navigator.userAgent) && !isStandalone()
      ? "Lägg först till Budgie på hemskärmen (Dela → Lägg till på hemskärmen) och öppna appen därifrån."
      : "Den här webbläsaren stöder inte notiser.";
    return;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  el.textContent = sub ? "Notiser är påslagna på den här enheten." : "Notiser är avstängda på den här enheten.";
}

function base64UrlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (S.store.demo) throw new Error("I demoläget skickas inga notiser.");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Lägg till Budgie på hemskärmen och öppna den därifrån först.");
  }
  if (!config.VAPID_PUBLIC_KEY) throw new Error("VAPID_PUBLIC_KEY saknas i js/config.js");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notiser nekades. Ändra i Inställningar → Notiser → Budgie.");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(config.VAPID_PUBLIC_KEY) }));
  const { endpoint, keys } = sub.toJSON();
  await S.store.remove("push_subscriptions", { endpoint });
  await S.store.insert("push_subscriptions", [{ endpoint, user_id: S.me.user_id, p256dh: keys.p256dh, auth: keys.auth }]);
  toast("Notiser påslagna");
  pushStatus();
}

// --- Router och start ---------------------------------------------------------

const routes = [
  [/^#?\/?$/, viewHome],
  [/^#\/sortera$/, viewSort],
  [/^#\/hink\/([^/]+)$/, viewBucket],
  [/^#\/tx\/([^/]+)$/, viewTx],
  [/^#\/ny$/, viewNewTx],
  [/^#\/flytta$/, viewTransfer],
  [/^#\/installningar$/, viewSettings],
  [/^#\/installningar\/hink\/([^/]+)$/, viewBucketEdit],
  [/^#\/installningar\/regler$/, viewRules],
  [/^#\/installningar\/bank$/, viewBank],
  [/^#\/installningar\/genvag$/, viewShortcut],
  [/^#\/kom-igang$/, viewSetup],
];
const LIVE_VIEWS = [viewHome, viewSort, viewBucket];
let currentView = null;

function render() {
  if (!S.session) return viewLogin();
  if (!S.me) return viewNotMember();
  const hash = location.hash.split("?")[0];
  if (!S.db.buckets.length && hash !== "#/kom-igang") {
    location.hash = "#/kom-igang";
    return;
  }
  for (const [re, view] of routes) {
    const m = hash.match(re);
    if (m) {
      currentView = view;
      return view(...m.slice(1));
    }
  }
  currentView = viewHome;
  viewHome();
}

app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.matches("input[type=checkbox]")) return; // hanteras av change
  const handler = S.handlers[el.dataset.act];
  if (!handler) return;
  if (el.tagName === "A") e.preventDefault();
  handler(el, e);
});
app.addEventListener("change", (e) => {
  const el = e.target.closest("input[type=checkbox][data-act]");
  if (el) S.handlers[el.dataset.act]?.(el, e);
});
app.addEventListener("submit", (e) => {
  const form = e.target.closest("form[data-submit]");
  if (!form) return;
  e.preventDefault();
  S.handlers[form.dataset.submit]?.(new FormData(form), form);
});
window.addEventListener("hashchange", render);

/** Hämtar från banken när appen öppnas, om det var ett tag sedan. */
async function autoSync() {
  const conns = S.db?.bank_connections.filter((c) => c.enabled) ?? [];
  if (S.store.demo || !conns.length) return;
  const last = conns.map((c) => c.last_sync_at).filter(Boolean).sort().pop();
  if (last && Date.now() - Date.parse(last) < 30 * 60000) return;
  try {
    await syncBank({ silent: true });
  } catch (e) {
    console.warn("Automatisk hämtning misslyckades", e);
  }
}

async function handleBankCallback() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return;
  history.replaceState(null, "", location.pathname + "#/installningar/bank");
  if (params.has("error")) return toast(`Bankkopplingen avbröts: ${params.get("error_description") || params.get("error")}`, "error");
  await run(async () => {
    const result = await S.store.api("session", { code: params.get("code"), state: params.get("state") });
    if (!result.enabled) {
      await refresh();
      return toast(`Swedbank kopplat (${result.accounts} konton). Slå på ert gemensamma lönekonto nedan.`);
    }
    toast(`Swedbank kopplat (${result.accounts} konto${result.accounts === 1 ? "" : "n"})`);
    await syncBank({ silent: true });
  });
}

async function start() {
  if (!S.session) return render();
  await reload();
  render();
  if (!S.me) return;
  await handleBankCallback();
  S.store.subscribe(async () => {
    await reload();
    if (LIVE_VIEWS.includes(currentView)) render();
  });
  autoSync();
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !S.me) return;
  await reload();
  if (LIVE_VIEWS.includes(currentView)) render();
  autoSync();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch((e) => console.warn(e));

(async () => {
  try {
    S.store = await createStore();
    S.session = await S.store.session();
    S.store.onAuthChange((session) => {
      if (!session && S.session) location.reload();
    });
    await start();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="card error-card"><b>Något gick fel</b><p>${esc(e.message)}</p></div>`;
  }
})();
