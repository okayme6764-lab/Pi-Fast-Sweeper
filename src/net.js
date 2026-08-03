/**
 * Couche réseau optimisée pour la latence.
 *
 * Trois idées, par ordre d'impact :
 *
 * 1. TLS PRÉ-CHAUFFÉ. Une soumission « à froid » paie DNS + handshake TCP
 *    (1 RTT) + handshake TLS (1-2 RTT) AVANT même d'envoyer le moindre octet
 *    utile : 150 à 400 ms perdus. On ouvre donc les sockets à l'avance et on
 *    les garde vivants (keep-alive + ré-chauffage périodique). Au moment de
 *    tirer, il ne reste qu'un seul aller-retour.
 *
 * 2. FAN-OUT MULTI-IP. `api.mainnet.minepi.com` résout vers 5 adresses
 *    distinctes. Le SDK n'en utilise qu'une, choisie par le résolveur — et si
 *    c'est la plus lente ou une qui bafouille, c'est perdu. On ouvre les 5 et
 *    on envoie la transaction aux 5 simultanément. Une soumission dupliquée
 *    est inoffensive : même hash, donc idempotente côté Horizon. On encaisse
 *    la latence de la plus RAPIDE au lieu d'une au hasard.
 *
 * 3. ZÉRO SDK DANS LE CHEMIN CHAUD. `server.submitTransaction()` refait de la
 *    validation, ré-encode, et enveloppe le tout dans axios. Ici on POST le
 *    XDR base64 déjà prêt sur un socket déjà ouvert.
 */

import https from "node:https";
import dns from "node:dns/promises";
import { log } from "./log.js";

const USER_AGENT = "pi-fast-sweeper/2.0";

export class Endpoint {
  constructor(ip, host, { maxSockets = 12 } = {}) {
    this.ip = ip;
    this.host = host;
    this.rtt = Number.POSITIVE_INFINITY;
    this.errors = 0;
    this.agent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 15_000,
      maxSockets,
      maxFreeSockets: maxSockets,
      scheduling: "fifo",
    });
  }

  get label() {
    return this.ip;
  }

  /** Sockets libres actuellement ouverts (donc handshake déjà payé). */
  get warmSockets() {
    return Object.values(this.agent.freeSockets ?? {}).reduce((n, l) => n + l.length, 0);
  }

  #options(method, path, extraHeaders = {}) {
    return {
      host: this.ip,
      servername: this.host, // SNI + validation du certificat sur le vrai nom
      port: 443,
      method,
      path,
      agent: this.agent,
      headers: {
        Host: this.host,
        "User-Agent": USER_AGENT,
        "Accept-Encoding": "identity", // pas de gzip : décompresser coûte plus que ça ne gagne
        ...extraHeaders,
      },
    };
  }

  /** Requête bufferisée. Résout { status, body, ms }. */
  request(method, path, { body = null, timeout = 8_000, headers = {} } = {}) {
    const started = process.hrtime.bigint();
    const opts = this.#options(method, path, headers);

    if (body !== null) {
      opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
      opts.headers["Content-Length"] = Buffer.byteLength(body);
    }

    return new Promise((resolve, reject) => {
      const req = https.request(opts, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), ms });
        });
      });
      req.setNoDelay(true); // désactive Nagle : on envoie le paquet tout de suite
      req.setTimeout(timeout, () => req.destroy(new Error(`timeout ${timeout}ms`)));
      req.on("error", (e) => {
        this.errors++;
        reject(e);
      });
      if (body !== null) req.write(body);
      req.end();
    });
  }

  /** Requête JSON. Lève si le statut n'est pas 2xx. */
  async json(path, opts) {
    const { status, body, ms } = await this.request("GET", path, opts);
    if (status < 200 || status >= 300) {
      const err = new Error(`HTTP ${status} sur ${path}`);
      err.status = status;
      err.body = body;
      throw err;
    }
    const parsed = JSON.parse(body);
    this.rtt = ms;
    return parsed;
  }

  /**
   * Flux SSE. `onEvent(data)` est appelé pour chaque événement.
   * Retourne une fonction d'arrêt.
   */
  stream(path, onEvent, onError) {
    const opts = this.#options("GET", path, { Accept: "text/event-stream" });
    let closed = false;
    let buf = "";

    const req = https.request(opts, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        onError?.(new Error(`SSE HTTP ${res.statusCode}`));
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let sep;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '"hello"' || payload === '"byebye"') continue;
            try {
              onEvent(JSON.parse(payload));
            } catch {
              /* trame partielle ou keep-alive : on ignore */
            }
          }
        }
      });
      res.on("end", () => !closed && onError?.(new Error("SSE fermé par le serveur")));
    });

    req.setNoDelay(true);
    req.on("error", (e) => !closed && onError?.(e));
    req.end();

    return () => {
      closed = true;
      req.destroy();
    };
  }

  destroy() {
    this.agent.destroy();
  }
}

/**
 * Une transaction a-t-elle VRAIMENT été acceptée ?
 *
 * Piège vérifié en direct sur `api.mainnet.minepi.com` : un échec de
 * transaction revient en **HTTP 200**, avec le vrai code (400) planqué dans le
 * champ `status` du corps JSON :
 *
 *   HTTP/1.1 200 OK
 *   { "type": ".../transaction_failed", "status": 400,
 *     "extras": { "result_codes": { "transaction": "tx_no_source_account" } } }
 *
 * Se fier au code HTTP fait donc prendre un échec pour un succès — et arrêter
 * le bot alors que les fonds n'ont pas bougé. On ne conclut au succès que sur
 * la présence d'un `hash` et l'absence de tout marqueur d'erreur.
 */
export function isAccepted(httpStatus, json) {
  if (!json) return false;
  const bodyStatus = Number(json.status);
  if (Number.isFinite(bodyStatus) && bodyStatus >= 400) return false;
  if (typeof json.type === "string" && /horizon-errors|transaction_failed/.test(json.type)) return false;
  if (json.extras?.result_codes) return false;
  if (json.successful === false) return false;
  return httpStatus >= 200 && httpStatus < 300 && Boolean(json.hash);
}

export class EndpointPool {
  /** @param {Endpoint[]} endpoints */
  constructor(endpoints) {
    this.endpoints = endpoints;
    this.warmTimer = null;
  }

  /**
   * Résout toutes les IP derrière le hostname et crée un endpoint par IP.
   * `extraHosts` permet d'ajouter des Horizon alternatifs.
   */
  static async resolve(url, { extraHosts = [] } = {}) {
    const host = new URL(url).hostname;
    const hosts = [host, ...extraHosts];
    const endpoints = [];
    const seen = new Set();

    for (const h of hosts) {
      let addrs = [];
      try {
        addrs = (await dns.resolve4(h)).slice(0, 8);
      } catch {
        try {
          addrs = [(await dns.lookup(h)).address];
        } catch {
          log.warn("Résolution DNS impossible", { host: h });
          continue;
        }
      }
      for (const ip of addrs) {
        if (seen.has(ip)) continue;
        seen.add(ip);
        endpoints.push(new Endpoint(ip, h));
      }
    }

    if (!endpoints.length) throw new Error(`Aucune IP résolue pour ${host}`);
    return new EndpointPool(endpoints);
  }

  /** Endpoints triés du plus rapide au plus lent. */
  get ranked() {
    return [...this.endpoints].sort((a, b) => a.rtt - b.rtt);
  }

  get fastest() {
    return this.ranked[0];
  }

  /**
   * Ouvre `socketsPerEndpoint` connexions vers chaque IP et mesure le RTT.
   * À appeler AVANT la fenêtre critique, puis périodiquement.
   */
  async warm({ socketsPerEndpoint = 2, path = "/fee_stats", quiet = false } = {}) {
    const jobs = this.endpoints.flatMap((ep) =>
      Array.from({ length: socketsPerEndpoint }, () =>
        ep
          .request("GET", path, { timeout: 6_000 })
          .then(({ ms }) => {
            ep.rtt = Math.min(ep.rtt === Infinity ? ms : ep.rtt * 0.7 + ms * 0.3, ms);
            return true;
          })
          .catch(() => false),
      ),
    );
    const results = await Promise.all(jobs);
    const alive = this.endpoints.filter((ep) => ep.rtt !== Infinity);

    if (!quiet) {
      log.table(
        ["endpoint", "rtt", "sockets"],
        this.ranked.map((ep) => [
          ep.rtt === Infinity ? log.paint.red(ep.ip) : ep.ip,
          ep.rtt === Infinity ? "—" : `${ep.rtt.toFixed(0)} ms`,
          String(ep.warmSockets),
        ]),
      );
    }
    if (!alive.length) throw new Error("Aucun endpoint Horizon joignable");
    return { alive: alive.length, total: this.endpoints.length, ok: results.filter(Boolean).length };
  }

  /** Ré-chauffe en tâche de fond pour que les sockets ne meurent jamais. */
  keepWarm(intervalMs = 10_000) {
    this.stopKeepWarm();
    this.warmTimer = setInterval(() => {
      this.warm({ socketsPerEndpoint: 1, quiet: true }).catch(() => {});
    }, intervalMs);
    this.warmTimer.unref();
  }

  stopKeepWarm() {
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.warmTimer = null;
  }

  /**
   * GET en course sur les `fanout` endpoints les plus rapides.
   * Retourne la PREMIÈRE réponse valide — on subit la latence du meilleur,
   * pas celle d'un nœud tiré au sort.
   */
  async raceJson(path, { fanout = 2, timeout = 5_000 } = {}) {
    const targets = this.ranked.slice(0, Math.max(1, fanout));
    return Promise.any(targets.map((ep) => ep.json(path, { timeout })));
  }

  /**
   * Diffuse la transaction signée à TOUS les endpoints en parallèle.
   * Résout dès qu'un Horizon accepte (2xx) ; les autres continuent dans le
   * vide sans qu'on les attende.
   *
   * @param {string} xdr transaction signée, base64
   * @param {(r: object) => void} onResponse appelé pour chaque réponse
   */
  broadcast(xdr, onResponse, { timeout = 45_000 } = {}) {
    const body = `tx=${encodeURIComponent(xdr)}`;
    const started = process.hrtime.bigint();
    let settled = false;

    return new Promise((resolve) => {
      let pending = this.endpoints.length;

      for (const ep of this.ranked) {
        ep.request("POST", "/transactions", { body, timeout })
          .then(({ status, body: raw, ms }) => {
            const result = { ep: ep.ip, status, ms, raw };
            try {
              result.json = JSON.parse(raw);
            } catch {
              /* réponse non-JSON (502 nginx, etc.) */
            }
            result.accepted = isAccepted(status, result.json);
            onResponse?.(result);
            if (!settled && result.accepted) {
              settled = true;
              result.totalMs = Number(process.hrtime.bigint() - started) / 1e6;
              resolve(result);
            }
          })
          .catch((e) => onResponse?.({ ep: ep.ip, status: 0, error: e.message }))
          .finally(() => {
            if (--pending === 0 && !settled) resolve(null);
          });
      }
    });
  }

  destroy() {
    this.stopKeepWarm();
    for (const ep of this.endpoints) ep.destroy();
  }
}
