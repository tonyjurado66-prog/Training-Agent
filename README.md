# Tuteur IA adaptatif pour formations en ligne

Un agent conversationnel propulsé par **Claude** (Anthropic) qui adapte une formation à chaque apprenant :

- il **diagnostique** le niveau, les objectifs et la façon d'apprendre de l'apprenant ;
- il **adapte** ses explications (vocabulaire, profondeur, exemples, rythme) et la difficulté des exercices ;
- il **vérifie la compréhension** avec des quiz interactifs et des questions ouvertes ;
- il **mémorise** le profil et la progression par module d'une session à l'autre ;
- il fonctionne avec **n'importe quelle formation** : il suffit de décrire la formation (titre, objectifs, modules, contenu) dans le studio ou dans un fichier JSON ;
- il s'**intègre dans n'importe quel site** (WordPress, Moodle, Wix, Webflow, LMS maison…) avec deux lignes de code.

## Démarrage rapide (dans votre navigateur)

Prérequis : [Node.js](https://nodejs.org) 22 ou plus et une clé API Anthropic ([console.anthropic.com](https://console.anthropic.com)).

```bash
npm install
cp .env.example .env        # puis collez votre clé dans ANTHROPIC_API_KEY
npm start
```

Ouvrez ensuite :

| Page | Adresse | À quoi elle sert |
|---|---|---|
| **Studio** | http://localhost:3000/ | Créer/modifier une formation, la tester en direct, récupérer le code d'intégration |
| **Démo** | http://localhost:3000/demo.html | Un faux site de formation avec le tuteur intégré (2 formations d'exemple) |

Deux formations d'exemple volontairement très différentes sont fournies dans `courses/` :
une formation technique (*Excel : tableaux croisés dynamiques*) et une formation de savoir-être (*Prendre la parole en public*).

### Tester sans configurer de clé sur le serveur

Le studio a un mode **« Clé API (test) »** : vous collez votre clé Anthropic dans la page et le navigateur appelle directement l'API.
Pratique pour essayer un brouillon de formation, **mais réservé à vos tests** : la clé est visible par quiconque utilise la page. Pour vos apprenants, utilisez toujours le mode serveur.

### Sans clé API : la version publiée sur claude.ai

Le dossier `artifact/` contient une version du tuteur publiée comme page claude.ai. Claude y est appelé **avec le compte de chaque apprenant** : pas de clé API ni de serveur, mais chaque apprenant doit avoir un compte Claude et autoriser la page au premier message.

- Pour y ajouter vos formations : placez le JSON dans `courses/`, lancez `node artifact/build.mjs`, puis republiez `artifact/tuteur-claude.html`.
- La page est privée tant que vous ne la partagez pas (menu « Partager » sur claude.ai).

## Créer votre formation

1. Ouvrez le studio, cliquez sur **+ Nouvelle formation**.
2. Renseignez le titre, le public, les objectifs, puis ajoutez les modules (vous pouvez importer le contenu d'un module depuis un fichier `.txt`/`.md` : support de cours, transcription de vidéo, notes…).
3. Ajoutez si besoin des **consignes au tuteur** (ex. « tutoyer l'apprenant », « ne jamais donner la solution des exercices notés »).
4. Cliquez sur **Enregistrer sur le serveur** : la formation est écrite dans `courses/<identifiant>.json` et testable immédiatement dans l'aperçu.

Vous pouvez aussi écrire directement le fichier JSON :

```json
{
  "id": "ma-formation",
  "title": "Titre de la formation",
  "language": "fr",
  "audience": "Public visé",
  "description": "Résumé",
  "objectives": ["Objectif 1", "Objectif 2"],
  "prerequisites": ["Prérequis"],
  "tone": "Ton souhaité",
  "welcome": "Message d'accueil affiché à l'ouverture",
  "instructions": "Consignes pédagogiques spécifiques",
  "modules": [
    { "id": "module-1", "title": "Titre du module", "objectives": ["..."], "content": "Contenu du cours..." }
  ]
}
```

Seul `title` est obligatoire : sans modules, le tuteur structure lui-même la progression à partir des objectifs.

## Intégrer le tuteur à votre site

Le studio génère le code (étape 4). Il ressemble à ceci :

```html
<script type="module" src="https://VOTRE-SERVEUR/widget/training-agent.js"></script>
<training-agent
  course="excel-tableaux-croises"
  endpoint="https://VOTRE-SERVEUR"
  learner-id="IDENTIFIANT_APPRENANT"
  accent="#4f46e5">
</training-agent>
```

| Attribut | Rôle |
|---|---|
| `course` | Identifiant de la formation |
| `endpoint` | Adresse du serveur de l'agent (par défaut : celle d'où est chargé le script) |
| `mode` | `floating` (bulle en bas de page, par défaut) ou `inline` (intégré dans la page ; donnez-lui une hauteur) |
| `learner-id` | Identifiant de l'apprenant sur votre plateforme : sépare les profils sur un même navigateur |
| `accent` | Couleur principale |
| `label` | Titre affiché (par défaut : titre de la formation) |
| `position` | `right` ou `left` (mode flottant) |
| `theme="light"` | Force le thème clair (sinon suit le thème du système) |

### Synchroniser avec votre LMS

Le profil (niveau, objectifs, points forts, difficultés, progression par module, score aux quiz) est stocké dans le navigateur de l'apprenant.
Pour le conserver côté plateforme (changement d'appareil, tableau de bord formateur…) :

```js
const agent = document.querySelector("training-agent");
agent.addEventListener("training-agent:profile", (e) => {
  // e.detail = { courseId, learnerId, profile } → envoyez-le à votre back-office
});
agent.setProfile(profilSauvegardé);   // réinjecte un profil au chargement de la page
```

Autres méthodes : `getProfile()`, `newSession()`, `clearData()`, `open()`, `close()`. L'événement `training-agent:turn` fournit l'historique après chaque échange.

## Mettre en production

1. Hébergez le serveur (VPS, Render, Railway, Fly.io, Docker…) derrière HTTPS : `npm install --omit=dev && npm start`.
2. Définissez dans l'environnement : `ANTHROPIC_API_KEY`, `ADMIN_TOKEN` (protège l'édition des formations), `ALLOWED_ORIGINS=https://www.votre-site.fr` (sites autorisés à utiliser l'agent) et, si besoin, `RATE_LIMIT_PER_MIN`.
3. Collez le code d'intégration dans vos pages de formation.

Toutes les variables sont documentées dans [`.env.example`](.env.example).

## Architecture

```
public/
  core/agent-core.js      prompt pédagogique, outils, profil apprenant, paramètres Claude (partagé navigateur/serveur)
  core/agent-runner.js    boucle agentique : appel Claude → exécution des outils → relance
  core/transports.js      connexion via le serveur (SSE) ou directe (SDK Anthropic dans le navigateur)
  core/markdown.js        rendu Markdown sécurisé des réponses
  widget/training-agent.js  composant web <training-agent> (Shadow DOM, aucune dépendance)
  index.html, studio.*    studio de création / test
  demo.html               exemple d'intégration
server.js                 API (/api/chat en streaming, /api/courses), fichiers statiques
courses/*.json            formations
test/                     tests (node --test)
```

Fonctionnement d'un échange :

1. Le widget envoie l'historique de la conversation et l'instantané du profil au serveur.
2. Le serveur construit le prompt (méthode pédagogique + contenu de la formation + profil) et interroge Claude en streaming.
3. Claude répond et peut appeler trois outils exécutés dans le navigateur :
   `update_learner_profile` (mémoire de l'apprenant), `record_progress` (avancement par module, sur preuve), `present_quiz` (QCM interactif).
4. Le widget exécute l'outil, met à jour le profil et renvoie le résultat à Claude, qui poursuit sa réponse.

## Tests

```bash
npm test
```

Les tests couvrent le cœur (prompt, outils, validation) et le serveur (streaming, CORS, administration, fichiers statiques) avec un faux client Claude : ils ne consomment aucun crédit API.

## Décisions de conception

Les choix faits pendant la conception sont détaillés dans [`décisions.md`](décisions.md).
