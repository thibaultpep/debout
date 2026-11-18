// Debout ! — envoi des notifications push.
// Appelée chaque minute par pg_cron (via pg_net). Protégée par un secret partagé.
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rpc(fn: string, args: Record<string, unknown> = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  return r.json();
}

Deno.serve(async (req) => {
  // le secret est vérifié en base : la fonction SQL check_tick_secret renvoie true/false
  const secret = req.headers.get("x-tick-secret") ?? "";
  const ok = await rpc("check_tick_secret", { p_secret: secret });
  if (ok !== true) return new Response("forbidden", { status: 403 });

  const due = await rpc("push_due");
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
        await rpc("push_gone", { p_endpoint: it.endpoint }).catch(() => {});
      } else {
        failed++;
        console.error("push error", code, String(e));
      }
    }
  }));
  return Response.json({ sent, gone, failed });
});
