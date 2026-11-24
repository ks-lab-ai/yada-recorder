.PHONY: install consent dev build install-app test e2e test-server spike clean

APP := desktop/dist/Yada Recorder-darwin-arm64/Yada Recorder.app

install: consent    ## Dépendances de l'app desktop + message de consentement
	cd desktop && npm install

consent:            ## Génère le message audio de consentement (voix macOS) pour l'extension
	@test -f extension/assets/consent-en.wav || say -v Samantha -r 175 -o extension/assets/consent-en.wav --data-format=LEI16@16000 "This call is recorded for quality and note-taking purposes."

dev: install        ## Lance l'app en mode dev (lit .env à la racine)
	cd desktop && npx electron .

build: install      ## Construit et signe (ad hoc) Yada Recorder.app
	cd desktop && npm run build

install-app: build  ## Copie l'app dans /Applications et la lance
	rm -rf "/Applications/Yada Recorder.app"
	cp -R "$(APP)" /Applications/
	open "/Applications/Yada Recorder.app"

test:               ## Tests unitaires (pipeline, serveur, providers, Trousseau)
	cd desktop && npm test

e2e: consent       ## Faux appel WebRTC dans Chrome headless, deux scénarios
	node tools/e2e/run.mjs
	node tools/e2e/run.mjs --ringback

test-server:        ## Étape 2 sans l'app : reçoit les chunks et écrit tools/out/<id>.webm
	node tools/test-server.mjs

clean:              ## Supprime node_modules et le build (libère ~400 Mo)
	rm -rf desktop/node_modules desktop/dist tools/out
