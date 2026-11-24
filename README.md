# Yada Recorder

## Version simple : l'app Mac (recommandée)

Un gros bouton **Enregistrer / Terminer**. L'app capte le son du Mac (l'appel) et ton micro, en stéréo (gauche = toi, droite = l'appel), puis à la fin envoie le fichier `.m4a` dans Supabase (bucket `call-recordings`, une ligne dans la table `calls`) et supprime la copie locale. Si l'envoi échoue, le fichier attend et repart tout seul. Marche avec Yadaphone, Meet, Zoom, n'importe quoi.

```bash
git clone https://github.com/ks-lab-ai/yada-recorder.git ~/Documents/yada-recorder
cd ~/Documents/yada-recorder
echo 'SUPABASE_URL=https://<ton-projet>.supabase.co' > mac/config.env
echo 'SUPABASE_KEY=sb_publishable_...' >> mac/config.env
./mac/build.sh && cp -R "mac/build/Yada Recorder.app" /Applications/
```

Prérequis : macOS 15+, outils de ligne de commande Xcode (`xcode-select --install`). Supabase : appliquer `supabase/migrations/001_init.sql` puis `002_mac_recorder_upload.sql` (la clé publique peut seulement déposer des fichiers et des lignes, jamais lire, modifier ni supprimer).

Au premier clic, macOS demande deux autorisations : **Micro** et **Enregistrement de l'écran et de l'audio système**. Accepte les deux (puis relance l'app si macOS le demande).

---

## Version complète : extension Chrome + app Electron (enregistrement automatique, transcription, résumés)

Chaque appel passé sur yadaphone.com est enregistré en stéréo (gauche = moi, droite = interlocuteur), envoyé dans Supabase, transcrit (Deepgram nova-3 par défaut), résumé par Claude, puis retrouvable depuis un bouton « Transcripts » dans la nav de Yadaphone. Rien à lancer à la main.

```
yadaphone.com (Chrome)
  inject.js   monde MAIN, document_start : patch RTCPeerConnection, mix stéréo, MediaRecorder, chunks de 5 s
  bridge.js   bouton Transcripts, pastille d'état, relais
  background  service worker : outbox IndexedDB, envoi en ordre, retry chaque minute
        │ HTTP 127.0.0.1:47311 + token
        ▼
Yada Recorder.app (menubar, Electron)
  serveur local → cache des chunks → pipeline : upload Storage → transcription → résumé Claude → table calls → purge locale
  fenêtre Transcripts : liste, recherche plein texte, détail, lecteur (URL signée), copier
```

## 1. Supabase (5 min, gratuit)

1. Crée un projet sur [supabase.com](https://supabase.com) (région eu-west-1 conseillée).
2. SQL Editor > colle le contenu de [supabase/migrations/001_init.sql](supabase/migrations/001_init.sql) > Run. Ça crée la table `calls`, la recherche plein texte FR/EN sans accents (`search_calls`), le bucket privé `call-recordings` et la RLS (aucune policy : seule la clé secrète de l'app accède aux données, la clé publique ne voit rien).
3. Note l'URL du projet et la **clé secrète** : Project Settings > API Keys > Secret key (`sb_secret_…`).

Chacun son projet : avec un projet partagé et la même clé, tout le monde verrait les appels de tout le monde.

Il te faut aussi une clé [Deepgram](https://console.deepgram.com) (transcription, crédit offert à l'inscription) et une clé [Anthropic](https://console.anthropic.com) (résumés, facultative).

## 2. App desktop

```bash
git clone https://github.com/ks-lab-ai/yada-recorder.git ~/Documents/yada-recorder
cd ~/Documents/yada-recorder
make install-app
```

Prérequis : un Mac Apple Silicon, Node.js 20+ (`brew install node`) et les outils de ligne de commande Xcode (`xcode-select --install`).

Construit `Yada Recorder.app`, la copie dans `/Applications` et la lance. Au premier lancement les Réglages s'ouvrent : URL Supabase, clé secrète, clé Deepgram (ou ElevenLabs), clé Anthropic. Les clés vont dans le Trousseau macOS (service « Yada Recorder »), jamais en clair sur le disque. « Tester les connexions » vérifie tout.

L'app vit dans la barre des menus (pas d'icône Dock) et se lance au démarrage du Mac (décochable dans le menu). L'app n'est pas notarisée : si macOS bloque la première ouverture, clic droit > Ouvrir.

Dev : `cp .env.example .env`, remplir, puis `make dev`.

## 3. Extension Chrome

1. `chrome://extensions` > activer le **Mode développeur**.
2. **Charger l'extension non empaquetée** > dossier `extension/`.
3. Popup de l'extension > **Appairer avec l'app** > accepter dans la fenêtre de l'app.
4. Recharger l'onglet Yadaphone.

Sur yadaphone.com, une pastille en haut à droite indique l'état en permanence :

| Pastille | Sens |
|---|---|
| verte « Recorder actif » | tout est prêt |
| orange « app hors ligne » / « appairage requis » | les appels sont quand même enregistrés et gardés dans Chrome jusqu'au retour de l'app |
| rouge « ● REC 1:23 » | appel en cours d'enregistrement |
| rouge « Recorder inactif » | le patch n'est pas chargé : recharger la page |

Clic sur la pastille ou sur **Transcripts** dans la nav : ouvre la fenêtre de l'app (Maj+clic : dans un onglet Chrome).

**Message de consentement** (popup ou Réglages) : par défaut joué sur les numéros +1, dès que l'interlocuteur décroche (détection de la première parole, distincte de la sonnerie), puis le micro est rétabli. Le message est aussi enregistré sur ton canal.

## 4. Tester

```bash
make test   # 8 tests : providers, pipeline et retry, sécurité du serveur, Trousseau
make e2e    # faux appel WebRTC dans un Chrome headless jetable, vrai serveur + pipeline
```

`make e2e` vérifie : webm/opus stéréo, 300 Hz à gauche (moi) et 1200 Hz à droite (interlocuteur), message envoyé dans la ligne après le décroché et pas pendant la sonnerie US, numéro lu dans le DOM, purge du cache local.

### Test avec un vrai appel (à faire en premier)

Le seul point non vérifiable sans toi : le comportement réel du SDK Twilio de Yadaphone.

**Spike seul (2 min, n'enregistre rien)** : charger `spike/` comme extension non empaquetée (à la place de `extension/`), ouvrir yadaphone.com > Phone, ouvrir la console (Cmd+Option+J), appeler un numéro qui décroche (ton portable). Attendu dans la console, lignes `[yadarec-spike]` :

1. `patch installé` au chargement de la page ;
2. `getUserMedia` puis `PC#1 créé`, `addTrack audio` (ou `addTransceiver`) ;
3. `PC#1 event track : audio` ;
4. `connectionState = connected` ;
5. toutes les 2 s : `PC#1 DISTANT : RMS 0.0xxx` qui monte quand ton portable parle, `LOCAL` qui monte quand tu parles ;
6. `WS =>  invite …` avec le numéro composé ;
7. au raccroché : `close() appelé` ou `connectionState = closed`.

Si le RMS distant reste à 0.0000 pendant que quelqu'un parle, ou si aucune `PC` n'est créée, envoie-moi les logs.

**Pipeline complet** : avec `extension/`, popup > Avancé > cocher « Logs console » pour voir les lignes `[yadarec]`. Après le raccroché, l'appel apparaît dans Transcripts en 30 s à 2 min selon la durée.

**Sans l'app** : `make test-server`, coller le token `dev-token` dans le popup (Avancé), passer un appel : `tools/out/<id>.webm` doit être stéréo (`ffprobe` affiche `stereo`).

## Choix et limites

- **Deepgram nova-3** recommandé : multichannel natif (un canal par voix, donc pas de diarisation à deviner), FR/EN mélangés avec `language=multi`, environ 0,005 $/min par canal, rapide. ElevenLabs Scribe (`scribe_v2`) reste sélectionnable dans les Réglages.
- **Électron plutôt que Tauri** : pas de toolchain Rust à installer, tout le pipeline en Node. L'app pèse environ 250 Mo ; `make clean` libère le reste après installation.
- **Résumé** : `claude-sonnet-5-5`, effort moyen, en français, avec repli serveur automatique si le modèle refuse. Sans clé Anthropic, l'appel est transcrit sans résumé.
- **Rien ne se perd** : chaque chunk est écrit dans IndexedDB avant envoi ; l'app garde l'appel en local tant qu'il n'est pas dans Supabase ; retry à 1 min, 5 min, 15 min, 1 h puis toutes les 3 h. Onglet fermé en plein appel : les 5 dernières secondes au plus sont perdues, l'appel est clos proprement.
- **Audio local** : supprimé dès que l'audio et la ligne sont dans Supabase.
- `host_permissions` contient aussi `http://127.0.0.1/*` : c'est ce qui permet au service worker de parler à l'app locale. Le script ne s'injecte que sur yadaphone.com.
- Le nom du contact est lu dans le DOM près du numéro composé (heuristique) ; sinon l'appel affiche le numéro.
