/**
 * Calcul de l'enchère de frais.
 *
 * Deux plafonds, très différents :
 *
 * 1. LE PLAFOND DU PROTOCOLE. Le champ `fee` de l'enveloppe de transaction est
 *    un uint32. Le total pour UNE transaction ne peut donc pas dépasser
 *    4 294 967 295 stroops, soit 429,4967295 Pi. Au-delà, ce n'est pas le
 *    réseau qui refuse : c'est l'encodage XDR qui devient impossible.
 *    Comme le SDK multiplie l'enchère par le nombre d'opérations, le plafond
 *    PAR OPÉRATION vaut ce total divisé par le nombre d'ops.
 *
 * 2. LE PLAFOND ÉCONOMIQUE, bien plus bas. Chaque stroop misé est un stroop
 *    retiré du montant envoyable — sinon la transaction devient sous-financée.
 *    Or on n'est facturé que le prix de clôture du ledger, PAS son enchère.
 *    Miser énorme ne coûte donc presque rien en frais réels… mais laisse la
 *    différence derrière soi, dans un compte compromis. Sur une récupération
 *    face à un bot qui draine, ce reliquat lui est offert.
 *
 * D'où le mode `max` : on mise le maximum que le compte peut porter dans la
 * limite d'un pourcentage du montant récupérable, au lieu d'un nombre fixe
 * choisi au hasard.
 */

/** Le champ `fee` de l'enveloppe est un uint32 : total maximal pour une transaction. */
export const PROTOCOL_MAX_FEE_TOTAL = 4_294_967_295n;

/**
 * @param {object} p
 * @param {"fixed"|"max"} p.mode        stratégie
 * @param {bigint} p.fixedPerOp         enchère par op en mode `fixed`
 * @param {number} p.pct                part du récupérable misable en mode `max`
 * @param {bigint} p.available          récupérable AVANT frais (solde + claims − réserve − marge)
 * @param {number} p.opCount            nombre d'opérations dans la transaction
 * @param {bigint} p.baseFee            frais de base du réseau (plancher)
 * @returns {{perOp: bigint, total: bigint, capped: string|null}}
 */
export function computeFeeBid({ mode, fixedPerOp, pct, available, opCount, baseFee }) {
  const ops = BigInt(Math.max(1, opCount));
  const perOpCap = PROTOCOL_MAX_FEE_TOTAL / ops;

  let perOp;
  let capped = null;

  if (mode === "max") {
    const budget = available > 0n ? (available * BigInt(pct)) / 100n : 0n;
    perOp = budget / ops;
  } else {
    perOp = fixedPerOp;
  }

  if (perOp < baseFee) {
    perOp = baseFee;
    capped = "plancher : frais de base du réseau";
  }
  if (perOp > perOpCap) {
    perOp = perOpCap;
    capped = `plafond protocole : ${PROTOCOL_MAX_FEE_TOTAL} stroops au total (uint32)`;
  }

  return { perOp, total: perOp * ops, capped };
}
