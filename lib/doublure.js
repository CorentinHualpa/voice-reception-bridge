// DOUBLURE : une seconde session Grok qui repond a la place de la premiere quand celle-ci bloque.
//
// Le probleme. Environ une reponse sur cinq, Grok met 2,7 a 3,7 s avant son premier son, et le retard est au
// DEMARRAGE de la generation chez xAI : le premier texte arrive aussi tard que le premier son, donc rien de ce
// que fait le pont (relance, format audio, vitesse, modele, longueur de la consigne, taille de l'historique)
// n'y change quoi que ce soit. Tout cela a ete mesure et ecarte (bancs banc-pics-grok.mjs et
// banc-parades-pics.mjs, 17/09/2026). Le « Mmm » d'attente, qui masquait le blanc, a ete rejete a l'ecoute.
//
// Ce qui marche. Le blocage est propre a UNE SESSION, pas a la charge de xAI. Banc du 17/09, deux sessions
// recevant la meme question au meme instant, 24 tours : A 0 pic au-dela de 2 s (max 1596 ms), B 2 pics
// (max 2418 ms), et la PREMIERE DES DEUX 0 pic, max 1007 ms, p90 986 ms. Jamais les deux lentes ensemble.
// Demander la meme reponse a une seconde session coupe donc la queue au lieu de la masquer.
//
// Comment elle reste coherente. Les deux sessions doivent avoir le meme historique, alors qu'une seule entend
// le client. `conversation.item.create` avec `role: "assistant"` est accepte par l'API (accuse
// `conversation.item.added`, pas `.created`) et le modele le relit fidelement : on lui a fait dire « votre
// commande porte le numero 4712, a retirer a 20h05 », elle l'a redit mot pour mot au tour suivant. La doublure
// recoit donc, en TEXTE seulement : la transcription du client (que la primaire produit) et ce que la primaire
// a dit. Zero audio d'entree, donc zero minute d'audio facturee tant qu'elle ne parle pas.
//
// Ce qu'elle ne fait pas. Elle n'execute aucun outil : si elle en demande un, on la jette et on attend la
// primaire, qui a les vrais outils et dont le pont sait derouler le cycle. La doublure ne sert donc que sur les
// tours de pure conversation, qui sont la majorite.
import { WebSocket } from "ws";

export function creerDoublure({ cle, modele, config, etiquette = "", sur = {} }) {
  let ws = null, prete = false, enCours = null, ferme = false;
  const enAttente = [];   // items poses avant que la session soit prete
  const log = (m) => console.log(`[doublure] ${m}${etiquette ? " " + etiquette : ""}`);
  log(`creee (modele ${modele}, ${(config.instructions || "").length} car de consigne, ${(config.tools || []).length} outils)`);

  function envoyer(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function poser(item) {
    if (!prete) { enAttente.push(item); return; }
    envoyer({ type: "conversation.item.create", item });
  }

  return {
    get prete() { return prete; },
    // Occupee = une reponse est en route ET sert encore a quelque chose. Une reponse abandonnee reste en
    // memoire jusqu'a son `response.done` (pour jeter ses deltas), mais elle n'est plus a annuler : sans ce
    // filtre, chaque paquet entrant renvoyait un `response.cancel` et xAI repondait « no active response ».
    get occupee() { return Boolean(enCours) && !enCours.abandonnee; },
    // Historique : ce que le client a dit (transcription de la primaire).
    client(texte) {
      const t = (texte || "").trim();
      if (t) poser({ type: "message", role: "user", content: [{ type: "input_text", text: t }] });
    },
    // Historique : ce que la primaire a dit. La doublure doit le prendre pour sien, sinon elle le redirait.
    agent(texte) {
      const t = (texte || "").trim();
      if (t) poser({ type: "message", role: "assistant", content: [{ type: "output_text", text: t }] });
    },
    // Demande une reponse. `sur.son(ulaw)`, `sur.texte(delta)`, `sur.outil()`, `sur.finie(statut)` suivent.
    demander(marque) {
      if (!prete || enCours || ferme) return false;
      enCours = { marque, demandeeA: Date.now(), octets: 0, texte: "", outil: false, abandonnee: false };
      envoyer({ type: "response.create" });
      return true;
    },
    // La primaire a parle la premiere, ou le client a repris : on jette ce que la doublure produit.
    abandonner(pourquoi) {
      if (!enCours) return;
      enCours.abandonnee = true;
      envoyer({ type: "response.cancel" });
      log(`abandon (${pourquoi})`);
    },
    // Ce que la doublure a effectivement dit : a reinjecter dans la primaire pour qu'elle ne le redise pas.
    get texteEnCours() { return enCours ? enCours.texte : ""; },
    get marqueEnCours() { return enCours ? enCours.marque : null; },
    get octetsEnCours() { return enCours ? enCours.octets : 0; },

    async ouvrir() {
      let token;
      try {
        const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
          method: "POST",
          headers: { Authorization: `Bearer ${cle}`, "Content-Type": "application/json" },
          body: JSON.stringify({ expires_after: { seconds: 600 } }),
        }).then((r) => r.json());
        token = tok.value || tok.secret || tok.token || (tok.client_secret && tok.client_secret.value);
      } catch (err) { log(`token impossible : ${err.message}`); return false; }
      if (!token) { log("pas de token"); return false; }
      ws = new WebSocket(`wss://api.x.ai/v1/realtime?model=${modele}`, [`xai-client-secret.${token}`]);
      ws.on("open", () => envoyer({ type: "session.update", session: config }));
      ws.on("error", (err) => log(`ws erreur : ${err.message}`));
      ws.on("close", () => { prete = false; if (!ferme) log("ws fermee"); });
      ws.on("message", (raw) => {
        let e;
        try { e = JSON.parse(raw.toString()); } catch { return; }
        switch (e.type) {
          case "ping":
            envoyer({ type: "pong", ...(e.event_id ? { event_id: e.event_id } : {}) });
            break;
          case "session.updated":
            if (!prete) {
              prete = true;
              for (const item of enAttente.splice(0)) envoyer({ type: "conversation.item.create", item });
              log("prete");
            }
            break;
          case "response.output_audio.delta":
            if (!enCours || !e.delta) break;
            if (enCours.abandonnee) break;
            enCours.octets += 1;
            sur.son?.(Buffer.from(e.delta, "base64"), enCours);
            break;
          case "response.output_audio_transcript.delta":
            if (enCours && !enCours.abandonnee && e.delta) enCours.texte += e.delta;
            break;
          case "response.function_call_arguments.done":
            // Elle veut un outil : elle ne sait pas l'executer, la primaire si. On la laisse tomber.
            if (enCours) { enCours.outil = true; sur.outil?.(e.name, enCours); }
            break;
          case "response.done": {
            const fini = enCours;
            enCours = null;
            if (fini) sur.finie?.(e.response?.status || "?", fini);
            break;
          }
          case "error": {
            log(`erreur ${JSON.stringify(e.error || e).slice(0, 200)}`);
            // xAI repond parfois `internal_error` a un `response.create` (incident passager constate le
            // 17/09 : trois demandes de suite sur un appel, aucune sur le suivant). Sans cela, la reponse
            // resterait « en cours » a jamais et la doublure ne serait plus jamais demandee de l'appel.
            const fini = enCours;
            enCours = null;
            if (fini) sur.finie?.("error", fini);
            break;
          }
        }
      });
      return true;
    },
    fermer() { ferme = true; prete = false; try { ws?.close(); } catch {} },
  };
}
