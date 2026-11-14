// Quests: status för uppdrag som ger pengar till den egna hinken.
// Samma regler som claim_quest och set_quest_check i 005_quests.sql, som är
// de som faktiskt bestämmer. Här räknas bara det som visas i appen.
import { parseISODate, toISODate } from "../supabase/functions/_shared/budget.js";

export function addDays(dateStr, days) {
  const d = parseISODate(dateStr);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

const daysFrom = (a, b) => Math.round((parseISODate(b) - parseISODate(a)) / 86400000);

/** Dagar i följd, äldst först. [{ start, end, length }] */
export function runsOf(days) {
  const sorted = [...new Set(days)].sort();
  const runs = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && addDays(last.end, 1) === day) {
      last.end = day;
      last.length += 1;
    } else runs.push({ start: day, end: day, length: 1 });
  }
  return runs;
}

/**
 * Streak: bocka i varje dag. Var `every_days`:e dag i rad ger en belöning.
 * Sviten lever så länge igår eller idag är ibockat; annars är den noll.
 * Belöningar som tjänats in men inte tagits finns kvar även om sviten bryts.
 */
export function streakStatus(quest, checks, claims, today) {
  const every = quest.every_days;
  const days = checks.filter((c) => c.quest_id === quest.id).map((c) => c.day);
  const runs = runsOf(days);
  const yesterday = addDays(today, -1);
  const current = runs.find((r) => r.end === today || r.end === yesterday);
  const length = current?.length ?? 0;
  const claimed = new Set(claims.filter((c) => c.quest_id === quest.id).map((c) => `${c.run_start}|${c.milestone}`));
  const claimable = runs.flatMap((r) =>
    Array.from({ length: Math.floor(r.length / every) }, (_, i) => ({ run_start: r.start, milestone: (i + 1) * every })).filter(
      (m) => !claimed.has(`${m.run_start}|${m.milestone}`),
    ),
  );
  // Visar 7/7 tills belöningen är tagen, sedan 7/14.
  const atUnclaimed = length > 0 && length % every === 0 && !claimed.has(`${current.start}|${length}`);
  const target = atUnclaimed ? length : (Math.floor(length / every) + 1) * every;
  return {
    length,
    target,
    inBlock: length - (target - every),
    checkedToday: days.includes(today),
    checkedYesterday: days.includes(yesterday),
    claimable,
    amount: claimable.length * quest.reward_amount,
  };
}

/** Cooldown: på hedersord, en gång per `every_days` dagar. */
export function cooldownStatus(quest, claims, today) {
  const last = claims
    .filter((c) => c.quest_id === quest.id)
    .map((c) => c.day)
    .sort()
    .pop();
  const nextDay = last ? addDays(last, quest.every_days) : today;
  const daysLeft = Math.max(0, daysFrom(today, nextDay));
  return { last: last ?? null, nextDay, daysLeft, ready: daysLeft === 0, amount: daysLeft === 0 ? quest.reward_amount : 0 };
}

export function questStatus(quest, checks, claims, today) {
  return quest.kind === "streak" ? streakStatus(quest, checks, claims, today) : cooldownStatus(quest, claims, today);
}

/**
 * Det som claim_quest gör, för demoläget. Returnerar nya claim-rader och
 * totalbeloppet, eller kastar samma fel som servern.
 */
export function planClaim(quest, checks, claims, today) {
  const s = questStatus(quest, checks, claims, today);
  if (quest.kind === "cooldown") {
    if (!s.ready) throw new Error(`Nya pengar kan tas om ${s.daysLeft} ${s.daysLeft === 1 ? "dag" : "dagar"}`);
    return { amount: quest.reward_amount, rows: [{ run_start: null, milestone: null }] };
  }
  if (!s.claimable.length) throw new Error("Du har inga pengar att ta än, fortsätt varje dag");
  return { amount: s.amount, rows: s.claimable };
}

/** Kan en dag bockas ur? Inte om den ingår i en belöning som redan är tagen. */
export function dayLocked(quest, claims, day) {
  return claims.some(
    (c) => c.quest_id === quest.id && c.run_start && day >= c.run_start && day <= addDays(c.run_start, c.milestone - 1),
  );
}
