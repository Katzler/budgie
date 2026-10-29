// Tar emot köp från iOS-genvägen (automation "Transaktion" vid Apple Pay)
// och svarar direkt med hur mycket som är kvar i hinken.
//
// POST { token, amount, merchant, bucket? }  → { text, bucket, remaining }
// POST { token, action: "buckets" }          → { names: [...] }
import { HttpError, handle, json } from "../_shared/http.ts";
import { check, loadState, serviceClient } from "../_shared/db.ts";
import { computeBudget, formatKr, parseAmountToOre, todayInSweden, visibleTo } from "../_shared/budget.js";
import { classify } from "../_shared/categorize.js";
import { sendPush } from "../_shared/push.ts";

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(
  handle(async (req) => {
    const body = await req.json().catch(() => ({}));
    if (!body.token) throw new HttpError(401, "token saknas");
    const db = serviceClient();
    const saved = check(await db.from("quick_tokens").select("*").eq("token_hash", await sha256(String(body.token))).maybeSingle()) as any;
    if (!saved) throw new HttpError(401, "Okänd token");

    const state = await loadState(db);
    const buckets = state.buckets.filter((b: any) => !b.archived);
    // Den andras privata hink går inte att välja och visas inte.
    const mine = buckets.filter((b: any) => visibleTo(b, saved.user_id));

    if (body.action === "buckets") {
      return json({ names: mine.sort((a: any, b: any) => a.sort_order - b.sort_order).map((b: any) => b.name) });
    }

    const amount = -Math.abs(parseAmountToOre(body.amount));
    if (!amount) throw new HttpError(400, `Kunde inte läsa beloppet "${body.amount}"`);
    const merchant = String(body.merchant || "Apple Pay").trim().slice(0, 200);
    const tx = { date: todayInSweden(), amount, description: merchant, status: "quick", created_by: saved.user_id };

    const chosen = body.bucket ? mine.find((b: any) => b.name.toLowerCase() === String(body.bucket).trim().toLowerCase()) : null;
    const cls = chosen ? { kind: "expense", bucket_id: chosen.id, categorized_by: "quick" } : classify(tx, state.rules);
    const [row] = check(await db.from("transactions").insert({ ...tx, ...cls }).select()) as any[];

    state.transactions.push(row);
    const budget = computeBudget(state);
    const bucket = cls.bucket_id ? buckets.find((b: any) => b.id === cls.bucket_id) : null;
    const shown = bucket && visibleTo(bucket, saved.user_id);
    const remaining = shown ? budget.buckets.get(bucket.id)?.balance ?? 0 : null;
    const kr = (ore: number) => formatKr(ore, { decimals: "never" });
    const text = shown
      ? `${bucket.icon} ${bucket.name}: ${kr(remaining!)} kvar`
      : bucket
        ? `✓ ${formatKr(amount)} sorterat`
        : cls.kind === "income"
        ? `💰 Att fördela: ${kr(budget.attFordela)}`
        : `📥 ${formatKr(amount)} osorterat – öppna Budgie och välj hink`;

    // Den andra i hushållet får en notis; den som betalade ser svaret i genvägen.
    const who = state.members.find((m: any) => m.user_id === saved.user_id)?.name ?? "";
    const where = bucket ? `${bucket.icon} ${bucket.name}` : cls.kind === "income" ? "💰 Att fördela" : "📥 Osorterat";
    const others = state.members.filter((m: any) => m.user_id !== saved.user_id && (!bucket || visibleTo(bucket, m.user_id))).map((m: any) => m.user_id);
    if (others.length) await sendPush(db, { title: `${who}: ${merchant}`, body: `${formatKr(amount)} → ${where}`, url: `./#/tx/${row.id}`, tag: row.id }, { userIds: others });

    return json({ text, bucket: shown ? bucket.name : null, remaining });
  }),
);
