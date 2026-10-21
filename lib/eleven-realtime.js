// Eleven Realtime (20/10/2026) : jeton ephemere et adresse du WebSocket. L'API parle le protocole d'OpenAI Realtime
// (memes evenements), mais s'authentifie par un jeton court delivre contre la cle ElevenLabs.
// Doc : elevenlabs.io/docs/eleven-agents/guides/openai-realtime-compatibility et
// elevenlabs.io/docs/eleven-agents/api-reference/conversations/create-client-secret
//
// Ce que la sonde du 20/10/2026 a montre (voir references/latence-grok-eleven-telephone.md du skill agent-voice) :
// - turn_detection : seuls `semantic_vad` et `null` (tours decides par le client) ; `server_vad` est refuse (422) ;
// - audio/pcmu (mu-law 8 kHz) accepte en entree et en sortie ;
// - la voix est un identifiant de voix ElevenLabs (bibliotheque ou clone) ;
// - `session.update` est accepte des l'ouverture, avant meme `session.created` ;
// - un appel d'outil arrive dans une reponse SEPARATE de la phrase parlee (message, puis function_call) ;
// - `response.done` ne renvoie aucun `usage` (null) : le cout par jetons ne se lit pas sur la session.
export async function jetonEleven({ cle, session, base = "https://api.elevenlabs.io", secondes = 600 }) {
  const r = await fetch(`${base}/v1/convai/realtime/client_secrets`, {
    method: "POST",
    headers: { "xi-api-key": cle, "content-type": "application/json" },
    body: JSON.stringify({ session, expires_after: { anchor: "created_at", seconds: secondes } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.value) throw new Error(`jeton Eleven refuse (HTTP ${r.status}) ${JSON.stringify(j).slice(0, 240).split(cle).join("***")}`);
  return j.value;
}

export function urlRealtimeEleven(modele, base = "https://api.elevenlabs.io") {
  return `${base.replace(/^http/, "ws")}/v1/convai/realtime?model=${encodeURIComponent(modele)}`;
}

// Transcription CUMULATIVE (banc du 20/10/2026) : apres un commit, le tampon d'entree d'Eleven n'est pas vide (un
// input_audio_buffer.clear n'y change rien, avant ou apres le tour suivant) et la transcription de chaque message du client
// reprend tout ce que le client a dit depuis le decroche (« J'habite a Herblay. » puis « J'habite a Herblay.Oui, c'est bien
// ca. »). La latence de transcription reste plate (340 a 470 ms sur 78 s d'audio cumule). Cette fabrique renvoie une
// fonction qui compare au texte cumule precedent, mot a mot (casse, accents et ponctuation neutralises), et ne rend que la
// suite. Un mot = une suite de lettres ou de chiffres : Eleven recolle les phrases sans espace (« devis.Mohamed »). Si
// Eleven a retouche le debut (moins de 60 % des mots precedents retrouves), on garde ce qui depasse l'ancien total.
export function creerPartNouvelle() {
  let precedent = [];
  const mots = (s) => [...String(s).matchAll(/[\p{L}\p{N}]+/gu)]
    .map((m) => ({ i: m.index, n: m[0].normalize("NFD").replace(/\p{M}/gu, "").toLowerCase() }));
  return (texte) => {
    const cur = mots(texte);
    let k = 0;
    while (k < precedent.length && k < cur.length && precedent[k].n === cur[k].n) k++;
    const debut = k >= precedent.length * 0.6 ? k : Math.min(precedent.length, cur.length);
    precedent = cur;
    return debut >= cur.length ? "" : String(texte).slice(cur[debut].i).trim();
  };
}

// Balises de jeu glissees dans le texte des reponses (« [friendly] Pourriez-vous... ») : ni dialogue, ni recap.
// Le modele ecrit aussi parfois le nom d'un outil ou d'un argument entre crochets au lieu de l'appeler (« [chiffrer_commande] »,
// « [heure_souhaitee] », 1 appel sur ~30 au banc de Chiara) : meme traitement, rien de tout cela ne se dit ni ne s'enregistre.
const BALISE_RE = /\s*\[[A-Za-z][A-Za-z _-]{1,39}\]\s*/g;
export const sansBalisesEleven = (s) => String(s).replace(BALISE_RE, " ");
