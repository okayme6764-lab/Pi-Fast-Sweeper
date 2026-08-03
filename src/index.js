#!/usr/bin/env node
/**
 * Pi Fast Sweeper — extraction de Pi vers une adresse externe, optimisée pour
 * la latence de bout en bout.
 *
 * Chaîne critique, du déclenchement à l'inclusion dans un ledger :
 *
 *   [déclencheur] -> [calcul du montant] -> [build+sign] -> [POST] -> [ledger]
 *        ~0 ms            ~0 ms              ~1-2 ms       ~1 RTT     ~5 s
 *
 * Tout ce qui pouvait sortir de cette chaîne en a été sorti : dérivation de
 * clé, résolution DNS, handshakes TLS, lecture des frais de base, lecture de
 * la réserve, numéro de séquence. Il ne reste qu'un aller-retour réseau.
 *
 * Le script d'origine faisait, à CHAQUE tour de boucle : loadAccount() +
 * fetchBaseFee() (2 allers-retours à froid), puis build, puis sign, puis
 * submit — le tout derrière un `setInterval` de 750 ms. Soit, en moyenne,
 * ~375 ms d'attente + 2 à 3 RTT évitables avant que le premier octet de la
 * transaction ne parte.
 */

import StellarSdk from "@stellar/stellar-sdk";
import { cfg, validate } from "./config.js";
import { log, mask } from "./log.js";
import { EndpointPool } from "./net.js";
import { deriveKeypair, claimableNow } from "./wallet.js";
import { computeFeeBid } from "./fee.js";
import { fromStroops, toStroops, nativeBalanceStroops, minBalanceStroops } from "./stroops.js";

const NATIVE = StellarSdk.Asset.native();

/** État partagé. */
const S = {
  pool: null,
  keypair: null,
  publicKey: null,
  baseReserve: 4_900_000n, // 0,49 Pi sur Pi mainnet — écrasé au démarrage
  baseFee: 100_000n,
  account: null,
  claimables: { ready: [], pending: [] },
  sending: false,
  lastFireAt: 0,
  done: false,
  fires: 0,
  // compteurs affichés dans le point de situation
  startedAt: Date.now(),
  polls: 0,
  pollErrors: 0,
  sseEvents: 0,
  lastBalance: null,
};

const REFIRE_COOLDOWN_MS = 900;

// ─────────────────────────────────────────────────────────────────────────────
// Lecture de l'état réseau / du compte
// ─────────────────────────────────────────────────────────────────────────────

async function loadNetworkParams() {
  const res = await S.pool.raceJson("/ledgers?order=desc&limit=1", { fanout: 2 });
  const ledger = res._embedded?.records?.[0];
  if (!ledger) throw new Error("Impossible de lire le dernier ledger");
  S.baseReserve = BigInt(ledger.base_reserve_in_stroops);
  S.baseFee = BigInt(ledger.base_fee_in_stroops);
  return ledger;
}

async function loadAccount() {
  try {
    S.account = await S.pool.raceJson(`/accounts/${S.publicKey}`, { fanout: cfg.pollFanout });
    return S.account;
  } catch (e) {
    const err = e instanceof AggregateError ? e.errors[0] : e;
    if (err?.status === 404) {
      throw new Error(
        `Le compte ${S.publicKey} n'existe pas sur ce réseau (jamais approvisionné, ` +
          `ou mauvais chemin de dérivation / mauvais Horizon).`,
      );
    }
    throw err;
  }
}

async function loadClaimables() {
  if (!cfg.claimBalances) return S.claimables;
  try {
    const res = await S.pool.raceJson(
      `/claimable_balances?claimant=${S.publicKey}&limit=100`,
      { fanout: 1 },
    );
    S.claimables = claimableNow(res._embedded?.records, S.publicKey);
  } catch {
    /* endpoint indisponible : on continue sans, le solde natif reste envoyable */
  }
  return S.claimables;
}

// ─────────────────────────────────────────────────────────────────────────────
// Calcul du montant
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Montant envoyable, en stroops, tout compris.
 *
 *   envoyable = solde + claimables mûrs − réserve protocolaire − frais − marge
 *
 * Les frais sont comptés à l'ENCHÈRE MAXIMALE (et non au frais de base) :
 * on n'est facturé que le minimum nécessaire, mais si on ne réserve que le
 * minimum et que le réseau sature, la transaction devient sous-financée au
 * pire moment possible.
 */
function computePlan() {
  const balance = nativeBalanceStroops(S.account);
  const ready = S.claimables.ready;
  const claimTotal = ready.reduce((a, cb) => a + toStroops(cb.amount), 0n);
  const opCount = ready.length + 1;
  const minBalance = minBalanceStroops(S.account, S.baseReserve);
  const safety = toStroops(cfg.safetyBufferPi);

  // Récupérable AVANT frais : c'est l'assiette sur laquelle on mise.
  const available = balance + claimTotal - minBalance - safety;

  const bid = computeFeeBid({
    mode: cfg.feeMode,
    fixedPerOp: cfg.maxFeeStroops,
    pct: cfg.feeBidPct,
    available,
    opCount,
    baseFee: S.baseFee,
  });

  const amount = available - bid.total;

  return {
    balance,
    claimTotal,
    claimCount: ready.length,
    opCount,
    feePerOp: bid.perOp,
    feeTotal: bid.total,
    feeCapped: bid.capped,
    minBalance,
    safety,
    available,
    amount,
    sendable: amount >= toStroops(cfg.minSendPi) && amount > 0n,
  };
}

/**
 * Pourquoi rien ne part, en français. Un « 0.0000000 envoyable » sans
 * explication laisse l'utilisateur croire à un bug, alors que c'est presque
 * toujours une raison parfaitement normale.
 */
function whyNotSendable(plan) {
  const total = plan.balance + plan.claimTotal;
  if (total === 0n) {
    return {
      raison: "Le compte est totalement vide.",
      detail: "Aucun Pi dessus, et aucune claimable balance arrivée à échéance.",
    };
  }
  if (plan.available <= 0n) {
    return {
      raison: "Tout le solde est immobilisé par la réserve du protocole.",
      detail:
        `Le réseau exige que ${fromStroops(plan.minBalance)} Pi restent en permanence ` +
        `sur le compte pour qu'il continue d'exister — c'est une règle du protocole, ` +
        `ces Pi ne sont envoyables par personne, ni par toi ni par un autre bot. ` +
        `Solde ${fromStroops(plan.balance)} Pi − réserve ${fromStroops(plan.minBalance)} Pi = rien de disponible.`,
    };
  }
  if (plan.amount <= 0n) {
    return {
      raison: "L'enchère de frais dépasse ce qu'il reste à envoyer.",
      detail:
        `Disponible ${fromStroops(plan.available)} Pi, mais l'enchère réserve ` +
        `${fromStroops(plan.feeTotal)} Pi. Baisse PI_MAX_FEE_STROOPS ou PI_FEE_BID_PCT.`,
    };
  }
  return {
    raison: "Le montant est sous le seuil minimum d'envoi.",
    detail: `${fromStroops(plan.amount)} Pi à envoyer, seuil fixé à ${cfg.minSendPi} Pi (PI_MIN_SEND_PI).`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction / signature / diffusion
// ─────────────────────────────────────────────────────────────────────────────

function buildSigned(plan) {
  const account = new StellarSdk.Account(S.publicKey, S.account.sequence);
  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: plan.feePerOp.toString(), // par opération : le SDK multiplie par le nombre d'ops
    networkPassphrase: cfg.networkPassphrase,
    withMuxedAccounts: true,
  });

  for (const cb of S.claimables.ready) {
    builder.addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: cb.id }));
  }

  builder.addOperation(
    StellarSdk.Operation.payment({
      destination: cfg.destination,
      asset: NATIVE,
      amount: fromStroops(plan.amount),
    }),
  );

  if (cfg.memo) {
    builder.addMemo(
      /^\d+$/.test(cfg.memo) ? StellarSdk.Memo.id(cfg.memo) : StellarSdk.Memo.text(cfg.memo),
    );
  }

  const tx = builder.setTimeout(cfg.txTimeoutSec).build();
  tx.sign(S.keypair);
  return tx;
}

const CODE_HELP = {
  tx_bad_seq: "numéro de séquence périmé — le compte a bougé, on recharge",
  tx_insufficient_balance: "solde insuffisant pour couvrir l'enchère de frais",
  tx_bad_auth: "signature refusée — mauvaise clé ou signataires multiples requis",
  tx_too_early: "fenêtre de validité pas encore ouverte",
  tx_too_late: "transaction expirée — à reconstruire",
  tx_insufficient_fee: "enchère trop basse pendant une saturation — augmente PI_MAX_FEE_STROOPS",
  op_underfunded: "montant supérieur au disponible (réserve/frais mal comptés, ou solde verrouillé)",
  op_no_destination: "le compte de destination n'existe pas sur ce réseau",
  op_line_full: "le compte de destination ne peut pas recevoir davantage",
  op_does_not_exist: "claimable balance déjà réclamée ou inexistante",
  op_not_authorized: "claimable balance pas encore arrivée à échéance",
};

function explain(result) {
  const extras = result.json?.extras;
  const codes = extras?.result_codes;
  if (!codes) return null;
  const flat = [codes.transaction, ...(codes.operations ?? [])].filter(Boolean);
  const hints = flat.map((c) => CODE_HELP[c]).filter(Boolean);
  return { codes: flat, hints, envelope: extras.envelope_xdr, resultXdr: extras.result_xdr };
}

/**
 * Le chemin chaud. Aucun appel réseau préalable, aucune écriture bloquante
 * sur stdout : on construit, on signe, on diffuse.
 */
async function fire(reason) {
  if (S.done || S.sending) return;
  if (Date.now() - S.lastFireAt < REFIRE_COOLDOWN_MS) return;

  const plan = computePlan();
  if (!plan.sendable) return;

  S.sending = true;
  S.lastFireAt = Date.now();
  S.fires++;

  log.hot(); // ── à partir d'ici, plus une seule écriture synchrone ──
  const tBuild = process.hrtime.bigint();
  let tx;
  try {
    tx = buildSigned(plan);
  } catch (e) {
    log.flush();
    log.fail("Construction de la transaction impossible", { erreur: e.message });
    S.sending = false;
    return;
  }
  const buildMs = Number(process.hrtime.bigint() - tBuild) / 1e6;
  const xdr = tx.toXDR();

  log.fire(`Tir #${S.fires} — ${reason}`, {
    montant: `${fromStroops(plan.amount)} Pi`,
    claims: plan.claimCount || undefined,
    ops: tx.operations.length,
    frais_max: `${fromStroops(plan.feeTotal)} Pi`,
    seq: S.account.sequence,
    build: `${buildMs.toFixed(2)}ms`,
    hash: tx.hash().toString("hex").slice(0, 16),
  });

  if (cfg.dryRun) {
    log.flush();
    log.warn("DRY RUN — rien n'a été envoyé au réseau");
    log.raw(`   ${log.paint.dim("XDR signé :")} ${xdr}`);
    S.sending = false;
    S.done = !cfg.watch;
    return;
  }

  const responses = [];
  const winner = await S.pool.broadcast(xdr, (r) => responses.push(r));

  log.flush(); // ── fin du chemin chaud, on vide le tampon ──

  log.table(
    ["endpoint", "statut", "latence"],
    S.pool.ranked.map((ep) => {
      const r = responses.find((x) => x.ep === ep.ip);
      if (!r) return [ep.ip, log.paint.grey("en vol"), "—"];
      // Attention : le code HTTP ment (cf. isAccepted dans net.js).
      const code = r.json?.status ?? r.status;
      return [
        ep.ip,
        r.accepted
          ? log.paint.green("accepté")
          : log.paint.red(r.error ?? `rejeté (${code})`),
        r.ms ? `${r.ms.toFixed(0)} ms` : "—",
      ];
    }),
  );

  if (winner) {
    const h = winner.json?.hash ?? tx.hash().toString("hex");
    log.good("Transaction incluse dans un ledger", {
      hash: h,
      ledger: winner.json?.ledger,
      gagnant: winner.ep,
      total: `${winner.totalMs.toFixed(0)}ms`,
    });
    log.raw(`   ${log.paint.dim("Explorateur :")} https://api.mainnet.minepi.com/transactions/${h}`);
    S.done = !cfg.watch;
    if (cfg.watch) await refreshState();
  } else {
    const first = responses.find((r) => r.json?.extras) ?? responses[0];
    const detail = first ? explain(first) : null;
    log.fail("Aucun endpoint n'a accepté la transaction", {
      statut: first?.json?.status ?? first?.status,
      detail: first?.json?.detail ?? first?.error,
    });
    if (detail) {
      log.raw(`   ${log.paint.dim("codes    :")} ${detail.codes.join(", ")}`);
      for (const h of detail.hints) log.raw(`   ${log.paint.yellow("→")} ${h}`);
      if (detail.resultXdr) log.raw(`   ${log.paint.dim("resultXdr:")} ${detail.resultXdr}`);
    }
    // séquence périmée ou claimable consommée : on resynchronise avant de réessayer
    if (detail?.codes.some((c) => c === "tx_bad_seq" || c === "op_does_not_exist")) {
      await refreshState();
    }
  }

  S.sending = false;
  if (S.done) shutdown(0);
}

async function refreshState() {
  await Promise.all([loadAccount(), loadClaimables()]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Déclencheurs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 1. Sondage serré du compte. Le rate-limit mesuré sur Horizon Pi est
 *    d'environ 100 requêtes/seconde ; à 150 ms on est deux ordres de grandeur
 *    en dessous, tout en réagissant 5× plus vite que les 750 ms d'origine.
 */
function armPolling() {
  const tick = async () => {
    if (S.done) return;
    try {
      await loadAccount();
      S.polls++;
      // On signale un mouvement de solde même s'il n'y a pas de quoi envoyer :
      // c'est le signe visible que le compte bouge (ou qu'un autre bot l'a vidé).
      const bal = nativeBalanceStroops(S.account);
      if (S.lastBalance !== null && bal !== S.lastBalance) {
        const delta = bal - S.lastBalance;
        log[delta > 0n ? "good" : "warn"](
          delta > 0n ? "Le solde a AUGMENTÉ" : "Le solde a BAISSÉ",
          {
            variation: `${delta > 0n ? "+" : ""}${fromStroops(delta)} Pi`,
            nouveau_solde: `${fromStroops(bal)} Pi`,
          },
        );
      }
      S.lastBalance = bal;
      if (computePlan().sendable) await fire("sondage");
    } catch {
      S.pollErrors++;
      /* un tour raté n'a aucune importance, le suivant arrive dans 150 ms */
    }
  };
  const t = setInterval(tick, cfg.pollMs);
  t.unref?.();
  return () => clearInterval(t);
}

/**
 * 2. Flux SSE des effets du compte. Notification quasi instantanée d'un
 *    paiement entrant ou de la libération d'un lock-up, sans attendre le
 *    prochain tour de sondage.
 */
function armStream() {
  const ep = S.pool.fastest;
  return ep.stream(
    `/accounts/${S.publicKey}/effects?cursor=now`,
    async (effect) => {
      if (S.done) return;
      S.sseEvents++;
      log.step("Événement reçu en direct sur le compte", {
        type: effect.type,
        montant: effect.amount ? `${effect.amount} Pi` : undefined,
      });
      try {
        await refreshState();
        await fire(`événement:${effect.type}`);
      } catch {
        /* ignoré : le sondage prendra le relais */
      }
    },
    (e) => log.warn("Flux SSE interrompu, sondage seul actif", { erreur: e.message }),
  );
}

/**
 * 3. Battement de ledger. Horizon ferme un ledger toutes les ~5 s ; on
 *    réessaie exactement une fois par ledger tant qu'il reste à envoyer,
 *    plutôt qu'au petit bonheur.
 */
function armLedgerHeartbeat() {
  const ep = S.pool.ranked[1] ?? S.pool.fastest;
  return ep.stream(
    "/ledgers?order=desc&limit=1&cursor=now",
    async () => {
      if (S.done || S.sending) return;
      try {
        await refreshState();
        if (computePlan().sendable) await fire("battement de ledger");
      } catch {
        /* ignoré */
      }
    },
    () => {},
  );
}

/**
 * 4. Minuteries de déblocage. C'est le déclencheur le plus important pour un
 *    lock-up : quand une claimable balance arrive à échéance, AUCUN événement
 *    n'est émis sur la chaîne — le prédicat devient simplement vrai. Ni le SSE
 *    ni un événement de compte ne préviendront. Seule une minuterie calée sur
 *    la date d'échéance permet de tirer à la seconde près.
 */
function armUnlockTimers() {
  const timers = [];
  for (const cb of S.claimables.pending) {
    if (!cb.unlockAt) continue;
    const delay = Date.parse(cb.unlockAt) - Date.now();
    if (delay < 0 || delay > 2 ** 31 - 1) continue;

    // On démarre une rafale 2 s avant l'échéance : la transaction est alors
    // déjà en file quand le prédicat bascule, au lieu d'attendre le ledger
    // suivant.
    const lead = Math.max(0, delay - 2_000);
    const t = setTimeout(() => {
      log.step("Échéance de déblocage atteinte", {
        montant: `${cb.amount} Pi`,
        echeance: cb.unlockAt,
      });
      const burst = setInterval(async () => {
        if (S.done) return clearInterval(burst);
        try {
          await refreshState();
          if (computePlan().sendable) await fire("déblocage programmé");
        } catch {
          /* ignoré */
        }
      }, 400);
      burst.unref?.();
      setTimeout(() => clearInterval(burst), 120_000).unref?.();
    }, lead);
    t.unref?.();
    timers.push(t);

    log.info("Déblocage programmé", {
      montant: `${cb.amount} Pi`,
      dans: humanDelay(delay),
      echeance: cb.unlockAt,
    });
  }
  return () => timers.forEach(clearTimeout);
}

/**
 * 5. Point de situation périodique.
 *
 * Sans ça, la console reste totalement muette après l'armement : impossible de
 * savoir si le bot surveille vraiment ou s'il est mort dix minutes plus tôt.
 */
function armHeartbeat() {
  if (cfg.heartbeatSec <= 0) return () => {};
  const t = setInterval(() => {
    if (S.done || S.sending) return;
    const next = S.claimables.pending
      .filter((cb) => cb.unlockAt)
      .map((cb) => Date.parse(cb.unlockAt) - Date.now())
      .filter((d) => d > 0)
      .sort((a, b) => a - b)[0];

    log.trace("En veille — tout va bien", {
      depuis: humanDelay(Date.now() - S.startedAt),
      solde: `${fromStroops(S.lastBalance ?? 0n)} Pi`,
      sondages: S.polls,
      erreurs: S.pollErrors || undefined,
      evenements: S.sseEvents || undefined,
      sockets_chauds: S.pool.endpoints.reduce((n, ep) => n + ep.warmSockets, 0),
      meilleur_rtt: `${S.pool.fastest.rtt.toFixed(0)}ms`,
      prochain_deblocage: next ? `dans ${humanDelay(next)}` : undefined,
    });
  }, cfg.heartbeatSec * 1000);
  t.unref?.();
  return () => clearInterval(t);
}

function humanDelay(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)}j`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────────────────────────────────────

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  S.done = true;
  S.pool?.destroy();
  setImmediate(() => process.exit(code));
}

async function main() {
  log.banner("Pi Fast Sweeper");

  const errors = validate();
  if (errors.length) {
    for (const e of errors) log.fail(e);
    log.raw(`\n   Copie ${log.paint.bold(".env.example")} vers ${log.paint.bold(".env")} et remplis-le.\n`);
    process.exit(1);
  }

  // ── Phase 1 : tout ce qui est cher, fait UNE fois, hors chemin critique ──
  log.banner("Préchauffage");

  const tDerive = process.hrtime.bigint();
  S.keypair = await deriveKeypair(cfg.mnemonic, cfg.derivationPath);
  S.publicKey = S.keypair.publicKey();
  log.good("Clé dérivée", {
    chemin: cfg.derivationPath,
    publique: S.publicKey,
    privee: cfg.revealSecret ? S.keypair.secret() : mask(S.keypair.secret()),
    ms: (Number(process.hrtime.bigint() - tDerive) / 1e6).toFixed(0),
  });

  S.pool = await EndpointPool.resolve(cfg.horizonUrl, { extraHosts: cfg.extraHosts });
  log.step(`${S.pool.endpoints.length} serveurs Horizon trouvés derrière ce nom de domaine`);
  log.raw(
    `   ${log.paint.dim("Ouverture des connexions TLS maintenant, pour ne plus les payer au moment d'envoyer.")}\n` +
      `   ${log.paint.dim("Une connexion neuve coûte ~600 ms (DNS + poignée de main TCP + TLS) avant le 1er octet utile.")}`,
  );
  await S.pool.warm({ socketsPerEndpoint: cfg.socketsPerEndpoint });
  log.good("Connexions ouvertes et maintenues chaudes", {
    serveurs: S.pool.endpoints.length,
    meilleur: `${S.pool.fastest.ip} à ${S.pool.fastest.rtt.toFixed(0)}ms`,
    rechauffage: `toutes les ${cfg.keepWarmMs / 1000}s`,
  });
  S.pool.keepWarm(cfg.keepWarmMs);

  const ledger = await loadNetworkParams();
  log.good("Paramètres du réseau lus une fois pour toutes", {
    ledger: ledger.sequence,
    protocole: ledger.protocol_version,
    frais_base: `${fromStroops(S.baseFee)} Pi`,
    reserve_base: `${fromStroops(S.baseReserve)} Pi`,
  });
  log.raw(
    `   ${log.paint.dim("Lus ici, ils ne seront plus redemandés au réseau : c'est autant d'allers-retours en moins au moment critique.")}`,
  );

  // ── Phase 2 : état du compte ──
  log.banner("État du compte");
  await refreshState();

  const plan = computePlan();
  log.table(
    ["poste", "montant (Pi)"],
    [
      ["solde disponible", fromStroops(plan.balance)],
      ["claimables mûrs", `${fromStroops(plan.claimTotal)}  (${plan.claimCount})`],
      ["− réserve protocolaire", `-${fromStroops(plan.minBalance)}`],
      [
        `− enchère de frais [${cfg.feeMode}]`,
        `-${fromStroops(plan.feeTotal)}  (${fromStroops(plan.feePerOp)} × ${plan.opCount} op)`,
      ],
      ["− marge de sécurité", `-${fromStroops(plan.safety)}`],
      [
        log.paint.bold("= envoyable"),
        log.paint.bold(plan.amount > 0n ? fromStroops(plan.amount) : "0.0000000"),
      ],
    ],
  );
  log.raw(
    `   ${log.paint.dim(`La réserve de ${fromStroops(plan.minBalance)} Pi est imposée par le protocole : elle doit rester`)}\n` +
      `   ${log.paint.dim("sur le compte pour qu'il continue d'exister. Personne ne peut l'envoyer, jamais.")}`,
  );
  if (plan.feeCapped) log.info("Enchère bornée", { raison: plan.feeCapped });

  log.info("Destination des fonds", {
    adresse: cfg.destination,
    type: cfg.destination.startsWith("M")
      ? "muxed — l'identifiant de dépôt est encodé dans l'adresse, pas de memo à fournir"
      : "classique",
    memo: cfg.memo || undefined,
  });
  if (!cfg.destination.startsWith("M") && !cfg.memo) {
    log.warn("Adresse G… sans memo", {
      risque: "si c'est un exchange, le dépôt risque de ne pas être crédité sur ton compte",
    });
  }

  // ── Configuration active, expliquée ──
  log.banner("Réglages actifs");
  log.table(
    ["réglage", "valeur", "ce que ça veut dire"],
    [
      [
        "enchère de frais",
        cfg.feeMode === "max" ? `max ${cfg.feeBidPct}%` : `fixe ${fromStroops(cfg.maxFeeStroops)} Pi/op`,
        cfg.feeMode === "max"
          ? `recalculée à chaque tir sur ${cfg.feeBidPct}% du récupérable`
          : "mise identique quel que soit le solde",
      ],
      [
        "après un envoi",
        cfg.watch ? "continue" : "s'arrête",
        cfg.watch
          ? "surveille encore : tout ce qui arrivera ensuite repartira aussi"
          : "quitte après le premier envoi réussi",
      ],
      [
        "claimable balances",
        cfg.claimBalances ? "réclamées" : "ignorées",
        cfg.claimBalances
          ? "réclamées dans la MÊME transaction que l'envoi (un ledger économisé)"
          : "seul le solde libre sera envoyé",
      ],
      [
        "mode",
        cfg.dryRun ? log.paint.yellow("DRY RUN") : log.paint.green("RÉEL"),
        cfg.dryRun ? "construit et signe, mais n'envoie RIEN au réseau" : "les envois partent pour de vrai",
      ],
    ],
  );

  // ── Phase 3 : armement ──
  log.banner(cfg.dryRun ? "En surveillance (DRY RUN)" : "En surveillance");

  if (plan.sendable) {
    log.step("Il y a déjà de quoi envoyer — tir immédiat");
    await fire("solde déjà disponible au démarrage");
    if (S.done) return;
  } else {
    const why = whyNotSendable(plan);
    log.info(`Rien à envoyer pour l'instant. ${why.raison}`);
    log.raw(`   ${log.paint.dim(why.detail)}`);
  }

  armPolling();
  armStream();
  armLedgerHeartbeat();
  armUnlockTimers();
  armHeartbeat();

  log.good("Quatre déclencheurs armés en parallèle (volontairement redondants)");
  log.table(
    ["déclencheur", "cadence", "rôle"],
    [
      ["sondage du compte", `${cfg.pollMs} ms`, `interroge les ${cfg.pollFanout} serveurs les plus rapides, le 1er qui répond gagne`],
      ["flux d'événements", "temps réel", "prévient dès qu'un Pi arrive sur le compte"],
      ["battement de ledger", "~5 s", "réessaie une fois par ledger si un envoi a échoué"],
      [
        "minuteries de déblocage",
        S.claimables.pending.length ? `${S.claimables.pending.length} programmée(s)` : "aucune",
        "tire 2 s avant l'échéance d'un verrou — aucun événement n'est émis à ce moment-là",
      ],
    ],
  );
  log.raw(
    `   ${log.paint.dim("Si le flux tombe, le sondage prend le relais ; si le sondage rate un tour, le ledger rattrape.")}`,
  );
  log.raw(
    `\n   ${log.paint.bold("Le bot tourne.")} ${log.paint.dim(`Point de situation toutes les ${cfg.heartbeatSec}s. Ctrl+C pour arrêter.`)}\n`,
  );
}

process.on("SIGINT", () => {
  log.flush();
  log.warn("Arrêt demandé (Ctrl+C)");
  log.info("Résumé de la session", {
    duree: humanDelay(Date.now() - S.startedAt),
    sondages: S.polls,
    evenements: S.sseEvents,
    tirs: S.fires,
    erreurs_reseau: S.pollErrors,
  });
  shutdown(0);
});

main().catch((e) => {
  log.flush();
  log.fail("Erreur fatale", { erreur: e.message });
  if (process.env.PI_DEBUG) log.raw(e.stack);
  shutdown(1);
});
