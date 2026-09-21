// Plan B: "sala en la nube" sobre Vercel Blob.
// Cuando los PC no logran conectarse directo, el archivo se sube por partes a Vercel Blob
// y el otro PC lo descarga desde la misma sala. Todo pasa por esta función, así que funciona
// tanto con almacenes Blob públicos como privados, y no hay problemas de CORS.

const { put, list, del, get } = require("@vercel/blob");

const ROOM_RE = /^[a-z0-9]{6,32}$/;
const ID_RE = /^[a-z0-9]{8,32}$/;
const PART_SIZE = 4 * 1024 * 1024; // Vercel limita el cuerpo de cada petición a 4,5 MB
const MAX_BYTES = Number(process.env.RELAY_MAX_MB || 100) * 1024 * 1024;
const TTL_MS = Number(process.env.RELAY_TTL_HOURS || 24) * 3600 * 1000;
let MODE = process.env.RELAY_ACCESS || null; // "private" o "public"; se detecta solo si no se define

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

async function withAccess(fn) {
  const modes = MODE ? [MODE, MODE === "private" ? "public" : "private"] : ["private", "public"];
  let last;
  for (const m of modes) {
    try { const r = await fn(m); MODE = m; return r; }
    catch (e) { last = e; if (!/access|private|public/i.test(String(e && e.message))) throw e; }
  }
  throw last;
}

async function readBody(req, limit) {
  const chunks = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw httpError(413, "La parte supera el tamaño permitido");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readBlob(pathname) {
  const r = await withAccess(m => get(pathname, { access: m, useCache: false }));
  if (!r || r.statusCode !== 200 || !r.stream) throw httpError(404, "Archivo no encontrado o ya expiró");
  return Buffer.from(await new Response(r.stream).arrayBuffer());
}

async function listAll(prefix) {
  const out = []; let cursor;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}

async function listRoom(base) {
  const blobs = await listAll(base);
  const groups = new Map();
  for (const b of blobs) {
    const id = b.pathname.slice(base.length).split("/")[0];
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(b);
  }
  const now = Date.now(), files = [], expired = [];
  for (const [id, arr] of groups) {
    const oldest = Math.min(...arr.map(b => new Date(b.uploadedAt).getTime()));
    if (now - oldest > TTL_MS) { expired.push(...arr.map(b => b.url)); continue; }
    if (!arr.some(b => b.pathname === `${base}${id}/manifest.json`)) continue; // subida en curso
    try {
      const m = JSON.parse((await readBlob(`${base}${id}/manifest.json`)).toString("utf8"));
      m.expiresAt = oldest + TTL_MS;
      files.push(m);
    } catch (e) { console.error("manifest", id, e.message); }
  }
  if (expired.length) { try { await del(expired); } catch (e) { console.error("limpieza", e.message); } }
  return files.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw httpError(503, "La sala en la nube no está activada. En Vercel: Storage, crear Blob, conectarlo al proyecto y hacer Redeploy.");
    }
    const q = new URL(req.url, "http://localhost").searchParams;
    const action = q.get("action") || "";
    const room = (q.get("room") || "").toLowerCase();
    if (!ROOM_RE.test(room)) throw httpError(400, "Sala no válida");
    const base = `tunel/${room}/`;
    const id = q.get("file") || "";
    const n = Number(q.get("n"));
    const partPath = () => {
      if (!ID_RE.test(id) || !Number.isInteger(n) || n < 0 || n * PART_SIZE >= MAX_BYTES) throw httpError(400, "Parte no válida");
      return `${base}${id}/p${String(n).padStart(4, "0")}.bin`;
    };

    // Listar archivos de la sala
    if (req.method === "GET" && !action) {
      return res.status(200).json({ files: await listRoom(base), maxBytes: MAX_BYTES, partSize: PART_SIZE, ttlMs: TTL_MS });
    }
    // Descargar una parte
    if (req.method === "GET" && action === "part") {
      const buf = await readBlob(partPath());
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", buf.length);
      return res.status(200).end(buf);
    }
    // Subir una parte
    if (req.method === "POST" && action === "part") {
      const path = partPath();
      const body = await readBody(req, PART_SIZE + 1024);
      await withAccess(m => put(path, body, { access: m, addRandomSuffix: false, allowOverwrite: true, contentType: "application/octet-stream" }));
      return res.status(200).json({ ok: true, n, bytes: body.length });
    }
    // Cerrar la subida: guarda el manifiesto y el archivo aparece para el otro PC
    if (req.method === "POST" && action === "finish") {
      const m = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const size = Number(m.size);
      const parts = Math.max(1, Math.ceil(size / PART_SIZE));
      if (!ID_RE.test(m.id) || !Number.isFinite(size) || size < 0 || size > MAX_BYTES) throw httpError(400, "Datos del archivo no válidos");
      const present = await listAll(`${base}${m.id}/`);
      const stored = present.filter(b => /\/p\d{4}\.bin$/.test(b.pathname));
      const total = stored.reduce((s, b) => s + b.size, 0);
      if (stored.length !== parts || total !== size) throw httpError(409, `Faltan partes en la nube (${stored.length} de ${parts})`);
      const manifest = {
        id: m.id,
        name: String(m.name || "archivo").slice(0, 200),
        type: String(m.type || "application/octet-stream").slice(0, 150),
        size, parts,
        hash: typeof m.hash === "string" ? m.hash.slice(0, 64) : null,
        from: String(m.from || "").slice(0, 60),
        uploadedAt: Date.now(),
      };
      await withAccess(a => put(`${base}${m.id}/manifest.json`, JSON.stringify(manifest), { access: a, addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" }));
      return res.status(200).json({ ok: true, file: manifest });
    }
    // Borrar un archivo
    if (req.method === "DELETE") {
      if (!ID_RE.test(id)) throw httpError(400, "Archivo no válido");
      const blobs = await listAll(`${base}${id}/`);
      if (blobs.length) await del(blobs.map(b => b.url));
      return res.status(200).json({ ok: true });
    }
    throw httpError(405, "Operación no permitida");
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Error del almacenamiento: " + e.message });
  }
};
