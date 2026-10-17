// Supabase Edge Function: aps-proxy
// Puente entre el Visor CAD (navegador) y Autodesk Platform Services (APS).
// Guarda las credenciales APS en el servidor y evita los bloqueos CORS de APS.
//
// Secretos necesarios (supabase secrets set ...):
//   APS_CLIENT_ID, APS_CLIENT_SECRET
// Opcionales:
//   APS_BUCKET     clave de bucket (por defecto "visorcad-<clientid en minúsculas>")
//   VISOR_KEY      si se define, el visor debe enviar la cabecera x-visor-key con este valor
//   ALLOWED_ORIGIN origen permitido para CORS (por defecto "*")
//
// Acciones (?action=...):
//   token                    -> token de solo lectura (viewables:read) para Autodesk Viewer
//   check&key=..             -> devuelve urn y estado si el fichero ya se tradujo antes
//   upload&key=..&root=..    -> cuerpo = bytes del fichero (o .zip); sube a OSS y lanza traducción SVF2
//   status&urn=..            -> estado del manifiesto de traducción

const APS = Deno.env.get("APS_BASE") ?? "https://developer.api.autodesk.com"; // APS_BASE solo para pruebas
const CLIENT_ID = Deno.env.get("APS_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("APS_CLIENT_SECRET") ?? "";
const BUCKET = (Deno.env.get("APS_BUCKET") ?? `visorcad-${CLIENT_ID.toLowerCase().slice(0, 24)}`)
  .toLowerCase().replace(/[^-_.a-z0-9]/g, "");
const VISOR_KEY = Deno.env.get("VISOR_KEY") ?? "";
const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-visor-key, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const tokenCache = new Map<string, { token: string; exp: number }>();
async function getToken(scope: string) {
  const c = tokenCache.get(scope);
  if (c && c.exp > Date.now() + 60_000) return c;
  const r = await fetch(`${APS}/authentication/v2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });
  if (!r.ok) throw new Error(`APS auth ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const t = { token: j.access_token as string, exp: Date.now() + j.expires_in * 1000 };
  tokenCache.set(scope, t);
  return t;
}

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const objectKeyOf = (k: string) => k.replace(/[^-_.A-Za-z0-9]/g, "_").slice(0, 200);
const urnOf = (key: string) => b64url(`urn:adsk.objects:os.object:${BUCKET}/${objectKeyOf(key)}`);

async function manifest(urn: string, token: string) {
  const r = await fetch(`${APS}/modelderivative/v2/designdata/${urn}/manifest`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Manifest ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function ensureBucket(token: string) {
  const r = await fetch(`${APS}/oss/v2/buckets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bucketKey: BUCKET, policyKey: "temporary" }), // 30 días
  });
  if (!r.ok && r.status !== 409) throw new Error(`Bucket ${r.status}: ${await r.text()}`);
}

async function uploadObject(key: string, data: Uint8Array<ArrayBuffer>, token: string) {
  const obj = encodeURIComponent(objectKeyOf(key));
  const PART = 50 * 1024 * 1024;
  const parts = Math.max(1, Math.ceil(data.length / PART));
  const s = await fetch(`${APS}/oss/v2/buckets/${BUCKET}/objects/${obj}/signeds3upload?parts=${parts}&minutesExpiration=30`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!s.ok) throw new Error(`signeds3upload ${s.status}: ${await s.text()}`);
  const { uploadKey, urls } = await s.json();
  for (let i = 0; i < parts; i++) {
    const put = await fetch(urls[i], { method: "PUT", body: data.subarray(i * PART, Math.min(data.length, (i + 1) * PART)) });
    if (!put.ok) throw new Error(`S3 PUT parte ${i + 1}: ${put.status}`);
  }
  const done = await fetch(`${APS}/oss/v2/buckets/${BUCKET}/objects/${obj}/signeds3upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uploadKey }),
  });
  if (!done.ok) throw new Error(`Completar subida ${done.status}: ${await done.text()}`);
  return (await done.json()).objectId as string;
}

async function translate(urn: string, root: string | null, token: string) {
  const input: Record<string, unknown> = { urn };
  if (root) { input.compressedUrn = true; input.rootFilename = root; }
  const r = await fetch(`${APS}/modelderivative/v2/designdata/job`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-ads-force": "true" },
    body: JSON.stringify({ input, output: { formats: [{ type: "svf2", views: ["2d", "3d"] }] } }),
  });
  if (!r.ok) throw new Error(`Traducción ${r.status}: ${await r.text()}`);
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: "Faltan APS_CLIENT_ID / APS_CLIENT_SECRET en los secretos de la función." }, 500);
    if (VISOR_KEY && req.headers.get("x-visor-key") !== VISOR_KEY) return json({ error: "Clave del visor no válida." }, 401);
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (action === "token") {
      const t = await getToken("viewables:read");
      return json({ access_token: t.token, expires_in: Math.floor((t.exp - Date.now()) / 1000) });
    }
    if (action === "check") {
      const key = url.searchParams.get("key");
      if (!key) return json({ error: "Falta key" }, 400);
      const urn = urnOf(key);
      const t = await getToken("data:read viewables:read");
      const m = await manifest(urn, t.token);
      return json({ urn, exists: !!m, status: m?.status ?? null, progress: m?.progress ?? null });
    }
    if (action === "status") {
      const urn = url.searchParams.get("urn");
      if (!urn) return json({ error: "Falta urn" }, 400);
      const t = await getToken("data:read viewables:read");
      const m = await manifest(urn, t.token);
      const msgs: string[] = [];
      const walk = (n: any) => { (n?.messages ?? []).forEach((x: any) => msgs.push(`${x.type}: ${Array.isArray(x.message) ? x.message.join(" ") : x.message}`)); (n?.derivatives ?? n?.children ?? []).forEach(walk); };
      walk(m);
      return json({ urn, status: m?.status ?? "pending", progress: m?.progress ?? "0%", messages: msgs.slice(0, 20) });
    }
    if (action === "upload" && req.method === "POST") {
      const key = url.searchParams.get("key");
      const root = url.searchParams.get("root");
      if (!key) return json({ error: "Falta key" }, 400);
      const data = new Uint8Array(await req.arrayBuffer());
      if (!data.length) return json({ error: "Cuerpo vacío" }, 400);
      const t = await getToken("data:read data:write data:create bucket:create bucket:read");
      await ensureBucket(t.token);
      const objectId = await uploadObject(key, data, t.token);
      const urn = b64url(objectId);
      await translate(urn, root, t.token);
      return json({ urn, status: "inprogress" });
    }
    return json({ error: "Acción no válida" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
