# voice-reception-bridge

Pont **Twilio Media Streams ↔ xAI Grok Voice** pour un agent vocal de **réception téléphonique** (décroche hors horaires, qualifie, envoie un récap mail). Remplace l'approche Voiceflow + Twilio.

Skill de référence : `agent-voice-widget` (mode Téléphonie), `references/telephony-reception.md`.

## Flux
```
Appel → Twilio <Connect><Stream url="wss://<railway>/twilio"> → ce serveur
        mu-law 8kHz ⇄ PCM16  ⇄  Grok Voice WS
        → au raccrochage (stop Twilio) : POST {dialog, phone} → n8n → récap mail
```

## Fichiers
- `server.js` : le pont (serveur WS Twilio + client WS Grok + capture transcript + recap).
- `lib/audio.js` : codec G.711 mu-law + resampling.
- `.env.example` : variables (clé xAI, voix, rate, prompt agent, URL n8n).
- `twiml-example.xml` : le TwiML à mettre dans le numéro Twilio.

## Déploiement Railway
1. `railway up` (ou via le dashboard) dans ce dossier.
2. Variables : `XAI_API_KEY`, `GROK_MODEL`, `GROK_VOICE`, `GROK_RATE`, `AGENT_LANG`, `AGENT_NAME`, `BUSINESS_NAME`, `BUSINESS_DESC`, `N8N_RECAP_URL`.
3. Générer un domaine Railway → mettre `wss://<domaine>/twilio` dans le TwiML du numéro Twilio.

## Tours de parole (17/09/2026)
Par défaut le pont décide lui-même de la fin des tours (`TOURS=pont`, `FIN_DE_TOUR_MS=1000`) et retient la voix du client pendant que Grok génère : Grok arrête net une réponse dès qu'il entend l'appelant. Sans `BARGE_IN=1`, le demi-duplex anti-écho reste : rien n'est écouté tant que l'agent est audible. `TOURS=grok` remet l'ancien détecteur sans toucher au code. `RECAP_EXCLURE` liste les numéros de test qui n'envoient pas de récap. Mesures et bancs : `test/bancs/README.md`.

## À dérisquer en premier
**Le sample rate Grok** : Twilio = mu-law 8kHz, Grok = PCM16 à `GROK_RATE`. Tester `GROK_RATE=8000` (pas de resampling). Si l'agent reste muet (le VAD Grok ne déclenche pas), passer à `GROK_RATE=24000` (resampling activé automatiquement).

## Local
```
npm install
XAI_API_KEY=... npm start   # écoute sur :8080, /twilio
```
