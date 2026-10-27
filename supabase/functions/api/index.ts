// Budgie API: bankkoppling, hämtning och testnotis.
// Anropas från appen (med användarens inloggning) eller från pg_cron (med x-cron-secret).
import { HttpError, handle, json, psuFrom } from "../_shared/http.ts";
import { check, requireMember, serviceClient } from "../_shared/db.ts";
import { ASPSP, eb, maxConsentValidUntil, pickBalance } from "../_shared/enablebanking.ts";
import { syncAll } from "../_shared/sync.ts";
import { sendPush } from "../_shared/push.ts";
import { todayInSweden } from "../_shared/budget.js";

Deno.serve(
  handle(async (req) => {
    const body = await req.json().catch(() => ({}));
    const db = serviceClient();
    const cronSecret = Deno.env.get("CRON_SECRET");
    const isCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;

    if (isCron) {
      if (body.action !== "sync") throw new HttpError(400, "Cron får bara köra sync");
      return json(await syncAll(db, { reminders: true }));
    }

    const member = await requireMember(req, db);

    switch (body.action) {
      case "sync":
        return json(await syncAll(db, { psu: psuFrom(req) }));

      case "start": {
        const appUrl = Deno.env.get("APP_URL");
        if (!appUrl) throw new Error("Secret APP_URL saknas");
        const state = crypto.randomUUID();
        await db.from("bank_auth_states").delete().lt("created_at", new Date(Date.now() - 3600000).toISOString());
        check(await db.from("bank_auth_states").insert({ state, created_by: member.user_id }));
        const res = await eb("/auth", {
          method: "POST",
          body: {
            access: { valid_until: await maxConsentValidUntil() },
            aspsp: ASPSP,
            state,
            redirect_url: appUrl,
            psu_type: "personal",
            language: "sv",
          },
        });
        return json({ url: res.url });
      }

      case "session": {
        if (!body.code || !body.state) throw new HttpError(400, "code och state krävs");
        const saved = check(await db.from("bank_auth_states").select("*").eq("state", body.state).maybeSingle()) as any;
        if (!saved || Date.now() - Date.parse(saved.created_at) > 3600000) throw new HttpError(400, "Ogiltig eller för gammal inloggning, försök igen");
        await db.from("bank_auth_states").delete().eq("state", body.state);

        const session = await eb("/sessions", { method: "POST", body: { code: body.code } });
        const existing = check(await db.from("bank_connections").select("*")) as any[];
        // Med flera konton följs inget automatiskt; ni väljer ert gemensamma konto i appen.
        const enableNew = (session.accounts?.length ?? 0) === 1;
        let total = 0;
        for (const acc of session.accounts ?? []) {
          const iban = acc.account_id?.iban ?? null;
          const row = {
            session_id: session.session_id,
            account_uid: acc.uid,
            account_name: acc.name ?? acc.product ?? "Swedbank",
            iban,
            valid_until: session.access?.valid_until ?? null,
            last_error: null,
            reminded_at: null,
          };
          // Vid förnyelse får kontot ett nytt uid hos banken; behåll vår rad (och historiken) via IBAN.
          const old = existing.find((c) => (iban && c.iban === iban) || c.account_uid === acc.uid);
          if (old) check(await db.from("bank_connections").update(row).eq("id", old.id));
          else check(await db.from("bank_connections").insert({ ...row, enabled: enableNew }));
          if (!(old?.enabled ?? enableNew)) continue;
          try {
            const { balances } = await eb(`/accounts/${acc.uid}/balances`);
            total += pickBalance(balances ?? []) ?? 0;
          } catch (e) {
            console.warn("Kunde inte hämta saldo", e);
          }
        }
        // Har appen inget startdatum än börjar budgeten idag med bankens saldo.
        const settings = check(await db.from("settings").select("*").single()) as any;
        if (!settings.start_date) {
          check(await db.from("settings").update({ start_date: todayInSweden(), start_balance: total }).eq("id", 1));
        }
        const enabled = (check(await db.from("bank_connections").select("id").eq("enabled", true)) as any[]).length;
        return json({ accounts: session.accounts?.length ?? 0, enabled });
      }

      case "push-test": {
        const sent = await sendPush(db, { title: "Budgie", body: "Testnotis – det fungerar! 🎉", url: "./" }, { userIds: [member.user_id] });
        if (!sent) throw new HttpError(400, "Ingen enhet med notiser hittades. Slå på notiser först.");
        return json({ sent });
      }

      default:
        throw new HttpError(400, `Okänd action: ${body.action}`);
    }
  }),
);
