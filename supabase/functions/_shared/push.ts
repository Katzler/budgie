import webpush from "npm:web-push@3.6.7";
import { Db, check } from "./db.ts";

let configured = false;

export type PushPayload = { title: string; body: string; url?: string; tag?: string };

/** Skickar en notis till alla (eller valda) medlemmars enheter. */
export async function sendPush(db: Db, payload: PushPayload, { userIds, excludeUserId }: { userIds?: string[]; excludeUserId?: string } = {}) {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) {
    console.warn("VAPID-nycklar saknas, inga notiser skickas");
    return 0;
  }
  if (!configured) {
    webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:budgie@example.com", publicKey, privateKey);
    configured = true;
  }
  let q = db.from("push_subscriptions").select("*");
  if (userIds) q = q.in("user_id", userIds);
  const subs = (check(await q) as any[]).filter((s) => s.user_id !== excludeUserId);
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 86400 });
        sent++;
      } catch (e: any) {
        // Prenumerationen finns inte längre (appen borttagen eller notiser avstängda).
        if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        else console.error("Push misslyckades", e?.statusCode, e?.body ?? e);
      }
    }),
  );
  return sent;
}
