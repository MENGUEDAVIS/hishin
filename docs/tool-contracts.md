# Étape 2 — Contrats du pipeline média déterministe

Chaque module de `src/pipeline/` exporte une fonction asynchrone JSON → JSON
et reste appelable isolément, sans agent, via `scripts/pipeline.js` :

```sh
node scripts/pipeline.js <module> --file input.json
echo '{"...")}' | node scripts/pipeline.js <module>
```

La sortie JSON va sur stdout, les erreurs (stack incluse) sur stderr avec un
code de sortie non nul. Les identifiants (`projectId`, `takeId`, `segment_id`,
noms de fichiers du sound-library) sont validés par une regex conservatrice
avant tout accès disque, pour empêcher toute traversée de chemin.

Deux conventions de casse coexistent volontairement : les modules 01 à 03b
utilisent des clés `camelCase` (état interne du pipeline) ; les modules 04 et
05, qui implémentent directement les contrats d'outils du brief
(`resolve_segments`, `assemble_edit`), et les modules 06/07 utilisent les
clés `snake_case` du brief pour rester fidèles au contrat exposé plus tard à
l'agent Director.

## 01-ingest

Copie les fichiers source, calcule un sha256 et interroge ffprobe. N'écrit
jamais de timestamp inventé — seulement ce que ffprobe rapporte.

```json
// entrée
{ "projectId": "proj_demo", "sources": [{ "path": "/abs/take1.mov", "takeId": "take_01" }] }
// sortie
{ "projectId": "proj_demo", "takes": [{ "takeId": "take_01", "sourcePath": "...", "storedPath": "...", "sha256": "...", "durationMs": 12345, "mediaMetadata": { "...": "..." } }], "warnings": [] }
```

Écrit aussi `data/projects/<id>/raw/manifest.json`, relu par tous les modules
suivants pour retrouver `storedPath` à partir d'un `takeId`.

## 02-transcribe

Extrait l'audio en WAV mono 16 kHz (ffmpeg), l'envoie à AWS Transcribe, puis
segmente les phrases par ponctuation/silence — jamais par un modèle de
langage. Accepte des clients AWS injectés (`deps.s3Client`,
`deps.transcribeClient`, `deps.fetchImpl`) pour rester testable sans réseau ;
`itemsToWords` est exportée séparément et couverte par
`tests/unit/transcribe-parsing.test.js` avec une fixture statique.

```json
// entrée
{ "projectId": "proj_demo", "takeId": "take_01", "languageCode": "fr-FR" }
// sortie
{ "projectId": "...", "takeId": "...", "transcriptPath": "...", "words": [...], "sentences": [...], "warnings": [] }
```

Nécessite `TRANSCRIBE_S3_BUCKET` ; requiert de vrais identifiants AWS, donc
non couvert par les tests d'intégration locaux (voir `docs/architecture.md`).

## 03-derush

Signale, sans jamais supprimer une source, les prises probablement ratées ou
dupliquées : ratio de mots de remplissage, silence de fin mesuré par ffmpeg,
formule explicite de reprise, similarité de Jaccard entre phrases.

```json
// entrée
{ "projectId": "proj_demo", "takeIds": ["take_01", "take_02"] }
// sortie
{ "projectId": "...", "flags": [{ "takeId": "...", "sentenceId": "...", "flagType": "filler_heavy", "score": 0.2, "explanation": "..." }], "duplicateGroups": [{ "groupId": "dup_01", "members": [...], "similarity": 0.86 }] }
```

## 03b-tighten

Mesure les silences (`ffmpeg silencedetect`), les rétrécit d'une marge
configurable pour ne jamais couper un mot, puis calcule les fragments
restants. Persiste `data/projects/<id>/tighten/<takeId>.json`.

```json
// entrée
{ "projectId": "proj_demo", "takeId": "take_01", "marginMs": 120, "minSilenceToCutMs": 500 }
// sortie
{ "projectId": "...", "takeId": "...", "originalDurationMs": 4300, "tightDurationMs": 3200, "removedMs": 1100, "fragments": [{ "fragmentId": "take_01_f01", "startMs": 0, "endMs": 1620, "includesSentenceIds": ["take_01_s01"] }] }
```

## 04-assemble (`assemble_edit` + `resolve_segments`)

Seul point du pipeline où un `segment_id` sémantique devient un timestamp.
`resolveSegments` accepte un `sentence_id` (issu de 02-transcribe) ou un
`fragment_id` (issu de 03b-tighten), retrouve le fichier source et les bornes
d'origine, puis lève une erreur explicite si l'identifiant est inconnu —
aucun agent ne peut donc fournir de timestamp qui ferait autorité.
`assemble` résout, découpe (ré-encodage précis, `-ss`/`-t` après `-i`),
normalise (résolution/fps configurables via `brand_config`) et concatène.

```json
// entrée
{
  "project_id": "proj_demo",
  "edit_plan": {
    "target_duration_seconds": 60,
    "output_format": "mp4",
    "segments": [
      { "segment_id": "take_01_s01", "role": "hook", "reason": "accroche" },
      { "segment_id": "take_04_f02", "role": "body", "reason": "cœur du message" }
    ]
  }
}
// sortie
{ "output_path": "...", "duration_ms": 61200, "segments_used": ["take_01_s01", "take_04_f02"], "warnings": [], "manifest_path": "...", "timeline": [{ "segment_id": "...", "source_file": "...", "source_start_ms": 0, "source_end_ms": 1500, "output_start_ms": 0, "output_end_ms": 1480 }] }
```

`manifest_path` pointe vers un JSON complet (plan, timeline, avertissements)
consommé par 05-subtitles.

## 05-subtitles

Projette les mots des transcripts source sur la timeline réellement produite
par l'assemblage (décalage `output_start_ms - source_start_ms`), regroupe en
cues lisibles (limites de caractères/durée/silence), écrit SRT et VTT.

```json
// entrée
{ "project_id": "proj_demo", "manifest_path": "data/projects/proj_demo/renders/assemble_.../manifest.json" }
// sortie
{ "srt_path": "...", "vtt_path": "...", "cue_count": 14 }
```

## 06-sound-library

Prépare uniquement des fichiers déjà présents dans `data/sounds/` (aucun
fetch réseau arbitraire) et exige une licence explicite par requête — jamais
supposée libre de droits.

```json
// entrée
{ "project_id": "proj_demo", "requests": [{ "cue_id": "music_bed", "type": "music", "filename": "corporate-loop.mp3", "license": "CC-BY 4.0 — Auteur X" }] }
// sortie
{ "project_id": "...", "assets": [{ "cue_id": "music_bed", "type": "music", "stored_path": "...", "duration_ms": 90000, "license": "..." }], "warnings": [] }
```

## 07-mix

Mixe voix + musique (ducking par `sidechaincompress`), normalise le loudness
(`loudnorm`), mesure le résultat final par une passe d'analyse ffmpeg
séparée, et mixe optionnellement des sous-titres en piste douce (`mov_text`).

```json
// entrée
{ "project_id": "proj_demo", "video_path": ".../assembled.mp4", "music": { "stored_path": "...", "volume_db": -18 }, "subtitles_path": ".../assemble_....srt", "target_lufs": -14 }
// sortie
{ "output_path": "...", "duration_ms": 61200, "loudness_measured": { "integrated_lufs": -14.1, "true_peak_dbtp": -1.6, "loudness_range": 6.2 }, "warnings": [] }
```

## Couverture de test actuelle

- `tests/unit/timeline.test.js` : fonctions pures de `src/media/timeline.js`.
- `tests/unit/transcribe-parsing.test.js` : parsing AWS Transcribe sur
  fixture statique (`tests/fixtures/transcript.json`), sans réseau.
- `tests/unit/pipeline.test.js` : validation Zod et chemins d'erreur, sans
  ffmpeg.
- `tests/integration/media-workflow.test.js` : run réel (ffmpeg genère un
  clip synthétique en mémoire) ingest → tighten → assemble → subtitles, avec
  assertions sur des durées mesurées par ffprobe. Ignoré automatiquement si
  ffmpeg est absent du PATH.

02-transcribe (AWS) et 07-mix (assets audio propres) ne sont pas encore
couverts par un test d'intégration local ; ce sera traité à l'étape 6 avec
des identifiants AWS explicitement activés, conformément à
`docs/architecture.md`.
