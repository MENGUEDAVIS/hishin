# Étape 1 — Structure du dépôt et dépendances

## Choix d'implémentation

Node.js 24 en ESM ; pipeline JavaScript avec JSDoc vérifié par TypeScript ; contrats,
outils Strands, agents et serveur en TypeScript ; UI React + TypeScript avec Vite.
Le stockage local utilisera `node:sqlite` et des fichiers JSON par projet.
SQLite natif de Node 24 reste une API à surveiller lors des mises à jour du runtime.

Pour une démo, un processus serveur local et une file de rendus à concurrence limitée
suffisent. Le choix d'un hébergement AWS et son déploiement restent à définir ; aucun
service de calcul cloud n'est provisionné à cette étape.

FFmpeg et FFprobe seront exécutés via `node:child_process.spawn`, avec tableaux
d'arguments, sans shell. `fluent-ffmpeg` est déprécié et son dépôt archivé : cette
adaptation du brief évite de construire le pipeline sur ce wrapper abandonné.
Source : https://github.com/fluent-ffmpeg/node-fluent-ffmpeg

Strands TypeScript fournit les agents, le fournisseur Bedrock et les outils Zod.
Source : https://strandsagents.com/docs/user-guide/quickstart/typescript/

## Arborescence cible complète

Les dossiers sont créés maintenant. Les fichiers métier ci-dessous sont **prévus**,
et seront écrits aux étapes 2 à 6 ; aucun fichier factice ne simule leur implémentation.
Les fichiers de configuration, ce document et `scripts/check-setup.js` existent déjà.

```text
hi-shin/
├── brief.md
├── README.md
├── package.json
├── package-lock.json
├── .gitignore
├── .nvmrc
├── .env.example
├── tsconfig.json
├── jest.config.js
├── docs/
│   ├── architecture.md
│   ├── tool-contracts.md
│   └── demo-runbook.md
├── config/
│   ├── brand.example.json
│   └── pricing.example.json
├── scripts/
│   ├── check-setup.js
│   ├── pipeline.js
│   └── generate-fixtures.js
├── src/
│   ├── pipeline/
│   │   ├── 01-ingest.js
│   │   ├── 02-transcribe.js
│   │   ├── 03-derush.js
│   │   ├── 03b-tighten.js
│   │   ├── 04-assemble.js
│   │   ├── 05-subtitles.js
│   │   ├── 06-sound-library.js
│   │   └── 07-mix.js
│   ├── media/
│   │   ├── ffmpeg.js
│   │   ├── probe.js
│   │   ├── timeline.js
│   │   └── paths.js
│   ├── contracts/
│   │   ├── pipeline.ts
│   │   ├── editorial-plan.ts
│   │   └── critique.ts
│   ├── tools/
│   │   ├── inspect-take.ts
│   │   ├── resolve-segments.ts
│   │   ├── assemble-edit.ts
│   │   ├── pipeline-tools.ts
│   │   └── registry.ts
│   ├── agents/
│   │   ├── director.ts
│   │   ├── critic.ts
│   │   ├── prompts.ts
│   │   └── run-loop.ts
│   ├── state/
│   │   ├── database.ts
│   │   └── project-store.ts
│   ├── observability/
│   │   ├── logger.ts
│   │   ├── traces.ts
│   │   └── usage.ts
│   └── server/
│       ├── index.ts
│       ├── config.ts
│       ├── jobs.ts
│       └── routes.ts
├── ui/
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api.ts
│       ├── styles.css
│       └── components/
│           ├── ProjectForm.tsx
│           ├── RunTrace.tsx
│           └── ReviewPlayer.tsx
├── tests/
│   ├── unit/
│   │   ├── pipeline.test.js
│   │   ├── contracts.test.js
│   │   └── timeline.test.js
│   ├── integration/
│   │   ├── media-workflow.test.js
│   │   ├── agent-tools.test.js
│   │   └── bedrock-live.test.js
│   └── fixtures/
│       ├── transcript.json
│       └── brief.json
├── eval/
│   ├── timing.ts
│   └── production-metrics.ts
└── data/                         # ignoré par Git sauf .gitkeep
    ├── sounds/
    └── projects/<project_id>/
        ├── project.json
        ├── state.sqlite
        ├── raw/
        ├── transcripts/
        ├── plans/
        ├── renders/
        └── traces/events.jsonl
```

## Dépendances npm

Les contraintes sont dans `package.json` ; les versions résolues sont verrouillées
dans `package-lock.json` pour `npm ci`.

| Paquet | Usage prévu |
| --- | --- |
| `@strands-agents/sdk` | Director, Critic, outils et boucle agent |
| `@aws-sdk/client-bedrock-runtime` | Types, commandes et accès au runtime Bedrock |
| `@aws-sdk/client-s3` | Audio intermédiaire et résultats Transcribe |
| `@aws-sdk/client-transcribe` | Jobs de transcription avec timestamps des mots |
| `zod` | Validation stricte des entrées, plans, sorties et configurations |
| `express` | API locale, projets, rendus, flux de progression |
| `pino` | Logs JSON structurés |
| `react`, `react-dom` | Interface de création et revue |
| `typescript`, `tsx` | Vérification des types et exécution TypeScript |
| `vite` | Développement et compilation de l'UI |
| `jest`, `@types/jest` | Tests unitaires et intégration |
| `@types/node`, `@types/express` | Types serveur |
| `@types/react`, `@types/react-dom` | Types UI |

Aucun package SQLite, dotenv, UUID, SRT ou wrapper FFmpeg supplémentaire n'est
nécessaire : Node fournit SQLite, `--env-file`, `crypto.randomUUID` et les processus
enfants ; SRT/VTT seront sérialisés par des fonctions testées.
AWS Transcribe est le fournisseur initial retenu, donc Whisper n'est pas requis.

## Contrats et responsabilités prévus

Chaque module exposera une fonction asynchrone JSON → JSON et sera accessible via
une CLI commune. La sortie JSON ira sur stdout, les diagnostics sur stderr.
Zod vérifiera les entrées avant tout accès aux médias.

1. **Ingest** : validation, copie des sources, hashes, métadonnées FFprobe, IDs stables.
2. **Transcribe** : extraction audio FFmpeg, S3, job AWS Transcribe, mots horodatés,
   phrases et IDs. Les frontières proviendront de l'alignement du transcripteur,
   jamais d'un LLM ; ce sont des estimations de reconnaissance, pas une vérité sample-exacte.
3. **Derush** : heuristiques de doublons/prises ratées, scores et drapeaux explicables ;
   le Director décidera de la pertinence éditoriale, sans suppression automatique des sources.
4. **Tighten** : silences mesurés par FFmpeg, marges conservatrices autour des mots,
   fragments dérivés persistés avec IDs. Aucune frontière temporelle générée par l'agent.
5. **Assemble** : résolution des IDs depuis le stockage, normalisation vidéo/audio,
   découpe et concaténation avec réencodage, manifeste de correspondance source → sortie.
6. **Subtitles** : projection des mots sur la timeline réellement assemblée, SRT/VTT.
7. **Sound library** : sons locaux ou URLs explicitement configurées, validation,
   préparation FFmpeg, métadonnées de licence ; aucune musique supposée libre de droits.
8. **Mix** : musique, ducking, loudness, rendu final et mesure FFprobe.

`inspect_take(take_id)` restituera le contrat du brief, timestamps compris pour
l'inspection. Le plan éditorial strict n'acceptera que des IDs, rôles et raisons :
les champs temporels additionnels seront rejetés, de même que les IDs inconnus.
`resolve_segments(segment_ids)` résoudra les bornes depuis les données persistées.
`assemble_edit(edit_plan)` résoudra lui-même les segments : aucune paire de timestamps
fournie par un agent ne sera une autorité de montage.

Le Director composera le plan, les outils réaliseront le rendu, puis le Critic rendra
PASS/REVISE et des problèmes structurés. La durée et les caractéristiques techniques
seront contrôlées par code. Cohérence, CTA et marque seront évalués à partir du brief,
du texte réellement retenu et des images extraites du rendu, selon les capacités du modèle.
Le nombre de révisions sera borné et chaque tentative conservée.

## État, observabilité et vérification prévus

SQLite stockera projets, jobs, segments, plans, rendus et statuts. JSON conservera les
artefacts lisibles ; les transitions seront persistées pour diagnostiquer une interruption.
Chaque trace inclura projet, run, outil, durée, statut et usage des modèles. Les coûts
seront des estimations calculées avec des tarifs configurés et datés ; tarif absent =
coût inconnu. Transcribe, S3 et calcul seront distingués des coûts de tokens.

Les tests média utiliseront des fichiers synthétiques générés par FFmpeg, avec des
assertions sur les durées, les changements de timebase, les sous-titres et les coupes.
Les tests d'agents injecteront un modèle contrôlé pour prouver les appels d'outils et
le rejet des timestamps inventés. Les tests AWS réels seront séparés et explicitement
activés ; les mocks ne constitueront pas une preuve de fonctionnement Bedrock.

## Validation de l'étape 1

`npm run typecheck` vérifie le socle présent, pas le code métier futur.
`npm run check:setup` signale les exécutables manquants. Aucun workflow vidéo
de bout en bout ne peut encore être revendiqué à cette étape.

L'arrêt avant l'étape 2 vient explicitement de la dernière section du brief :
“Wait for my approval before proceeding to STEP 2.”

## Étape 2 — Pipeline média déterministe (implémentée)

Les huit modules de `src/pipeline/` (01-ingest à 07-mix) et les utilitaires
`src/media/` (`ffmpeg.js`, `probe.js`, `timeline.js`, `paths.js`) sont écrits
et fonctionnels. Le détail des contrats JSON de chaque module est dans
[`docs/tool-contracts.md`](tool-contracts.md) plutôt que dupliqué ici.

Écarts volontaires par rapport au brief, tous documentés dans le code ou ci-dessus :
- AWS Transcribe (pas Whisper), déjà acté à l'étape 1.
- 04-assemble résout lui-même les `segment_id` (sentence_id ou fragment_id) au
  lieu d'exposer `resolve_segments` comme un module séparé ; la fonction
  `resolveSegments` reste exportée séparément pour le futur outil Strands.
- Les coupes ré-encodent systématiquement (`-ss`/`-t` après `-i`, jamais de
  stream-copy en entrée) pour garantir l'exactitude image près, au prix de
  la vitesse — acceptable pour des formats courts.

### Validation de l'étape 2

- `npm run typecheck` : aucune erreur, y compris sur les fichiers `.js` du
  pipeline (JSDoc vérifié en mode `strict`).
- `npm run test:unit` : 25 tests, fonctions pures de `timeline.js`, parsing
  AWS Transcribe sur fixture statique, validation Zod des huit modules.
- `npm run test:integration` : 4 tests avec un **vrai** FFmpeg (installé et
  vérifié via `npm run check:setup`) — génère un clip synthétique
  (`scripts/generate-fixtures.js`), l'ingère, mesure et retire ses silences,
  résout un `sentence_id` et un `fragment_id` dans le même plan de montage,
  découpe/concatène, puis projette les sous-titres sur la timeline produite.
  Les assertions portent sur des durées mesurées par ffprobe, jamais estimées.
- 29 tests au total, tous verts.

Non couvert par des tests locaux, par construction : 02-transcribe (nécessite
de vrais identifiants AWS et un bucket S3 — la logique de parsing pure est
testée séparément via `itemsToWords`) et 07-mix (nécessite des assets audio
de bibliothèque). Ces deux modules seront couverts à l'étape 6 avec des
identifiants AWS et des assets explicitement activés, comme prévu plus haut.

## Étape 3 — Outils Strands (implémentée)

Chaque module du pipeline est désormais exposé comme outil `@strands-agents/sdk`
(Zod strict, validation avant tout appel FFmpeg/AWS) :

- `src/contracts/editorial-plan.ts` : le plan éditorial du brief. Aucun champ
  timestamp — un agent ne peut physiquement pas en fournir un.
- `src/contracts/critique.ts` : le contrat structuré du Critic.
- `src/tools/inspect-take.ts`, `resolve-segments.ts`, `assemble-edit.ts` : les
  trois contrats nommés du brief.
- `src/tools/pipeline-tools.ts` : `ingest_sources`, `transcribe_take`,
  `derush_project`, `tighten_take`, `generate_subtitles`,
  `prepare_sound_library`, `mix_final` — le reste du pipeline.
- `src/tools/registry.ts` : `createDirectorTools(projectId, sink)` regroupe
  les dix outils, liés à un seul projet par fermeture (pas de `project_id`
  exposé à l'agent).
- `src/agents/run-sink.ts` : `assemble_edit`/`generate_subtitles`/`mix_final`
  poussent leur résultat dans un `RunSink` partagé plutôt que de forcer un
  parsing de l'historique de messages pour retrouver le rendu produit.

Écart volontaire par rapport à l'arborescence prévue à l'étape 1 :
`src/contracts/pipeline.ts` n'a pas été créé séparément — chaque outil
déclare son propre schéma Zod, ce qui s'est avéré suffisant et plus direct.

## Étape 4 — Agents Director et Critic (implémentée)

`src/agents/director.ts` construit un `Agent` Bedrock (modèle vérifié
disponible : `us.anthropic.claude-sonnet-4-6`) avec les dix outils et un
system prompt (`src/agents/prompts.ts`) qui répète la règle stricte du
brief. La boucle outil/modèle est celle du SDK Strands ; `run-loop.ts`
n'ajoute que la boucle **extérieure** Director ↔ Critic.

`src/agents/critic.ts` construit un second `Agent` (modèle
`us.anthropic.claude-haiku-4-5-20251001-v1:0`), sans outils, avec
`structuredOutputSchema: CritiqueSchema`. Il reçoit le brief, la durée cible,
la durée réelle mesurée par ffprobe (jamais recalculée par le modèle), le
texte des sous-titres, et trois images extraites du rendu (`extractFrame`,
`media/ffmpeg.js`) pour juger la cohérence visuelle — conforme à ce qui avait
été annoncé à l'étape 1.

`src/agents/run-loop.ts` (`orchestrate`) enchaîne Director → Critic,
transmet les `issues` en feedback texte au tour suivant si `REVISE`, et
s'arrête après `MAX_REVISION_ROUNDS` révisions (borné, comme prévu).
`src/state/project-store.ts` (`node:sqlite`) et
`src/observability/traces.ts`/`usage.ts` enregistrent chaque tour (rôle,
verdict, tokens, coût si un tarif est configuré, sinon `null`).

`scripts/run-director.ts` lance un run complet en CLI :
```sh
node --env-file=.env --import tsx scripts/run-director.ts \
  <projectId> "<brief>" <targetDurationSeconds> <mp4|mov> <take_id> [take_id...]
```

### Validation de l'étape 4 — run réel, pas simulé

Testé en conditions réelles sur trois rushs fournis (`prise1/2/3.mov`,
26–42 s chacun, en français) après ingest + AWS Transcribe réels : le
Director a inspecté les trois prises, lancé `derush_project` et
`tighten_take` en parallèle, construit un premier montage (32,8 s), et
répondu à deux critiques réelles du Critic (durée insuffisante, absence de
CTA explicite) en révisant deux fois de suite — le tout en raisonnant sur
les durées réelles des phrases à chaque itération. Après le nombre maximal
de révisions (`MAX_REVISION_ROUNDS=2`, donc 3 tours), le verdict final est
resté `REVISE` : ni la durée cible ni un CTA verbal explicite n'existaient
vraiment dans les rushs fournis, et le Critic l'a signalé honnêtement au
lieu de forcer un `PASS`. C'est le comportement voulu — le système ne
prétend pas mieux que la matière brute ne le permet.

Ce run a révélé un vrai bug dans `07-mix.js` : `-af`/`-filter_complex`
étaient insérés entre le `-i` de la vidéo et celui des sous-titres, ce que
FFmpeg refuse (les options de sortie doivent suivre toutes les entrées).
`mix_final` échouait donc silencieusement dès qu'un `subtitles_path` était
fourni ; l'agent l'a détecté seul et a livré sans sous-titres mux. Corrigé
en séparant `inputArgs`/`outputArgs`, avec un test de régression dans
`tests/integration/media-workflow.test.js` (musique + ducking + sous-titres
dans le même rendu).

## Étape 6 — Tests d'agents et évaluation (implémentée)

`runDirector`/`runCritic` acceptent désormais un `model` optionnel
(`Model` du SDK Strands) : omis, ils construisent le vrai `BedrockModel` ;
fourni, ils l'utilisent tel quel. C'est ce qui rend les agents testables
sans réseau ni identifiants AWS.

`tests/helpers/scripted-model.ts` implémente un `Model` scripté minimal :
chaque appel à `stream()` consomme le tour suivant d'un script (appels
d'outils ou réponse texte finale), en émettant les événements de streaming
réels attendus par le SDK. Vérifié directement contre le SDK avant d'écrire
les tests : séquencement des appels d'outils, propagation d'une erreur
d'outil (`status: 'error'`), et sortie structurée (le SDK matérialise
`structuredOutputSchema` comme un outil interne `strands_structured_output`
— constaté sur le vrai run de l'étape 4 avant d'être reproduit ici).

`tests/integration/agent-tools.spec.ts` — **volontairement en dehors de
Jest**, exécuté via `npm run test:agents`
(`node --env-file=.env --import tsx tests/integration/agent-tools.spec.ts`)
avec des assertions `node:assert/strict`. Jest ne convenait pas : son
résolveur de modules (jest-resolve) construit son propre graphe de
dépendances avant l'exécution et ne suit pas le mapping d'extensions de
`tsx` (un import `./x.js` résolu vers `./x.ts`) — `Cannot find module`
systématique dès qu'un fichier `.ts` en importe un autre. Contourner ce
résolveur (transform ts-jest, `moduleNameMapper`) aurait ajouté beaucoup de
fragilité pour un gain minime ; un script `tsx` autonome, déjà éprouvé pour
tous les scripts CLI de ce dépôt, est plus simple et tout aussi automatisé.

Trois preuves, sans AWS ni coût de token :
1. Le Director enchaîne réellement `inspect_take` puis `assemble_edit` (sur
   un take synthétique ingéré/tighten pour de vrai) et produit un fichier
   réel — vérifié via l'historique des messages du modèle scripté, pas
   seulement l'état final.
2. **La règle stricte tient sous pression adverse** : un `segment_id`
   fabriqué de toutes pièces fait échouer l'appel d'outil
   (`Unable to resolve segment_id`) et ne produit aucun rendu.
3. Le Critic tourne une extraction de frames réelle sur un rendu réel et
   retourne le verdict scripté.

`eval/timing.ts` (`evaluateTimingFromManifest`) compare la durée cible à la
durée mesurée et calcule la dérive de chaque segment entre la coupe
demandée et la coupe réellement rendue (bornée à 11 ms sur le run réel de
l'étape 4 — la précision du découpage ffmpeg, pas une estimation).
`eval/production-metrics.ts` (`computeProductionMetrics`) calcule le taux
de compression, le débit de parole (mots/seconde), le taux de mots de
remplissage retenus dans le montage final, et la vitesse de lecture des
sous-titres (caractères/seconde par cue). Les deux sont aussi des CLI :
```sh
node --import tsx eval/timing.ts <manifest.json>
node --import tsx eval/production-metrics.ts <projectId> <manifest.json> [subtitles.srt]
```

## Étape 5 — Interface et observabilité (implémentée)

`src/server/` (Express) : `routes.ts` expose une API REST fine qui délègue
entièrement au pipeline/agents existants (aucune logique dupliquée) —
création de projet (`POST /api/projects` → `ingest`), lancement d'un run
(`POST /api/projects/:id/runs` → `orchestrate`, exécuté en tâche de fond via
`jobs.ts` puisqu'un run réel prend plusieurs minutes), suivi (`GET .../runs/:jobId`),
traces (`GET .../traces`), coûts (`GET .../costs` → `listRuns` SQLite), et un
point `GET /api/media?path=...` qui sert un fichier **uniquement** s'il reste
sous `DATA_DIR` (vérifié via `path.relative`, testé contre une tentative de
traversée de chemin).

`ui/` (React + Vite + TypeScript, proxy `/api` vers le serveur en dev) :
`ProjectForm` (ingestion + configuration du run), `RunTrace` (statut et
traces en direct, poll 3s), `ReviewPlayer` (lecteur vidéo du rendu final,
historique des rounds avec verdicts/issues du Critic, tableau des coûts).

### Correctif post-livraison — vrai upload de fichiers

Le premier jet de l'UI faisait taper un chemin serveur dans un champ texte
au lieu d'un vrai upload — un retour utilisateur a signalé que ce n'était
pas utilisable. `POST /api/projects/upload` (multer, `multipart/form-data`,
jusqu'à 5 Go/fichier) accepte maintenant de vrais fichiers depuis le
navigateur, écrits dans un répertoire de staging temporaire puis ingérés
via `ingest()` (le staging est supprimé juste après, `ingest()` ayant déjà
copié chaque fichier dans `data/projects/<id>/raw/`). `ProjectForm.tsx` a
été refondu en un seul flux continu (script + zone de glisser-déposer +
barre de progression d'upload via `XMLHttpRequest`, `fetch` n'exposant pas
d'événement de progression fiable) plutôt que deux panneaux qui
apparaissent/disparaissent.

Bug détecté pendant la vérification en navigateur réel (pas seulement
curl) : le stockage disque par défaut de multer perd l'extension du
fichier d'origine, donc `ingest()` — qui déduit l'extension du fichier
stocké via `extname(source.path)` — écrivait `take_01` sans extension.
Corrigé avec un `multer.diskStorage` qui préserve l'extension d'origine ;
revérifié en navigateur (`take_01.mov` correct après le correctif).

### Validation de l'étape 5 — testée dans un vrai navigateur, pas seulement curl

`npm run server` puis `npm run ui:dev` ; testé avec `agent-browser` (pas
seulement `curl`, conformément à l'exigence de test UI réel) : formulaire
rempli, projet ingéré pour de vrai (ffprobe réel sur `prise1.mov`), section
« Lancer un montage » affichée avec la prise détectée, aucune erreur console.
Le chemin d'erreur a aussi été vérifié : un chemin de fichier inexistant
remonte le message d'erreur exact du backend (`Source file not found: ...`)
jusqu'à l'UI. Le lancement réel d'un run Director/Critic depuis l'UI n'a pas
été déclenché dans ce test (coût/temps AWS réels) — le chemin serveur→agent
est déjà prouvé séparément par le run CLI de l'étape 4 et par
`tests/integration/agent-tools.spec.ts`.

`tsconfig.json` a dû gagner `allowImportingTsExtensions: true` pour que le
même tsconfig couvre à la fois les imports Node (`NodeNext`, extension
`.js` même pour un fichier source `.ts`) et les imports React/Vite
(extension `.tsx`/`.ts` explicite) sans dupliquer la configuration.

### Ce qui n'est pas fait

Aucun contrôle d'accès sur le serveur (MVP local, écoute sur
`127.0.0.1` par défaut) ; pas de tests automatisés pour l'API/l'UI
elles-mêmes (seule la vérification manuelle en navigateur ci-dessus existe).
Le lancement d'un run depuis l'UI n'a pas été testé en conditions réelles
(coût AWS), seulement son câblage.

## Extension post-livraison — script, voix off générée, photos

Retour utilisateur après l'étape 5 : le "brief" (intention créative) ne
suffisait pas à faire correspondre le montage à ce qui était réellement
prévu d'être dit pendant le tournage, et le pipeline ne pouvait produire un
montage qu'à partir de vrais rushs — pas de voix off générée, pas de photos.
Trois ajouts, choisis avec l'utilisateur (voix Polly laissée au choix de
l'agent selon le contexte ; photos uploadées dans la même zone de dépôt que
les vidéos ; tout construit en un seul passage) :

1. **Script vs brief** — deux champs désormais distincts partout (contrats,
   agents, UI). Le brief est l'intention créative ; le script est le texte
   qui était *censé* être dit pendant le tournage — une référence, pas une
   vérité terrain, puisque les prises réelles peuvent s'en écarter. Le
   Director l'utilise pour juger quelle prise correspond le mieux à
   l'intention et repérer les trous que les rushs ne couvrent pas.

2. **Voix off générée (Amazon Polly)** — `src/pipeline/08-narrate.js`
   (`synthesizeNarration`, `listVoices`). L'agent écrit le texte ; Polly le
   prononce ; la durée et le timing mot-par-mot viennent des *speech marks*
   Polly (mesurés, jamais estimés — vérifié avec un vrai appel avant
   d'écrire le code : `SynthesizeSpeechCommand` avec
   `SpeechMarkTypes:['word']`). Le Director doit appeler
   `synthesize_narration` et référencer le `narration_id` retourné dans son
   plan — jamais le texte brut — exactement comme un `segment_id` doit
   d'abord exister dans un transcript. C'est la réponse directe au problème
   observé à l'étape 4 (aucun CTA verbal dans les rushs réels) : le Director
   peut maintenant générer la phrase d'appel à l'action qui manquait,
   ancrée dans le brief/script/transcripts réels — jamais des faits
   inventés.

3. **Photos et montage libre** — `src/pipeline/01b-ingest-photos.js`
   (upload, même endpoint que les vidéos, routé par mimetype/extension) et
   `src/pipeline/09-photo-clip.js` (photo → clip vidéo normalisé, zoom lent
   type Ken Burns, légende optionnelle incrustée). `EditorialSegmentSchema`
   (`src/contracts/editorial-plan.ts`) est devenu une union discriminée par
   `kind` : `"take"` (inchangé), `"narration"` (narration_id + photo_id
   optionnel comme visuel), `"photo"` (photo_id + `duration_seconds` choisi
   par l'agent, borné à 10s — un choix de rythme, pas une mesure de rush).
   `04-assemble.js` a été réécrit pour construire un clip normalisé par
   segment quel que soit son type, puis concaténer comme avant ;
   `05-subtitles.js` projette maintenant aussi les mots de narration
   (timing Polly local au segment) et ignore les photos silencieuses (leur
   légende est déjà incrustée dans la vidéo).

   Deux vrais problèmes trouvés et corrigés en testant avec du vrai ffmpeg
   avant d'écrire le code définitif :
   - `zoompan` avec une expression contenant une virgule échappée par
     backslash À L'INTÉRIEUR de guillemets simples ffmpeg donnait une sortie
     silencieusement fausse (résolution par défaut 1280×720 au lieu de la
     cible) — les guillemets simples suffisent seuls, l'échappement en plus
     casse l'expression.
   - Le build Homebrew `ffmpeg` standard n'a pas `drawtext` (pas de
     libfreetype) ; `ffmpeg-full` (bottled, keg-only) l'a. `.env` pointe
     `FFMPEG_PATH`/`FFPROBE_PATH` vers ses binaires. Par ailleurs, `drawtext`
     ignore l'échappement du deux-points même entouré de guillemets simples
     dans ce build — `escapeDrawtextValue` (`src/media/ffmpeg.js`) neutralise
     `:`, `%`, `\` plutôt que de les échapper, et remplace l'apostrophe
     droite par une apostrophe typographique.

Validé avec de vrais appels : Polly (`describe-voices`, synthèse réelle
avec speech marks), un plan mixte take + narration + photo assemblé et
rendu via `04-assemble.js` directement puis via le vrai wrapper d'outil
Strands (`tests/integration/agent-tools.spec.ts`, un test dédié — la seule
partie de ce fichier qui appelle un vrai service AWS, Polly, pour un coût
de l'ordre du centime), et un upload mixte vidéo+photo testé dans un vrai
navigateur (fichiers listés séparément, projet affichant "N prise(s), M
photo(s)", aucune erreur console).

Non fait : le CLI `scripts/run-director.ts` n'a pas été étendu pour
accepter `script`/photos en arguments (seule l'UI et l'API le permettent) ;
aucun contrôle dynamique de la taille de police du sous-titrage incrusté
selon la longueur du texte (une légende très longue peut déborder du cadre).
