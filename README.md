# Yada Recorder

Petite app Mac avec un gros bouton **Enregistrer / Terminer** pour enregistrer ses appels (Yadaphone, Meet, Zoom, n'importe quoi).

- Capte le son du Mac (l'appel) et le micro, en stéréo : gauche = toi, droite = l'interlocuteur. Aucun accès à l'écran.
- À la fin : envoie le fichier `.m4a` dans Supabase (bucket privé `call-recordings`), ajoute une ligne dans la table `calls`, puis supprime la copie locale.
- Chaque enregistrement porte le prénom de la session Mac (`recorded_by`) et est rangé dans un dossier à ce nom : `louis/2026/11/<id>.m4a`.
- Sans connexion, le fichier attend sur le Mac et repart tout seul (essai toutes les minutes).
- À la fin de l'appel, **transcript affiché dans l'app** avec un bouton **Copier** (Moi / Interlocuteur, horodaté). Transcription faite sur le Mac par la reconnaissance vocale d'Apple, hors ligne, sans compte. Langue : English par défaut, Français, ou Auto.

## Installer

Prérequis : macOS 15 ou plus (capture du son système Core Audio : macOS 14.4+), outils de ligne de commande Xcode (`xcode-select --install`).

```bash
git clone https://github.com/ks-lab-ai/yada-recorder.git ~/Documents/yada-recorder
cd ~/Documents/yada-recorder
echo 'SUPABASE_URL=https://<projet>.supabase.co' > mac/config.env
echo 'SUPABASE_KEY=<clé publique sb_publishable_…>' >> mac/config.env
./mac/build.sh && cp -R "mac/build/Yada Recorder.app" /Applications/
open "/Applications/Yada Recorder.app"
```

Au premier lancement, l'app demande **Micro** et **Reconnaissance vocale** ; au premier enregistrement, macOS demande **Enregistrement des sons du système** (pas l'écran : l'app ne capte que le son, via Core Audio). Si la dictée hors ligne en français ou en anglais n'est pas installée, elle ouvre directement Réglages Système > Clavier > Dictée. Tant que quelque chose manque, un encadré « À régler une fois » l'indique avec un bouton Ouvrir.

Sans `mac/config.env`, l'app demande l'URL et la clé au premier lancement (gardées dans le Trousseau).

## Supabase

Appliquer dans l'éditeur SQL, dans l'ordre :

1. [`001_init.sql`](supabase/migrations/001_init.sql) : table `calls`, bucket privé `call-recordings`, RLS.
2. [`002_mac_recorder_upload.sql`](supabase/migrations/002_mac_recorder_upload.sql) : la clé publique peut seulement **déposer** un fichier audio et ajouter une ligne. Elle ne peut ni lire, ni modifier, ni supprimer.
3. [`003_recorded_by.sql`](supabase/migrations/003_recorded_by.sql) : colonne `recorded_by` (qui a enregistré).

Pour écouter : Dashboard Supabase > Storage > `call-recordings`. Pour la liste : Table Editor > `calls`.

## Auto-test

```bash
"mac/build/Yada Recorder.app/Contents/MacOS/Yada Recorder" --selftest-writer /tmp/test.m4a
```

Écrit 3 s de stéréo synthétique (300 Hz à gauche, 1200 Hz à droite) par le même code que l'enregistrement réel, sans micro ni autorisation.

```bash
open -n -a "/Applications/Yada Recorder.app" --args --selftest-transcribe appel.m4a /tmp/transcript.txt auto
```

Transcrit un fichier stéréo existant (gauche = moi, droite = interlocuteur) avec le même code que l'app.
