// Función serverless de Vercel: entrega los servidores STUN/TURN al navegador.
// Sin TURN, dos PC en redes distintas (empresa, 4G, routers con NAT estricto) casi nunca logran conectarse.
// Las claves quedan en variables de entorno de Vercel y nunca se exponen en el código del cliente.

const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
const OPEN_RELAY = {
  urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:443?transport=tcp"],
  username: "openrelayproject",
  credential: "openrelayproject",
};

async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const env = process.env;
  let iceServers = null;
  let source = "relé público de respaldo";
  let warning;

  try {
    if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
      // Cloudflare Realtime TURN
      const j = await fetchJson(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl: 86400 }),
        }
      );
      const s = j.iceServers;
      iceServers = [...STUN, ...(Array.isArray(s) ? s : [s])];
      source = "Cloudflare TURN";
    } else if (env.METERED_DOMAIN && env.METERED_API_KEY) {
      // Metered TURN (ej. METERED_DOMAIN=miapp.metered.live)
      const j = await fetchJson(
        `https://${env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`
      );
      iceServers = [...STUN, ...(Array.isArray(j) ? j : [])];
      source = "Metered TURN";
    } else if (env.TURN_URLS) {
      // Servidor TURN propio (coturn, etc.)
      iceServers = [
        ...STUN,
        {
          urls: env.TURN_URLS.split(",").map((s) => s.trim()).filter(Boolean),
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL,
        },
      ];
      source = "TURN propio";
    }
  } catch (e) {
    warning = `No se pudieron obtener credenciales TURN (${e.message}); se usa el relé público.`;
    console.error(warning);
    iceServers = null;
  }

  if (!iceServers) iceServers = [...STUN, OPEN_RELAY];

  // Servidor de señalización PeerJS propio (opcional). Si no se define, se usa el público 0.peerjs.com.
  const peer = {};
  if (env.PEER_HOST) {
    peer.host = env.PEER_HOST;
    peer.port = Number(env.PEER_PORT || 443);
    peer.path = env.PEER_PATH || "/";
    peer.secure = env.PEER_SECURE !== "false";
    if (env.PEER_KEY) peer.key = env.PEER_KEY;
  }

  res.status(200).json({ iceServers, source, peer, warning });
};
