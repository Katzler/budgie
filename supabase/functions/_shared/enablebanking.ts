// Klient för Enable Banking (PSD2). https://enablebanking.com/docs/api/reference/
import { importPKCS8, SignJWT } from "npm:jose@5.9.6";

const API = "https://api.enablebanking.com";
let cached: { token: string; exp: number } | null = null;

export class EbError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function jwt() {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  const appId = Deno.env.get("EB_APP_ID");
  const pem = Deno.env.get("EB_PRIVATE_KEY");
  if (!appId || !pem) throw new Error("EB_APP_ID och EB_PRIVATE_KEY måste vara satta som secrets");
  const key = await importPKCS8(pem.replace(/\\n/g, "\n"), "RS256");
  const exp = now + 3600;
  const token = await new SignJWT({})
    .setProtectedHeader({ typ: "JWT", alg: "RS256", kid: appId })
    .setIssuer("enablebanking.com")
    .setAudience("api.enablebanking.com")
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(key);
  cached = { token, exp };
  return token;
}

type Psu = { ip: string; userAgent: string };

async function request(path: string, { method = "GET", body, psu }: { method?: string; body?: unknown; psu?: Psu } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${await jwt()}`, "Content-Type": "application/json" };
  if (psu) {
    headers["Psu-Ip-Address"] = psu.ip;
    headers["Psu-User-Agent"] = psu.userAgent;
  }
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    throw new EbError(res.status, String(data.error ?? data.code ?? ""), `Enable Banking ${res.status}: ${data.message ?? data.detail ?? text}`);
  }
  return data;
}

/**
 * Anrop med PSU-headers när användaren är aktiv. Kräver banken fler headers
 * än vi kan skicka görs anropet om utan dem (då gäller gränsen 4 per dygn).
 */
export async function eb(path: string, opts: { method?: string; body?: unknown; psu?: Psu } = {}) {
  try {
    return await request(path, opts);
  } catch (e) {
    if (opts.psu && e instanceof EbError && /PSU_HEADER/i.test(`${e.code} ${e.message}`)) {
      return request(path, { ...opts, psu: undefined });
    }
    throw e;
  }
}

export const ASPSP = { name: Deno.env.get("EB_ASPSP_NAME") ?? "Swedbank", country: "SE" };

/** Längsta tillåtna medgivande för banken, högst 180 dagar. */
export async function maxConsentValidUntil() {
  let seconds = 90 * 86400;
  try {
    const { aspsps } = await eb(`/aspsps?country=${ASPSP.country}`);
    const bank = aspsps?.find((a: any) => a.name === ASPSP.name);
    if (bank?.maximum_consent_validity) seconds = Math.min(bank.maximum_consent_validity, 180 * 86400);
  } catch (e) {
    console.warn("Kunde inte läsa bankens maxgräns, använder 90 dagar", e);
  }
  return new Date(Date.now() + seconds * 1000 - 60000).toISOString();
}

/**
 * Bankens transaktion → vår rad (utan id, typ och hink).
 * `connectionId` är vår egen bank_connections.id. Den behålls när medgivandet
 * förnyas (då byter banken konto-id), så external_id förblir stabilt.
 */
export async function toTransaction(raw: any, connectionId: string) {
  const abs = Math.round(Math.abs(parseFloat(raw.transaction_amount?.amount ?? "0")) * 100);
  const amount = raw.credit_debit_indicator === "DBIT" ? -abs : abs;
  const date = raw.transaction_date ?? raw.booking_date ?? raw.value_date;
  const counterparty = (amount < 0 ? raw.creditor?.name : raw.debtor?.name) ?? null;
  const description = (raw.remittance_information ?? []).join(" ").trim() || counterparty || raw.note || "Okänd transaktion";
  const status = raw.status === "PDNG" ? "pending" : "booked";
  let externalId = raw.entry_reference ?? raw.transaction_id;
  if (!externalId) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${date}|${amount}|${description}|${status}`));
    externalId = "h:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }
  return { external_id: `${connectionId}:${externalId}`, connection_id: connectionId, date, amount, description, counterparty, status, raw };
}

/** Saldot som bäst motsvarar "disponibelt belopp" i bankens app. */
export function pickBalance(balances: any[]) {
  for (const type of ["ITAV", "CLAV", "XPCD", "ITBD", "CLBD"]) {
    const b = balances.find((x) => x.balance_type === type);
    if (b) return Math.round(parseFloat(b.balance_amount.amount) * 100);
  }
  return balances[0] ? Math.round(parseFloat(balances[0].balance_amount.amount) * 100) : null;
}
