# ⚡ Pi Fast Sweeper

Envoie automatiquement les Pi d'un wallet vers une adresse externe (OKX ou autre),
le plus vite que le réseau le permette.

> **Ton propre wallet uniquement.** L'utiliser sur un wallet dont tu n'es pas le
> propriétaire est un vol.

---

## Démarrage en 3 commandes

```bash
npm install
cp .env.example .env     # puis colle tes 24 mots dans PI_MNEMONIC
npm run dry              # affiche ce qui partirait, sans rien envoyer
```

Quand le montant affiché te convient, passe `PI_DRY_RUN="false"` dans `.env` et
lance `npm start`.

`.env.example` contient déjà toutes les variables avec des valeurs qui marchent.
Une seule ligne est à remplir : `PI_MNEMONIC`. Elle est laissée en exemple
exprès, parce que `.env.example` part dans git alors que `.env` est ignoré.

**Node 20.12+ requis.**

| Commande | Ce qu'elle fait |
|---|---|
| `npm run dry` | Tout sauf envoyer : dérive la clé, lit le solde, calcule le montant, signe, affiche le XDR |
| `npm start` | Pour de vrai |
| `npm run watch` | Ne s'arrête pas après le premier envoi |
| `npm run bench` | Classe les serveurs Horizon depuis cette machine |
| `npm test` | 33 tests, dont une soumission réelle sans risque |

---

## Ce que le script fait quand tu le lances

Il affiche tout au fur et à mesure, en français. Cinq phases :

**1. Préchauffage.** Il dérive ta clé, trouve les 5 serveurs Horizon derrière
`api.mainnet.minepi.com`, ouvre les connexions TLS vers chacun et lit les
paramètres du réseau. Tout ce qui coûte cher est fait **maintenant**, pour ne
plus le payer au moment d'envoyer.

**2. État du compte.** Un tableau qui détaille ligne par ligne d'où vient le
montant envoyable, réserve et frais compris.

**3. Réglages actifs.** Un tableau qui traduit ta config en français : ce que
fait ton mode de frais, si le bot s'arrêtera après l'envoi, s'il est en dry-run.

**4. Surveillance.** S'il n'y a rien à envoyer, il **explique pourquoi** en clair
— compte vide, solde immobilisé par la réserve, montant sous le seuil. Puis il
arme ses quatre déclencheurs et l'affiche.

**5. Veille.** Toutes les 30 secondes, un point de situation : solde, nombre de
sondages, latence du meilleur serveur, prochain déblocage. Toute variation de
solde est signalée immédiatement, à la hausse comme à la baisse.

---

## Pourquoi c'est rapide

Le chemin critique, du déclenchement à l'inclusion dans un ledger :

```
[déclencheur] → [montant] → [build+signature] → [POST] → [ledger]
     ~0 ms        ~0 ms          ~2 ms          1 RTT      ~5 s
```

Il ne reste **qu'un aller-retour réseau**. Tout le reste en a été sorti.

| Optimisation | Gain |
|---|---|
| **Connexions TLS pré-ouvertes** et maintenues chaudes. Une connexion neuve paie DNS + poignée de main TCP + TLS avant le moindre octet utile. | **~600 ms** (mesuré : 879 → 281 ms) |
| **Envoi simultané aux 5 IP** de `api.mainnet.minepi.com`. Le SDK n'en utilise qu'une, tirée au sort par le résolveur. Même transaction = même hash = dédoublonnée par le réseau, donc aucun risque. | supprime la variance (p95 mesuré : 284 à 480 ms selon l'IP) |
| **Aucun appel réseau dans le chemin chaud.** Frais, réserve, séquence et clé sont connus d'avance. | 2-3 allers-retours |
| **Aucun SDK à la soumission.** POST direct du XDR sur un socket déjà ouvert. | ~10-20 ms |
| **Déclenchement par flux temps réel** au lieu d'une boucle de 750 ms. | ~375 ms en moyenne |
| **Logs non bloquants.** Sur Windows, `console.log` vers un terminal est synchrone : 1-3 ms bloqués par ligne. Pendant la course, les lignes sont mises de côté et écrites après. | quelques ms |
| **`TCP_NODELAY`.** Pas d'attente de Nagle sur le paquet de soumission. | quelques ms |

### Le piège que presque tous les bots ratent

Quand un lock-up arrive à échéance, **rien ne se passe sur la chaîne**. Le verrou
devient simplement caduc. Aucun événement, aucune notification. Un bot qui écoute
les événements ne verra **jamais** un déblocage.

Le script lit donc la date d'échéance directement dans le verrou, programme une
minuterie dessus, et démarre une rafale de tirs **2 secondes avant** — la
transaction est déjà en file quand le verrou saute, au lieu d'attendre le ledger
suivant (~5 s perdues).

Et quand des claimable balances sont mûres, les opérations de réclamation partent
dans la **même transaction** que l'envoi : un ledger entier économisé par rapport
à réclamer → attendre → envoyer.

---

## L'enchère de frais

C'est la section qui décide qui passe en premier, et elle est contre-intuitive.

**Ta mise est un plafond, pas un prix.** Tu es facturé le prix de clôture du
ledger, jamais ta mise. Quand le réseau est calme — 99 % du temps sur Pi — tu
paies 0,01 Pi même si tu as misé 400.

**Mais tout ce qui est misé doit être réservé**, sinon la transaction serait
sous-financée. Le script le retire donc du montant envoyé, et ce qui n'est pas
dépensé **reste dans le compte source**.

Sur un wallet de 500 Pi :

| Mise | Tu envoies | Tu laisses derrière |
|---|---|---|
| fixe, 400 Pi | 100 Pi | **400 Pi** |
| 10 % (50 Pi) | 450 Pi | 50 Pi |

Si le compte est compromis, ce qui reste derrière est offert au bot adverse.
**Miser le maximum fait exactement l'inverse de ce qu'on veut.**

D'où les deux modes :

| `PI_FEE_MODE` | Comportement |
|---|---|
| `fixed` | Mise toujours `PI_MAX_FEE_STROOPS` par opération, quel que soit le solde |
| `max` | Recalcule à chaque tir : `PI_FEE_BID_PCT` % du récupérable, borné par le plafond du protocole |

**Plafond absolu :** le champ des frais est un entier 32 bits, donc le total
d'une transaction ne peut pas dépasser `4294967295` stroops = **429,4967295 Pi**.
Au-delà, ce n'est pas le réseau qui refuse, c'est le format. Le script borne
automatiquement et le signale.

**Attention :** `PI_MAX_FEE_STROOPS` est le prix **par opération**. Une
transaction qui réclame une balance *et* envoie contient 2 opérations, donc mise
le double.

La surenchère se joue par paliers de **×10** : pour éjecter la transaction de
quelqu'un d'autre, la tienne doit miser au moins 10 fois plus. Les valeurs
intermédiaires ne servent à rien.

---

## Trois bugs de la v1, corrigés

**1. Le code HTTP de Horizon Pi ment.** Vérifié en direct : un échec de
transaction revient en **HTTP 200**, avec le vrai code caché dans le corps JSON.

```
HTTP/1.1 200 OK
{ "type": ".../transaction_failed", "status": 400,
  "extras": { "result_codes": { "transaction": "tx_no_source_account" } } }
```

`server.submitTransaction()` ne lève pas sur un 200, donc la v1 tombait
systématiquement dans sa branche d'erreur générique et affichait *« Le wallet est
verrouillé ou le solde est insuffisant »* — **quelle que soit la vraie cause**.
Le diagnostic était toujours faux. La v2 ne conclut au succès que sur présence
d'un `hash` et absence de tout marqueur d'erreur (`isAccepted()` dans
[`src/net.js`](src/net.js)).

**2. La réserve minimale était fausse.** La v1 codait `minReserve = 1.0` en dur.
La vraie formule :

```
réserve = (2 + sous-entrées + sponsoring − sponsorisé) × base_reserve
```

Sur Pi, `base_reserve` vaut **0,49 Pi** (pas 0,5 comme sur Stellar) : un compte
nu immobilise donc **0,98 Pi**. La valeur en dur laissait 0,02 Pi derrière sur un
compte nu, et devenait **trop basse** dès la moindre sous-entrée — la transaction
échouait alors en `op_underfunded`, avec un ledger perdu.

**3. Les arrondis flottants.** La v1 faisait `parseFloat(...) - frais - réserve`
puis `.toFixed(7)`, qui arrondit. Un seul stroop de trop fait rejeter la
transaction. Tout passe maintenant par des `BigInt` en stroops.

---

## Ce qui compte plus que tout le reste : où tu héberges le bot

Mesuré depuis une connexion résidentielle :

```
RTT vers les 5 serveurs Horizon : ~880 ms à froid, ~280 ms à chaud
```

Aucune optimisation logicielle ne rattrape ça. Les cinq IP sont chez
**DigitalOcean** :

```
178.128.176.205   138.68.40.95   138.68.27.140   165.227.58.177   167.71.158.2
```

Un VPS DigitalOcean dans la même région ramène le RTT à quelques millisecondes.
Lance `npm run bench` depuis chaque machine candidate et prends la plus basse.

Un ledger Pi ferme toutes les ~5 secondes : ces millisecondes décident si tu
entres dans le ledger courant ou dans le suivant.

---

## Architecture

| Fichier | Rôle |
|---|---|
| [`src/index.js`](src/index.js) | Orchestration : préchauffage, déclencheurs, chemin chaud, logs |
| [`src/net.js`](src/net.js) | Pool multi-IP, keep-alive TLS, envoi simultané, flux SSE, `isAccepted()` |
| [`src/fee.js`](src/fee.js) | Calcul de l'enchère, plafond du protocole |
| [`src/stroops.js`](src/stroops.js) | Arithmétique `BigInt` exacte, réserve protocolaire |
| [`src/wallet.js`](src/wallet.js) | Dérivation BIP-39/Ed25519, lecture des verrous |
| [`src/config.js`](src/config.js) | `.env` + flags CLI |
| [`src/bench.js`](src/bench.js) | Benchmark froid/chaud des serveurs |
| [`test/hotpath.test.js`](test/hotpath.test.js) | 33 tests |

Les quatre déclencheurs tournent en parallèle et sont redondants **à dessein** :
si le flux tombe, le sondage prend le relais ; si le sondage rate un tour, le
battement de ledger rattrape.

---

## Sécurité

- `.env` est gitignoré. **La mnémonique de la v1 est toujours dans l'historique
  git** (commits `60a89be` et `5765887`). Si ce wallet doit contenir de la
  valeur, considère-la comme compromise et migre vers une phrase neuve.
- La clé privée est masquée dans les logs (`SAMT…LGHU`). `PI_REVEAL_SECRET=true`
  pour l'afficher — à éviter.
- Ne lance jamais ce script sur une machine partagée : la phrase est en clair
  dans `.env` et en mémoire.
- Une transaction Pi est **irréversible**. Vérifie `PI_DESTINATION` deux fois.

## Licence

ISC — usage responsable exigé.
