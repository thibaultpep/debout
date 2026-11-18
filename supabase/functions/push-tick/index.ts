// Debout ! — envoi des notifications push.
// Appelée chaque minute par pg_cron (via pg_net). Protégée par un secret partagé.
import webpush from "npm:web-push@3.6.7";
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false, idle_timeout: 20 });

Deno.serve(async (req) => {
  const secret = req.headers.get("x-tick-secret") ?? "";
  const [{ ok }] = await sql`select public.check_tick_secret(${secret}) as ok`;
  if (ok !== true) return new Response("forbidden", { status: 403 });

  const [{ r: due }] = await sql`select public.push_due() as r`;
  const items = (due.items ?? []) as Array<{
    endpoint: string; p256dh: string; auth: string; payload: Record<string, unknown>;
  }>;
  if (!items.length) return Response.json({ sent: 0 });

  webpush.setVapidDetails(due.vapid_subject, due.vapid_public, due.vapid_private);

  let sent = 0, gone = 0, failed = 0;
  await Promise.all(items.map(async (it) => {
    try {
      await webpush.sendNotification(
        { endpoint: it.endpoint, keys: { p256dh: it.p256dh, auth: it.auth } },
        JSON.stringify(it.payload),
        { TTL: 600, urgency: "high" },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        gone++;
        await sql`select public.push_gone(${it.endpoint})`.catch(() => {});
      } else {
        failed++;
        console.error("push error", code, String(e));
      }
    }
  }));
  console.log(JSON.stringify({ sent, gone, failed }));
  return Response.json({ sent, gone, failed });
});
