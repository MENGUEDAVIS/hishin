# HI-SHIN — The Agentic Video Production Desk

Runs locally, no account or login required — clone it, follow
[Installation](#installation) below, and it's ready. A separately hosted,
multi-user deployment of this same core also exists at
https://hishin.globalnavigator.app.

Architecture diagrams (system + the Director/Critic agent loop):
[`ARCHITECTURE.md`](ARCHITECTURE.md). License: [MIT](LICENSE).

« AI decides what to cut. Deterministic tools decide where to cut. »

## État

Les 6 étapes du brief sont implémentées : pipeline média déterministe
(`01-ingest` à `07-mix`), outils Strands, agents Director/Critic sur Amazon
Bedrock, serveur Express + UI React, tests d'agents scriptés et scripts
d'évaluation. Testé en conditions réelles à chaque étape (AWS Transcribe et
Bedrock réels, vraies vidéos, vrai navigateur pour l'UI) — voir
`docs/architecture.md` pour le détail de chaque validation.

Extension post-livraison : un champ **script** distinct du brief (le texte
prévu pendant le tournage, comme référence pour l'agent), une **voix off
générée** (Amazon Polly — `08-narrate.js`, timing mot-par-mot réel via
speech marks) pour un CTA ou une transition absents des rushs, et des
**photos uploadées** utilisables comme segments ou visuel derrière une
narration (`01b-ingest-photos.js`, `09-photo-clip.js`, zoom Ken Burns,
légende incrustée). Le plan éditorial mélange librement les 3 types de
segment (`take` / `narration` / `photo`).

Voir [l'architecture, les dépendances et les résultats des runs réels](docs/architecture.md)
et [les contrats JSON de chaque module du pipeline](docs/tool-contracts.md).

```sh
npm run check:setup       # Node 24, FFmpeg/FFprobe, AWS CLI
npm run typecheck         # tsc --noEmit sur tout le dépôt (JS inclus via JSDoc)
npm test                  # unitaires + intégration (ffmpeg réel, ignoré si absent)
npm run test:agents       # modèles scriptés ; le scénario de narration appelle Amazon Polly
node scripts/pipeline.js <module> --file input.json   # exécuter un module isolément

# Pipeline complet sur des rushs réels (ingest + AWS Transcribe + derush)
node --env-file=.env scripts/run-project.js <projectId> <fichier1> <fichier2> ...

# Agents Director + Critic (Amazon Bedrock) en boucle jusqu'à PASS ou MAX_REVISION_ROUNDS
node --env-file=.env --import tsx scripts/run-director.ts \
  <projectId> "<brief>" <targetDurationSeconds> <mp4|mov> <take_id> [take_id...]

# Évaluation d'un rendu déjà produit
node --import tsx eval/timing.ts <manifest.json>
node --import tsx eval/production-metrics.ts <projectId> <manifest.json> [subtitles.srt]

# Serveur + UI (deux processus séparés, l'UI proxy /api vers le serveur)
npm run server    # http://127.0.0.1:3001
npm run ui:dev     # http://localhost:5173
```

## Dashboard et historique des montages

L'interface comprend un **Dashboard**, **Nouveau montage** et **Historique**.
L'historique permet de rechercher les rendus, filtrer les verdicts et ouvrir chaque
version pour lire la vidéo, consulter les segments retenus et les retours des agents.
La coupe assemblée et le mixage sont consultables séparément lorsqu'ils existent.
Le formulaire en cours est conservé quand on change d'onglet (pas après un rechargement).

`GET /api/library` découvre les projets et manifests de rendu déjà présents dans
`DATA_DIR/projects`, y compris ceux produits auparavant par la CLI. Les anciennes
vidéos restent visibles même sans compte rendu d'agent ; les informations absentes
sont indiquées explicitement. Les fichiers vidéo supprimés sont signalés indisponibles.

Les nouvelles sessions du serveur sont sauvegardées atomiquement dans
`projects/<id>/jobs/<jobId>.json`. Un redémarrage marque les sessions inachevées en
erreur sans relancer automatiquement les agents. Un seul job par projet peut être
actif dans le serveur. Chaque prochaine itération conserve les décisions du Director
et l'évaluation du Critic dans le `review.json` du rendu ; les décisions déjà écrites
restent accessibles si l'évaluation suivante échoue.

```sh
npm run test:history  # anciennes versions, fichiers manquants, redémarrage ; sans AWS
npm run ui:build      # compilation de l'interface
```

Après modification du backend, redémarrer `npm run server`. Pour un aperçu isolé
sans interrompre un serveur existant :

```sh
PORT=3002 npm run server
API_PROXY_TARGET=http://127.0.0.1:3002 npm run ui:dev -- --host 127.0.0.1 --port 5174
```

## Installation

Prérequis : Node.js 24, npm, FFmpeg et FFprobe accessibles dans le PATH.
Sur macOS avec Homebrew : `brew install ffmpeg`.

```sh
npm ci
cp .env.example .env
npm run check:setup
npm run typecheck
```

`check:setup` ne contacte pas AWS et retourne un code non nul si un prérequis média manque.
`npm test` couvre le pipeline (unitaire + intégration ffmpeg réelle) ; `npm run test:agents`
couvre les agents avec un modèle scripté ; son scénario de narration utilise Amazon Polly.

## AWS

Le SDK utilise la chaîne standard d'identifiants AWS, y compris les profils de la CLI.
Région : `us-east-1`. Depuis l'étape 4, `TRANSCRIBE_S3_BUCKET` pointe vers un bucket S3
dédié (accès public bloqué, chiffrement AES256, expiration automatique à 7 jours sous le
préfixe `hishin/`), et `BEDROCK_DIRECTOR_MODEL_ID`/`BEDROCK_CRITIC_MODEL_ID` référencent
des profils d'inférence Bedrock vérifiés disponibles pour ce compte
(`us.anthropic.claude-sonnet-4-6` et `us.anthropic.claude-haiku-4-5-20251001-v1:0` — Claude
3.5 n'apparaissait pas dans le catalogue régional interrogé). Ces trois valeurs, l'appel
`bedrock-runtime converse` et un run complet Director/Critic ont été testés avec de vrais
appels AWS, pas seulement une lecture de catalogue.

Le MVP prévu exécute les rendus localement et utilise Bedrock et AWS Transcribe à distance.
Les permissions nécessaires seront limitées au modèle choisi, aux jobs Transcribe et au
préfixe S3 du projet. Les identifiants AWS restent côté serveur.
