/**
 * Configuration. Tout se pilote par variables d'environnement (fichier `.env`),
 * pour que la phrase mnémonique ne finisse plus jamais dans un commit git.
 */

import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");

if (existsSync(ENV_FILE) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    /* .env malformé : on continue avec l'environnement du process */
  }
}

/** Les flags CLI l'emportent sur le `.env` : `node src/index.js --dry-run --watch`. */
const FLAGS = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));

const str = (k, d) => process.env[k] ?? d;
const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
const bool = (k, d, flag) =>
  FLAGS.has(flag) ? true : process.env[k] ? /^(1|true|yes|on)$/i.test(process.env[k]) : d;

export const cfg = {
  /** Phrase BIP-39 de 24 mots du wallet source. */
  mnemonic: str("PI_MNEMONIC", "").trim(),
  /** Chemin de dérivation. `m/44'/314159'/0'` = compte Pi standard. */
  derivationPath: str("PI_DERIVATION_PATH", "m/44'/314159'/0'"),
  /** Adresse de destination : G… ou M… (muxed, memo intégré). */
  destination: str("PI_DESTINATION", "").trim(),
  /** Memo optionnel, si l'exchange en exige un et que la destination est en G…. */
  memo: str("PI_MEMO", "").trim(),

  horizonUrl: str("PI_HORIZON_URL", "https://api.mainnet.minepi.com"),
  networkPassphrase: str("PI_NETWORK_PASSPHRASE", "Pi Network"),
  /** Horizon alternatifs, séparés par des virgules (élargit le fan-out). */
  extraHosts: str("PI_EXTRA_HOSTS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Enchère de frais PAR OPÉRATION, en stroops. Le frais de base sur Pi est
   * 100 000 stroops (0,01 Pi). Sur Stellar-like, ce chiffre est un MAXIMUM :
   * on n'est facturé que le minimum nécessaire pour entrer dans le ledger.
   * Surenchérir ne coûte donc rien en temps normal, et fait passer devant
   * quand le réseau sature (les transactions sont ordonnées par enchère).
   */
  maxFeeStroops: BigInt(str("PI_MAX_FEE_STROOPS", "2000000")), // 0,2 Pi

  /**
   * `fixed` : mise toujours PI_MAX_FEE_STROOPS par opération.
   * `max`   : mise le plus haut que le compte peut porter, soit PI_FEE_BID_PCT
   *           pour cent du montant récupérable, borné par le plafond uint32 du
   *           protocole. À privilégier quand on court contre un autre bot.
   */
  feeMode: /^max$/i.test(str("PI_FEE_MODE", "fixed")) ? "max" : "fixed",
  /** Part du récupérable misable en frais, en pourcent (mode `max`). */
  feeBidPct: Math.min(90, Math.max(0, num("PI_FEE_BID_PCT", 5))),

  /** Intervalle du sondage de secours, en ms. Le déclencheur principal est le SSE. */
  pollMs: num("PI_POLL_MS", 150),
  /** Nombre d'endpoints interrogés en parallèle à chaque sondage. */
  pollFanout: num("PI_POLL_FANOUT", 2),
  /** Sockets pré-ouverts par endpoint. */
  socketsPerEndpoint: num("PI_SOCKETS_PER_ENDPOINT", 2),
  /** Période de ré-chauffage des sockets, en ms. */
  keepWarmMs: num("PI_KEEP_WARM_MS", 10_000),

  /** Période du point de situation pendant l'attente, en secondes. 0 = silencieux. */
  heartbeatSec: num("PI_HEARTBEAT_SEC", 30),

  /** Ne pas envoyer si le montant est sous ce seuil (en Pi). Évite de brûler des frais. */
  minSendPi: str("PI_MIN_SEND_PI", "0.0000001"),
  /** Marge de sécurité laissée en plus de la réserve protocolaire (en Pi). */
  safetyBufferPi: str("PI_SAFETY_BUFFER_PI", "0"),
  /** Fenêtre de validité de la transaction, en secondes. */
  txTimeoutSec: num("PI_TX_TIMEOUT_SEC", 300),

  /** Réclamer automatiquement les claimable balances arrivées à échéance. */
  claimBalances: bool("PI_CLAIM_BALANCES", true),
  /** Ne pas s'arrêter après un envoi réussi (utile pour des déblocages en vagues). */
  watch: bool("PI_WATCH", false, "--watch"),
  /** Tout faire SAUF envoyer. Construit et signe, puis affiche le XDR. */
  dryRun: bool("PI_DRY_RUN", false, "--dry-run"),
  /** Afficher la clé privée en clair (déconseillé). */
  revealSecret: bool("PI_REVEAL_SECRET", false, "--reveal-secret"),
};

export function validate() {
  const errors = [];
  if (!cfg.mnemonic) errors.push("PI_MNEMONIC est vide — renseigne-la dans .env");
  else if (cfg.mnemonic.split(/\s+/).length !== 24)
    errors.push(`PI_MNEMONIC doit faire 24 mots (${cfg.mnemonic.split(/\s+/).length} trouvés)`);
  if (!cfg.destination) errors.push("PI_DESTINATION est vide — renseigne-la dans .env");
  else if (!/^[GM][A-Z2-7]{55,}$/.test(cfg.destination))
    errors.push(`PI_DESTINATION invalide : ${cfg.destination}`);
  if (cfg.memo && cfg.destination.startsWith("M"))
    errors.push("PI_MEMO et une adresse M… sont redondants — l'adresse muxed porte déjà l'identifiant");
  return errors;
}
