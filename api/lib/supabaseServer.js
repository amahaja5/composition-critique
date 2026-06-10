import { createClient } from "@supabase/supabase-js";

export function getSupabaseServerEnv() {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error("Supabase environment is not configured.");
  }
  return { anonKey, serviceRoleKey, supabaseUrl };
}

export function createServiceClient() {
  const { serviceRoleKey, supabaseUrl } = getSupabaseServerEnv();
  if (!serviceRoleKey) {
    throw new Error("Set SUPABASE_SERVICE_ROLE_KEY for server-side feedback APIs.");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

export async function authenticateRequest(req) {
  const { anonKey, supabaseUrl } = getSupabaseServerEnv();
  const token = getBearerToken(req);
  if (!token) {
    return { error: "Missing authorization token.", status: 401 };
  }
  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return { error: "Unable to validate signed-in user.", status: 401 };
  }
  return { token, user: data.user };
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

export function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

export function handleOptions(req, res, methods = "POST, OPTIONS") {
  if (req.method !== "OPTIONS") return false;
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.status(204).end();
  return true;
}

function getBearerToken(req) {
  const header = req.headers.authorization ?? req.headers.Authorization ?? "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}
