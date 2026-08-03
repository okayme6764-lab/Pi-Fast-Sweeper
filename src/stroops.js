/**
 * Arithmétique exacte en stroops (1 Pi = 10 000 000 stroops).
 *
 * Le script d'origine faisait `parseFloat(balance) - fee - reserve` puis
 * `.toFixed(7)`. En binaire IEEE-754, `toFixed` arrondit — et un seul stroop
 * de trop fait rejeter la transaction avec `op_underfunded`. On perd alors un
 * aller-retour complet (≈ 5 s, soit un ledger entier) pour rien.
 *
 * Ici tout passe par des BigInt : aucune perte de précision possible.
 */

export const STROOPS_PER_PI = 10_000_000n;

/** "16632371.5933626" -> 166323715933626n */
export function toStroops(decimal) {
  const s = String(decimal).trim();
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [whole = "0", frac = ""] = body.split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) {
    throw new TypeError(`Montant décimal invalide : ${decimal}`);
  }
  const v = BigInt(whole || "0") * STROOPS_PER_PI + BigInt((frac + "0000000").slice(0, 7));
  return neg ? -v : v;
}

/** 166323715933626n -> "16632371.5933626" (7 décimales, format Stellar) */
export function fromStroops(stroops) {
  const v = BigInt(stroops);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / STROOPS_PER_PI;
  const frac = (abs % STROOPS_PER_PI).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Solde natif d'un compte Horizon, en stroops. */
export function nativeBalanceStroops(account) {
  const native = account.balances?.find((b) => b.asset_type === "native");
  return native ? toStroops(native.balance) : 0n;
}

/**
 * Solde minimum immobilisé par le protocole, en stroops.
 *
 * minBalance = (2 + subentries + sponsoring − sponsored) × base_reserve
 *
 * Sur Pi, `base_reserve` vaut 0,49 Pi (et non 0,5 comme sur Stellar), donc un
 * compte nu immobilise 0,98 Pi. Le script d'origine codait 1,0 Pi en dur :
 * trop haut pour un compte nu (0,02 Pi laissés derrière) et surtout trop BAS
 * dès qu'il existe la moindre sous-entrée — auquel cas la transaction échoue.
 */
export function minBalanceStroops(account, baseReserveStroops) {
  const entries =
    2 +
    (account.subentry_count ?? 0) +
    (account.num_sponsoring ?? 0) -
    (account.num_sponsored ?? 0);
  return BigInt(Math.max(2, entries)) * BigInt(baseReserveStroops);
}
