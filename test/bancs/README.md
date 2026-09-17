# Bancs du pont vocal (Grok Voice au téléphone)

Outils de mesure du chantier « fins de phrase coupées et latence » (Palazzo, 16 et 17/09/2026), repris le 17/09 pour Dany (Motralec, service Railway `bridge`). Ils parlent à la vraie API de Grok, jamais à la ligne de production, et n'envoient aucun récap (le pont lancé par le banc n'a pas `N8N_RECAP_URL`). Les clés `XAI_API_KEY` et `OPENAI_API_KEY` sont lues dans le vault (`VAULT`, par défaut `C:/Users/msi/.secrets/api-keys.env`) et jamais affichées. Sorties dans `test/bancs/.sorties` (ignoré par git), ou `BANC_SORTIE`.

L'agent joué est celui de la production (`config-banc.mjs`) : prompt `prompt.motralec.txt`, voix `leo`, vitesse 1,15, réflexion `none`. `BANC_PROMPT`, `BANC_VOIX`, `BANC_VITESSE`, `BANC_REFLEXION` en jouent un autre. La voix du client (`fixtures/client-*.wav`, mono 8 kHz) se refait avec `node test/bancs/fabriquer-client.mjs --tout`.

| Banc | Ce qu'il tranche | Commande | Résultat du 17/09 (Dany) |
|---|---|---|---|
| `banc-appel-local.mjs` | Le pont ENTIER sur ce poste, un faux Twilio joue un appelant qui demande un devis (« Mmm » pendant une réponse, nom dit avec une pause, phrase dite par-dessus l'agent). Journal, dialogue du récap, enregistrement stéréo. `BANC_ECHO=0.35` ajoute l'écho d'un haut-parleur, `BANC_SERVEUR=<dossier>` joue un autre `server.js`. | `node test/bancs/banc-appel-local.mjs pont` (ou `grok`) | ancien `master` : latence médiane 2,25 s, répliques client décalées d'un tour dans le récap ; avec écho : 5,2 s, un blanc de 13 s, « vous êtes toujours là ? » parasite, ville perdue. Port : 2,0 s, dialogue dans l'ordre, sons par-dessus ignorés, identique avec écho |
| `banc-fin-question.mjs` | Grok avale-t-il la fin d'une réponse qui finit sur une question ? Audios gardés et fins transcrites. | `node test/bancs/banc-fin-question.mjs 4` | voix `leo` : 0 fin coupée sur 16 (Palazzo, voix `eve` : 27 sur 27) |
| `banc-vad-grok.mjs` | Retard du détecteur de fin de phrase de Grok selon seuil et silence. | `node test/bancs/banc-vad-grok.mjs 2` | Palazzo : fin annoncée 1,4 à 1,6 s après le dernier mot, quels que soient les réglages |
| `banc-manuel-tampon.mjs` | Grok arrête-t-il la réponse qu'il génère quand il entend le client ? | `node test/bancs/banc-manuel-tampon.mjs` | Palazzo : témoin 23,8 s d'audio ; « mmm » en direct 1,2 s ; « mmm » retenu puis envoyé 23,5 s |

Pour un appel RÉEL enregistré (Twilio `Record=true`, deux voies), la transcription horodatée se fait avec `node C:\Users\msi\.claude\scripts\timeline-appel.mjs <appel.wav>`. La doctrine qui découle de ces mesures est dans le skill `agent-voice`, `references/telephony-reception.md` § 7 bis.
