# Décisions prises en autonomie

La consigne était de travailler seul, sans poser de questions. Voici chaque décision prise, la raison, et comment revenir dessus si elle ne vous convient pas.

## 1. Produit et périmètre

| # | Décision | Pourquoi | Pour changer |
|---|---|---|---|
| 1.1 | Le livrable est un **tuteur conversationnel** (un « coach » qui accompagne l'apprenant), pas un générateur de cours. | « Que ma formation s'adapte à chaque apprenant » : l'adaptation se joue dans l'échange (diagnostic, explications ajustées, vérification, rappels). Le contenu de référence reste celui du formateur. | — |
| 1.2 | **Trois formes d'adaptation** : profil apprenant (niveau, objectifs, style, rythme, forces, difficultés), progression par module, quiz de vérification. | Ce sont les leviers classiques de la pédagogie différenciée, et ils sont observables par l'apprenant et le formateur. | Outils dans `public/core/agent-core.js` (`TOOLS`). |
| 1.3 | Le profil est **mémorisé d'une session à l'autre** ; « Nouvelle session » repart d'une conversation vierge mais garde le profil. | Une formation en ligne se suit en plusieurs fois ; reprendre là où on s'était arrêté est la base de la personnalisation. | Bouton « Effacer mes données » dans « Mon parcours ». |
| 1.4 | **Formation générique décrite en JSON** (titre, public, objectifs, prérequis, ton, accueil, consignes, modules avec contenu). Seul le titre est obligatoire. | Répond à « s'adapter à tout type de formation » : technique, réglementaire, savoir-être, langues… Deux exemples très différents sont fournis pour le montrer (Excel / prise de parole). | Studio ou fichiers `courses/*.json`. |
| 1.5 | Le contenu du formateur est **la source de vérité** ; le tuteur peut compléter avec ses connaissances générales mais le contenu prime en cas de contradiction. | Évite qu'un tuteur contredise le cours, sans le rendre inutile quand le contenu est succinct. | Section « Cadre » du prompt (`buildSystemPrompt`). |
| 1.6 | Interface, prompt et documentation **en français** ; le tuteur répond dans la langue de l'apprenant (par défaut celle de la formation, champ `language`). | Votre demande est en français ; une formation peut être dans une autre langue. | Champ `language` de la formation. |
| 1.7 | **Pas de comptes utilisateurs ni de base de données** : le profil est stocké dans le navigateur (`localStorage`), séparé par formation et par `learner-id`, et exposé par événements JS pour que votre LMS le sauvegarde. | Votre site a déjà (ou aura) sa propre gestion des apprenants ; dupliquer cela aurait alourdi l'installation et posé des questions RGPD. Le stockage local suffit pour démarrer. | Événement `training-agent:profile` + `setProfile()` (voir README). |

## 2. Pédagogie (prompt système)

| # | Décision | Pourquoi |
|---|---|---|
| 2.1 | Diagnostic **léger** au démarrage (1 ou 2 questions), puis évaluation en continu. | Un questionnaire initial long décourage ; l'apprenant qui veut entrer dans le vif du sujet est suivi. |
| 2.2 | Pour les exercices : **indices progressifs** plutôt que la solution, sauf demande explicite après essai. | Faire produire l'apprenant est ce qui fait apprendre. |
| 2.3 | Un module n'est marqué « compris »/« maîtrisé » **que sur preuve** (bonne réponse, reformulation juste), jamais sur simple déclaration. | Une progression déclarative n'aurait aucune valeur pour le formateur. |
| 2.4 | **Rappel espacé** des notions notées comme difficultés. | Technique d'ancrage mémoriel éprouvée, rendue possible par le profil persistant. |
| 2.5 | Chaque réponse se termine par **une seule prochaine étape**, réponses courtes. | Format adapté à un widget de chat, évite les pavés. |
| 2.6 | Le formateur peut ajouter un **ton** et des **consignes spécifiques** par formation. | Chaque formation a ses règles (ex. formation réglementaire vs coaching). |
| 2.7 | Mention « Réponses générées par IA : elles peuvent contenir des erreurs » sous la zone de saisie. | Transparence envers l'apprenant. |

## 3. Choix techniques

| # | Décision | Pourquoi | Pour changer |
|---|---|---|---|
| 3.1 | **Claude via le SDK officiel Anthropic** (`@anthropic-ai/sdk`). | SDK officiel, streaming et outils intégrés. | — |
| 3.2 | Modèle par défaut **`claude-opus-5`**, effort **`medium`**, réflexion adaptative. | Opus est le plus capable pour la pédagogie (diagnostic, reformulation) ; l'effort `medium` garde des réponses rapides dans un chat. | `TA_MODEL` / `TA_EFFORT` dans `.env`. `claude-sonnet-5` ou `claude-haiku-4-5` réduisent le coût. |
| 3.3 | **Repli automatique activé** (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) quand le modèle le permet. | Si les filtres de sécurité du modèle déclinent une demande légitime, l'API la rejoue sur le modèle de repli recommandé au lieu de laisser l'apprenant sans réponse. Désactivé automatiquement pour les modèles qui ne le prennent pas en charge. | `modelCapabilities()` dans `agent-core.js`. |
| 3.4 | **Cache de prompt** automatique (`cache_control`) et prompt système **figé pendant une session** (le profil y est « photographié » au début ; les mises à jour passent par les résultats d'outils). | Le contenu de formation peut être long : le cache réduit fortement coût et latence. Un prompt stable est aussi exigé pour réutiliser les blocs de réflexion du modèle. | — |
| 3.5 | Si la formation est modifiée, le widget **démarre automatiquement une nouvelle session** (empreinte de version), le profil est conservé. | Conséquence de 3.4 : on ne change jamais le prompt d'une conversation en cours. | — |
| 3.6 | Les **outils s'exécutent dans le navigateur** ; le serveur est un relais sans état. | Le profil vit chez l'apprenant (1.7) ; le serveur reste simple et scalable, sans base de données. | — |
| 3.7 | **Serveur Node sans framework** (`node:http`), une seule dépendance (le SDK). | Installation minimale, facile à héberger partout, surface d'attaque réduite. | `server.js`. |
| 3.8 | **Widget = Web Component `<training-agent>`** en JavaScript pur, Shadow DOM, sans build ni dépendance. | S'intègre dans n'importe quel CMS/LMS avec 2 lignes, sans conflit de styles avec le site hôte. | `public/widget/training-agent.js`. |
| 3.9 | Deux affichages : **bulle flottante** (défaut) et **intégré à la page** (`mode="inline"`). | Couvre les deux usages courants (assistant permanent / espace de tutorat dédié). | Attribut `mode`. |
| 3.10 | **Streaming** des réponses (SSE entre serveur et widget). | Le texte s'affiche au fil de l'eau : indispensable pour le confort en chat. | — |
| 3.11 | Rendu **Markdown maison et sécurisé** (tout le HTML est échappé, liens `http(s)` uniquement). | Évite une dépendance et toute injection de HTML/JS dans la page hôte. | `public/core/markdown.js`. |
| 3.12 | Le « code de la page » à intégrer n'embarque **jamais la clé API** : elle reste sur le serveur. | Sécurité : une clé dans une page web est récupérable par n'importe qui. | — |

## 4. « Version utilisable sur navigateur »

| # | Décision | Pourquoi |
|---|---|---|
| 4.1 | Un **Studio web** (http://localhost:3000) pour créer/éditer une formation, la tester en direct, simuler plusieurs apprenants et copier le code d'intégration. | Tout se fait dans le navigateur, sans toucher au code ni au JSON. |
| 4.2 | Une **page de démo** qui imite un site de formation avec le widget intégré. | Montre concrètement le rendu final côté apprenant. |
| 4.3 | Un mode **« Clé API (test) »** dans le studio : le navigateur appelle directement l'API Anthropic avec la clé saisie (conservée seulement dans l'onglet). Le SDK est servi localement, avec repli sur un CDN si la page est hébergée statiquement. | Permet de tester un brouillon sans configurer le serveur. Clairement signalé comme réservé aux tests. |

## 5. Sécurité et coûts

| # | Décision | Pourquoi | Pour changer |
|---|---|---|---|
| 5.1 | **Limitation de débit** par IP (30 messages/minute par défaut) et limites de taille des conversations. | Protéger votre facture API contre les abus. | `RATE_LIMIT_PER_MIN`. |
| 5.2 | **CORS** configurable (`ALLOWED_ORIGINS`), ouvert (`*`) par défaut avec avertissement au démarrage. | Facilite les tests ; à restreindre à vos domaines en production. | `ALLOWED_ORIGINS`. |
| 5.3 | Édition des formations protégée par **`ADMIN_TOKEN`** ; sans jeton, autorisée **uniquement en accès local** (localhost, sans proxy). | Simple en local, sûr en production. | `ADMIN_TOKEN`. |
| 5.4 | L'API publique ne renvoie que les **informations publiques** d'une formation (titre, accueil, liste des modules), pas son contenu. | Le contenu complet n'est accessible qu'aux administrateurs. (Un apprenant peut toujours interroger le tuteur sur le contenu : c'est sa fonction.) | — |
| 5.5 | Le prompt précise que le contenu de formation et les messages de l'apprenant **ne peuvent pas modifier les règles** du tuteur ; le tuteur reste centré sur la formation. | Limite les détournements (« oublie tes consignes… »). | — |
| 5.6 | En cas de refus du modèle (après repli), le tour est **retiré de l'historique** et un message neutre est affiché. | La conversation reste valide et l'apprenant peut reformuler. | — |

## 6. Limites connues / pistes

- Le profil est lié au navigateur tant que votre plateforme ne le synchronise pas (événements prévus pour cela).
- Pas de tableau de bord formateur agrégé (il faudrait stocker les profils côté serveur) : prochaine étape naturelle.
- Formats de contenu importables dans le studio : texte (`.txt`, `.md`). Pour un PDF ou une vidéo, collez le texte ou la transcription.
- Les très longues conversations sont plafonnées (message invitant à démarrer une nouvelle session, le profil étant conservé).
- Les tests automatisés utilisent un faux client Claude : ils valident la mécanique (outils, streaming, interface) mais pas la qualité pédagogique des réponses, à évaluer sur de vraies sessions.

## 7. Version sans clé API (page publiée sur claude.ai)

Fichiers : `artifact/tuteur.src.html` (source), `artifact/build.mjs` (intègre les formations de `courses/`), `artifact/tuteur-claude.html` (page générée et publiée).

| # | Décision | Pourquoi | Pour changer |
|---|---|---|---|
| 7.1 | Le tuteur est publié comme **page claude.ai** qui appelle Claude **avec le compte de l'apprenant** (capacité `sample`). | C'est la seule façon d'utiliser Claude sans clé API : chaque apprenant consomme son propre quota claude.ai, vous ne payez rien. En contrepartie, chaque apprenant doit avoir un compte Claude et accepter la demande d'autorisation au premier message. | — |
| 7.2 | **Profil et conversation stockés dans le navigateur** de l'apprenant, pas dans la base de données partagée de claude.ai. | Utiliser cette base aurait rendu la page accessible seulement aux membres de votre organisation claude.ai, donc impossible à partager avec vos apprenants. | — |
| 7.3 | **Pas d'outils** : Claude renvoie son message suivi d'un bloc de données caché (repère `<<<ETAT>>>` puis JSON avec profil, progression, quiz), que la page lit. | Sur claude.ai, chaque appel d'outil ajoute un aller-retour payé par l'apprenant et plusieurs dizaines de secondes. Une seule réponse en streaming garde la conversation fluide. | `instructions()` et `applyState()` dans `tuteur.src.html`. |
| 7.4 | Réponses **« Approfondies » par défaut**, avec un bouton **« Rapides »**. | Le mode approfondi pense avant de répondre (meilleure pédagogie, 5 à 60 s d'attente). Le mode rapide répond presque tout de suite ; le choix est laissé à l'apprenant et mémorisé. | Valeur initiale de `state.tier`. |
| 7.5 | Les **40 derniers messages** seulement sont renvoyés à Claude ; le profil sert de mémoire longue. | La plateforme limite chaque requête à 64 Ko de texte. | `MAX_TURNS`. |
| 7.6 | Les formations sont **intégrées dans la page** ; un bouton « Importer… » charge un JSON du studio **dans le navigateur de la personne seulement**. | Une page publiée ne peut pas lire votre serveur. Pour qu'une formation soit visible de tous, ajoutez-la dans `courses/`, lancez `node artifact/build.mjs` et republiez la page (ou demandez-le à Claude Code). | — |
| 7.7 | La page est **privée à sa publication**. | Réglage par défaut de claude.ai : c'est vous qui choisissez avec qui la partager (menu « Partager » de la page). | Menu « Partager ». |
