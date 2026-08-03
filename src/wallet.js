/**
 * Dérivation de la clé et évaluation des claimable balances.
 */

import StellarSdk from "@stellar/stellar-sdk";
import bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";

/**
 * mnémonique 24 mots -> keypair Ed25519.
 *
 * `mnemonicToSeed` fait 2048 tours de PBKDF2-SHA512 : 50 à 150 ms selon la
 * machine. C'est négligeable ici PARCE QU'on le fait une seule fois au
 * démarrage, bien avant la fenêtre critique. Il ne faut surtout jamais le
 * remettre dans la boucle.
 */
export async function deriveKeypair(mnemonic, path) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error("Phrase mnémonique invalide (checksum BIP-39 incorrect)");
  }
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const { key } = derivePath(path, seed);
  return StellarSdk.Keypair.fromRawEd25519Seed(key);
}

/**
 * Évalue un prédicat de claimable balance Horizon à l'instant `nowSec`.
 *
 * Un lock-up Pi typique ressemble à `{"not": {"abs_before": "<déblocage>"}}` :
 * réclamable seulement APRÈS la date. On veut donc savoir, à la milliseconde,
 * quand ça bascule.
 */
export function predicateSatisfied(pred, nowSec) {
  if (!pred || pred.unconditional) return true;
  if (pred.abs_before_epoch !== undefined) return nowSec < Number(pred.abs_before_epoch);
  if (pred.abs_before !== undefined) return nowSec < Date.parse(pred.abs_before) / 1000;
  if (pred.rel_before !== undefined) return true; // relatif à la création : Horizon fournit l'absolu quand il peut
  if (pred.not) return !predicateSatisfied(pred.not, nowSec);
  if (pred.and) return pred.and.every((p) => predicateSatisfied(p, nowSec));
  if (pred.or) return pred.or.some((p) => predicateSatisfied(p, nowSec));
  return false;
}

/** Filtre les claimable balances réclamables MAINTENANT par `publicKey`. */
export function claimableNow(records, publicKey, nowSec = Date.now() / 1000) {
  const ready = [];
  const pending = [];
  for (const cb of records ?? []) {
    const mine = cb.claimants?.find((c) => c.destination === publicKey);
    if (!mine) continue;
    (predicateSatisfied(mine.predicate, nowSec) ? ready : pending).push({
      id: cb.id,
      amount: cb.amount,
      predicate: mine.predicate,
      unlockAt: unlockTime(mine.predicate),
    });
  }
  return { ready, pending };
}

/** Extrait la date de déblocage d'un prédicat `not(abs_before)`, si présente. */
function unlockTime(pred) {
  if (pred?.not?.abs_before) return pred.not.abs_before;
  if (pred?.not?.abs_before_epoch)
    return new Date(Number(pred.not.abs_before_epoch) * 1000).toISOString();
  if (pred?.and) {
    for (const p of pred.and) {
      const t = unlockTime(p);
      if (t) return t;
    }
  }
  return null;
}
