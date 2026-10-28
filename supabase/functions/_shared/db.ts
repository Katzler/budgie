import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.49.4";
import { activeTransactions, missingAllocations, todayInSweden } from "./budget.js";
import { HttpError } from "./http.ts";

export type Db = SupabaseClient;

/** Klient med service role. Kringgår RLS, används bara här på servern. */
export function serviceClient(): Db {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

export function check<T>({ data, error }: { data: T; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data;
}

/** Kontrollerar att anropet kommer från en inloggad medlem i hushållet. */
export async function requireMember(req: Request, db: Db) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Inte inloggad");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Ogiltig inloggning");
  const member = check(await db.from("members").select("*").eq("user_id", data.user.id).maybeSingle());
  if (!member) throw new HttpError(403, "Kontot är inte medlem i hushållet");
  return member as { user_id: string; name: string };
}

async function selectAll(db: Db, table: string) {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const page = check(await db.from(table).select("*").range(from, from + 999)) as any[];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

/** Allt som behövs för att räkna saldon. Fyller också på hinkar som saknar månadens påfyllning. */
export async function loadState(db: Db) {
  const [settingsRows, buckets, allocations, transfers, allTransactions, rules, members, connections] = await Promise.all(
    ["settings", "buckets", "allocations", "transfers", "transactions", "rules", "members", "bank_connections"].map((t) => selectAll(db, t)),
  );
  const transactions = activeTransactions(allTransactions, connections);
  const settings = settingsRows[0] ?? { period_start_day: 25, start_balance: 0, start_date: null };
  const today = todayInSweden();
  const missing = missingAllocations({ settings, buckets, allocations, today });
  if (missing.length) {
    check(await db.from("allocations").upsert(missing, { onConflict: "bucket_id,period_start", ignoreDuplicates: true }));
    allocations.push(...missing);
  }
  return { settings, buckets, allocations, transfers, transactions, rules, members, today };
}
