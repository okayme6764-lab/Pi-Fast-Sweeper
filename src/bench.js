#!/usr/bin/env node
/**
 * Mesure ce que le préchauffage TLS fait réellement gagner, et classe les IP
 * Horizon depuis TA machine.
 *
 * À lancer depuis chaque VPS candidat avant de choisir où héberger le bot :
 * la latence géographique pèse plus lourd que n'importe quelle micro-optimisation
 * du code. Passer de 250 ms à 20 ms de RTT, c'est un gain qu'aucune astuce
 * logicielle ne rattrape.
 */

import { cfg } from "./config.js";
import { log } from "./log.js";
import { EndpointPool, Endpoint } from "./net.js";

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 12);

function stats(samples) {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    min: s[0],
    med: pct(50),
    p95: pct(95),
    max: s[s.length - 1],
    avg: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

const fmt = (v) => (v === undefined ? "—" : `${v.toFixed(0)} ms`);

async function main() {
  log.banner("Benchmark des endpoints Horizon");

  const pool = await EndpointPool.resolve(cfg.horizonUrl, { extraHosts: cfg.extraHosts });
  log.info("Cible", { host: new URL(cfg.horizonUrl).hostname, ips: pool.endpoints.length, tours: ROUNDS });

  // ── À froid : un endpoint neuf par requête, handshake TCP+TLS payé à chaque fois
  log.step("Mesure à FROID (nouveau handshake TLS à chaque requête)…");
  const cold = new Map();
  for (const ep of pool.endpoints) {
    const samples = [];
    for (let i = 0; i < ROUNDS; i++) {
      const fresh = new Endpoint(ep.ip, ep.host, { maxSockets: 1 });
      try {
        const { ms } = await fresh.request("GET", "/fee_stats", { timeout: 8_000 });
        samples.push(ms);
      } catch {
        /* endpoint muet sur ce tour */
      }
      fresh.destroy();
    }
    cold.set(ep.ip, stats(samples));
  }

  // ── À chaud : sockets déjà ouverts et maintenus vivants
  log.step("Mesure à CHAUD (sockets keep-alive pré-ouverts)…");
  await pool.warm({ socketsPerEndpoint: 2, quiet: true });
  const warm = new Map();
  for (const ep of pool.endpoints) {
    const samples = [];
    for (let i = 0; i < ROUNDS; i++) {
      try {
        const { ms } = await ep.request("GET", "/fee_stats", { timeout: 8_000 });
        samples.push(ms);
      } catch {
        /* ignoré */
      }
    }
    warm.set(ep.ip, stats(samples));
  }

  log.banner("Résultats");
  const rows = pool.endpoints
    .map((ep) => ({ ip: ep.ip, c: cold.get(ep.ip), w: warm.get(ep.ip) }))
    .sort((a, b) => (a.w?.med ?? Infinity) - (b.w?.med ?? Infinity));

  log.table(
    ["endpoint", "froid méd.", "chaud méd.", "chaud p95", "gain"],
    rows.map((r) => {
      const gain = r.c && r.w ? r.c.med - r.w.med : undefined;
      return [
        r.ip,
        fmt(r.c?.med),
        r.w ? log.paint.green(fmt(r.w.med)) : log.paint.red("injoignable"),
        fmt(r.w?.p95),
        gain === undefined ? "—" : log.paint.bold(`-${gain.toFixed(0)} ms`),
      ];
    }),
  );

  const reachable = rows.filter((r) => r.w);
  if (reachable.length) {
    const bestWarm = Math.min(...reachable.map((r) => r.w.med));
    const avgCold =
      rows.filter((r) => r.c).reduce((a, r) => a + r.c.med, 0) / Math.max(1, rows.filter((r) => r.c).length);

    log.raw("");
    log.good("Gain du préchauffage + fan-out", {
      avant: `${avgCold.toFixed(0)} ms (IP au hasard, à froid)`,
      apres: `${bestWarm.toFixed(0)} ms (meilleure IP, à chaud)`,
      economie: `~${Math.max(0, avgCold - bestWarm).toFixed(0)} ms par soumission`,
    });
    log.raw(
      `   ${log.paint.dim("Un ledger Pi ferme toutes les ~5 s : gagner ces millisecondes")}\n` +
        `   ${log.paint.dim("décide qui entre dans le ledger courant plutôt que le suivant.")}\n`,
    );
  }

  pool.destroy();
}

main().catch((e) => {
  log.fail("Benchmark impossible", { erreur: e.message });
  process.exit(1);
});
