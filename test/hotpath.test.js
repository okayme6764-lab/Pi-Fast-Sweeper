/**
 * Exerce le chemin chaud complet contre le vrai Horizon Pi, sans aucun risque :
 * la transaction part d'un compte aléatoire jamais approvisionné, donc elle est
 * rejetée à la validation, avant toute inclusion dans un ledger. Aucun frais.
 */
import StellarSdk from "@stellar/stellar-sdk";
import { EndpointPool } from "../src/net.js";
import { toStroops, fromStroops, minBalanceStroops } from "../src/stroops.js";
import { claimableNow, predicateSatisfied } from "../src/wallet.js";
import { computeFeeBid, PROTOCOL_MAX_FEE_TOTAL } from "../src/fee.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

console.log("\n== math stroops ==");
ok("round-trip décimal", fromStroops(toStroops("16632371.5933626")) === "16632371.5933626");
ok("pas de perte float sur gros montant", toStroops("99999999.9999999") === 999999999999999n);
ok("fraction courte paddée", toStroops("1.5") === 15000000n);
ok("entier nu", toStroops("42") === 420000000n);
ok("zéro", fromStroops(0n) === "0.0000000");
// le piège que le script d'origine avait : parseFloat + toFixed(7) qui arrondit VERS LE HAUT
const bal = "0.9999999";
ok("pas d'arrondi vers le haut", fromStroops(toStroops(bal)) === bal,
   `-> ${fromStroops(toStroops(bal))} vs parseFloat=${parseFloat(bal).toFixed(7)}`);

console.log("\n== réserve minimale ==");
const R = 4_900_000n;
ok("compte nu = 0.98 Pi", minBalanceStroops({ subentry_count: 0 }, R) === 9_800_000n);
ok("3 sous-entrées = 2.45 Pi", minBalanceStroops({ subentry_count: 3 }, R) === 24_500_000n);
ok("sponsoring compté", minBalanceStroops({ subentry_count: 0, num_sponsoring: 2, num_sponsored: 0 }, R) === 19_600_000n);

console.log("\n== enchère de frais ==");
const BASE = 100_000n;
const bid = (o) => computeFeeBid({ mode: "max", fixedPerOp: 0n, pct: 10, baseFee: BASE, ...o });
{
  // 1000 Pi récupérables, 10 % misables, 2 ops -> 50 Pi/op, 100 Pi au total
  const r = bid({ available: toStroops("1000"), opCount: 2 });
  ok("mode max mise le pourcentage demandé", r.total === toStroops("100"), `-> ${fromStroops(r.total)}`);
  ok("réparti par opération", r.perOp === toStroops("50"), `-> ${fromStroops(r.perOp)}`);
}
{
  // assiette énorme : doit être ramené au plafond uint32
  const r = bid({ available: toStroops("10000000"), opCount: 2, pct: 90 });
  ok("plafond uint32 respecté", r.total <= PROTOCOL_MAX_FEE_TOTAL, `-> ${r.total}`);
  ok("plafond signalé", /uint32/.test(r.capped ?? ""), `-> ${r.capped}`);
  ok("plafond = 429.4967295 Pi", fromStroops(PROTOCOL_MAX_FEE_TOTAL) === "429.4967295");
}
{
  // compte vide : on ne descend jamais sous le frais de base
  const r = bid({ available: 0n, opCount: 1 });
  ok("plancher = frais de base", r.perOp === BASE, `-> ${r.perOp}`);
  const neg = bid({ available: -5000n, opCount: 1 });
  ok("assiette négative gérée", neg.perOp === BASE);
}
{
  const r = computeFeeBid({
    mode: "fixed", fixedPerOp: toStroops("0.2"), pct: 10,
    available: toStroops("1000"), opCount: 3, baseFee: BASE,
  });
  ok("mode fixed ignore l'assiette", r.total === toStroops("0.6"), `-> ${fromStroops(r.total)}`);
}
{
  // l'enchère ne doit jamais rendre l'envoi impossible
  const available = toStroops("1000");
  const r = bid({ available, opCount: 2, pct: 90 });
  ok("il reste toujours quelque chose à envoyer", available - r.total > 0n);
}

console.log("\n== prédicats claimable balance ==");
const now = 1_800_000_000;
ok("unconditional", predicateSatisfied({ unconditional: true }, now));
ok("lockup non échu", predicateSatisfied({ not: { abs_before_epoch: String(now + 100) } }, now) === false);
ok("lockup échu", predicateSatisfied({ not: { abs_before_epoch: String(now - 100) } }, now) === true);
ok("and", predicateSatisfied({ and: [{ unconditional: true }, { not: { abs_before_epoch: String(now - 1) } }] }, now));
const cbs = [{
  id: "000000001", amount: "1234.5000000",
  claimants: [{ destination: "GABC", predicate: { not: { abs_before_epoch: String(now - 5) } } }],
}, {
  id: "000000002", amount: "50.0000000",
  claimants: [{ destination: "GABC", predicate: { not: { abs_before_epoch: String(now + 99999) } } }],
}];
const split = claimableNow(cbs, "GABC", now);
ok("tri mûr / verrouillé", split.ready.length === 1 && split.pending.length === 1);
ok("date de déblocage extraite", typeof split.pending[0].unlockAt === "string");

console.log("\n== chemin chaud contre le vrai Horizon ==");
const pool = await EndpointPool.resolve("https://api.mainnet.minepi.com");
await pool.warm({ socketsPerEndpoint: 1, quiet: true });
ok("sockets pré-ouverts", pool.endpoints.reduce((n, e) => n + e.warmSockets, 0) > 0);
ok("RTT mesuré et classé", pool.fastest.rtt < Infinity);

const kp = StellarSdk.Keypair.random(); // compte jamais approvisionné
const acc = new StellarSdk.Account(kp.publicKey(), "1");
const t0 = process.hrtime.bigint();
const tx = new StellarSdk.TransactionBuilder(acc, {
  fee: "2000000", networkPassphrase: "Pi Network", withMuxedAccounts: true,
})
  .addOperation(StellarSdk.Operation.claimClaimableBalance({
    balanceId: "00000000" + "de".repeat(32),
  }))
  .addOperation(StellarSdk.Operation.payment({
    destination: "MALYJFJ5SVD45FBWN2GT4IW67SEZ3IBOFSBSPUFCWV427NBNLG3PWAAAAAAAAIAGP5T26",
    asset: StellarSdk.Asset.native(), amount: "1.0000000",
  }))
  .setTimeout(300).build();
tx.sign(kp);
const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
ok("claim + payment dans une seule tx", tx.operations.length === 2);
ok("frais total = enchère × ops", tx.fee === "4000000", `-> ${tx.fee}`);
ok(`build+sign rapide (${buildMs.toFixed(2)} ms)`, buildMs < 50);
ok("XDR re-parsable", !!StellarSdk.TransactionBuilder.fromXDR(tx.toXDR(), "Pi Network"));

const responses = [];
const winner = await pool.broadcast(tx.toXDR(), (r) => responses.push(r), { timeout: 20000 });
ok("aucun endpoint n'accepte une tx d'un compte inexistant", winner === null);
ok("tous les endpoints ont répondu", responses.length === pool.endpoints.length,
   `-> ${responses.length}/${pool.endpoints.length}`);
const withCodes = responses.find((r) => r.json?.extras?.result_codes || r.json?.status);
ok("réponse Horizon décodable", !!withCodes);
console.log("    statuts :", responses.map((r) => `${r.ep}=${r.status}`).join(" "));
console.log("    détail  :", JSON.stringify(withCodes?.json?.extras?.result_codes ?? withCodes?.json?.title));
console.log("    latences:", responses.map((r) => r.ms?.toFixed(0) ?? "err").join(" / "), "ms");

pool.destroy();
console.log(`\n${fail === 0 ? "TOUS LES TESTS PASSENT" : "ÉCHECS"} — ${pass} ok, ${fail} ko\n`);
process.exit(fail === 0 ? 0 : 1);
