# Production — hishin.globalnavigator.app

## Architecture et coût

Région us-east-1, VPC par défaut. ECS Fargate Linux x86 : une tâche **0,5 vCPU / 2 Go**,
ALB HTTPS, Cognito **Essentials** (Managed Login v2 avec branding personnalisé —
logo, couleurs de la marque — inscription e-mail, connexion, récupération de mot de passe),
EFS chiffré pour médias/SQLite, ECR pour les images, CodeBuild pour compiler sans Docker local.
Pas de NAT Gateway : IP publique de tâche, mais entrée réseau uniquement depuis le
security group de l'ALB. EFS accepte uniquement le security group de la tâche et monte en TLS.

`/` est exempté de l'authentification (page marketing statique, un seul fichier HTML
auto-contenu) ; `/app` (SPA React) et `/api/*` restent entièrement derrière Cognito.

Estimation au 7 septembre 2026, 730 heures/mois, faible trafic, 10 Go EFS :

| Poste | USD/mois estimés |
| --- | ---: |
| Fargate 0,5 vCPU + 2 Go | 21,27 |
| ALB, tarif horaire fixe | 16,43 |
| 3 IPv4 publiques (2 ALB + 1 tâche) | 10,95 |
| EFS Standard, 10 Go | 3,00 |
| LCU faible usage, logs, ECR, sauvegardes | environ 3–8 |
| Total indicatif | environ 55–60 |

Hors Bedrock, Transcribe, Polly, taxes, trafic sortant important, croissance du stockage,
builds ponctuels et éventuel dépassement du palier gratuit Cognito. Ce n'est pas un plafond.
La zone Route 53 existe déjà. Les alias DNS vers ALB n'ajoutent pas une nouvelle zone.
Cognito Essentials bénéficie des mêmes 10 000 MAU gratuits par compte/organisation que
Lite (au-delà, Essentials facture 0,015 $/MAU contre un tarif dégressif pour Lite —
sans impact réel à l'échelle de ce projet). Le passage à Essentials était nécessaire
pour l'éditeur de branding Managed Login (indisponible sur Lite). L'envoi d'e-mails
par défaut de Cognito convient à un petit lancement ; prévoir SES configuré pour un
volume d'inscriptions plus élevé.

Sources : [Fargate](https://aws.amazon.com/fargate/pricing/),
[ALB](https://aws.amazon.com/elasticloadbalancing/pricing/),
[IPv4](https://aws.amazon.com/vpc/pricing/), [EFS](https://aws.amazon.com/efs/pricing/),
[Cognito](https://aws.amazon.com/cognito/pricing/).

Ce choix réduit l'administration système, pas le prix absolu. Une VM Lightsail
2 Go coûte 12 USD/mois, 4 Go 24 USD/mois avant sauvegardes et services annexes,
mais demande de gérer le serveur, le reverse proxy/TLS et l'intégration OAuth côté
application. Ses CPU sont également soumis aux contraintes de burst. Pour le minimum
de dépenses fixes, cette alternative est moins chère ; ici on conserve le socle
managé explicitement autorisé. [Bundles Lightsail](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html).

## Sessions et isolation

L'ALB redirige le navigateur vers Cognito et gère un cookie Secure/HttpOnly, session
de 8 heures (`SessionTimeout`, relevé après une session d'une heure jugée trop courte
pour des rounds Director/Critic de plusieurs minutes suivis d'une revue). `/logout`
efface les fragments du cookie ALB et termine la session Cognito. Côté client, tout
appel API recevant un 401 déclenche une redirection immédiate vers `/app` plutôt que
de rester à re-tenter silencieusement (`ui/src/api.ts`) — un 401 ne signifie jamais
autre chose qu'une session morte.
Les requêtes API sans session obtiennent 401. L'application vérifie la signature ES256
ALB (y compris son format base64url avec padding), signer, client et expiration.
Le `sub` signé est l'identité, jamais un en-tête utilisateur libre.

Chaque nouveau projet reçoit un identifiant serveur et un propriétaire en SQLite.
Bibliothèque, jobs, traces, coûts, médias et outils de montage sont limités au projet
autorisé. Les chemins serveur arbitraires sont désactivés en production, les liens
symboliques ne peuvent pas sortir du projet, les requêtes modifiantes exigent l'Origin
de l'application. Les médias sont servis par l'API authentifiée, jamais par un bucket public.
Les anciens projets locaux ne sont ni publiés ni attribués automatiquement à un compte.

## Limites de cette première production

- Plusieurs utilisateurs peuvent se connecter et consulter leurs projets ; **un rendu
  global à la fois**. Un second lancement reçoit un message lui demandant de réessayer.
  Il n'y a pas encore de file de jobs multi-workers.
- 0,5 vCPU privilégie le coût : le rendu peut être lent. Durée cible limitée à 300 s,
  upload limité à 500 Mo par fichier et 10 fichiers par requête, 1 révision du Critic,
  20 tours du Director et timeout de 10 minutes par commande média. Le serveur Node
  accepte désormais jusqu'à 30 minutes pour recevoir un upload volumineux
  (`server.requestTimeout`) — la limite par défaut de 5 minutes coupait net les
  uploads multi-vidéos sur une connexion lente.
- La voix off générée (Amazon Polly) n'est jamais utilisée par défaut : les outils
  `list_voices`/`synthesize_narration` ne sont même pas exposés au Director tant que
  l'humain n'a pas explicitement coché « Allow generated voice-over narration » pour
  ce run (`allowNarration`, par défaut `false` partout — API, CLI, UI).
- Une seule tâche active : pas de haute disponibilité applicative. Les déploiements
  démarrent la nouvelle tâche avant d'arrêter l'ancienne (`minimumHealthyPercent=100`,
  `maximum=200`), et le délai de désenregistrement de l'ALB est de 30 minutes
  (`deregistration_delay.timeout_seconds=1800`) — un upload volumineux déjà en cours
  sur l'ancienne tâche a le temps de se terminer au lieu d'être coupé net. Ce n'était
  pas le cas au départ (30 secondes, `minimumHealthyPercent=0`) : plusieurs uploads
  réels ont été interrompus par des déploiements avant correction.
- SQLite reste en journal DELETE, synchronous FULL, un seul processus serveur,
  sauvegardes EFS activées. Ne pas activer WAL sur le partage NFS ni augmenter le
  nombre de réplicas sans revoir la base, les verrous et l'exécution des jobs.
- EFS conserve les fichiers après remplacement de tâche. Les jobs interrompus sont
  marqués en erreur au prochain démarrage ; ils ne reprennent pas automatiquement.
- L'isolation est applicative et testée ; les utilisateurs partagent le processus.
  Une plateforme destinée à des volumes importants doit séparer les workers, utiliser
  des uploads directs S3, des quotas durables et une base adaptée au multi-instance.

## Construire et déployer

Les ressources sont décrites dans `infra/bootstrap.json` et `infra/production.json`,
générés par `python3 infra/generate.py`. Les templates constituent l'infrastructure
versionnée ; ne pas modifier les ressources à la main sans reporter le changement.

```sh
npm ci
npm run typecheck
npm run test:unit
npm run test:history
npm run test:auth
npm run ui:build
python3 infra/generate.py
aws cloudformation deploy --stack-name hishin-prod-build --template-file infra/bootstrap.json --capabilities CAPABILITY_IAM
python3 infra/release.py build
# Consulter le buildId retourné avec aws codebuild batch-get-builds.
# Attendre SUCCEEDED avant l'étape suivante :
python3 infra/release.py deploy release-YYYYMMDD-HHMMSS
```

Le packaging autorise uniquement le code nécessaire au build. Aucun `.env`, profil AWS,
base SQLite ou rush local n'est envoyé. Les permissions AWS proviennent du rôle ECS,
pas de clés dans l'image. Les tags ECR sont immuables ; garder le tag précédent pour
un retour arrière via `release.py deploy ANCIEN_TAG`.

Logs : `/hishin/prod/app` et `/hishin/prod/build`, rétention 7 jours. Les ressources
persistantes (pool utilisateurs, EFS, buckets, ECR) sont conservées à la suppression
des stacks : supprimer la stack ne supprime donc pas nécessairement tous les coûts.

En local `npm run server` conserve le mode local, sauf AUTH_MODE explicite. En
production, AUTH_MODE=alb et toute la configuration Cognito/ALB sont obligatoires ;
AUTH_MODE=disabled ne peut pas désactiver l'authentification avec NODE_ENV=production.
