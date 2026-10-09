// REPONSE PARASITE (09/10/2026, banc de Dany relie a DaleVoz) : gpt-realtime rend parfois une reponse entiere reduite
// au nom d'un de ses canaux internes (« analysis »), deux fois de suite, et ElevenLabs la prononcait au telephone.
// Le pont retient le debut de chaque reponse tant qu'il peut encore devenir un de ces mots, et n'envoie jamais a la
// lecture une reponse qui n'est QUE ce mot (voir server.js, envoyerTexteLecture et terminerReponse).
export const PARASITES = ["analysis", "commentary", "final", "assistant"];
export const PARASITE_RE = new RegExp(`^(${PARASITES.join("|")})[.!]?$`, "i");

// Le debut d'une reponse peut-il encore devenir un mot parasite ? Un debut vide (espaces seulement) le peut encore :
// le relacher fermerait la retenue pour toute la reponse, et un « analysis » au morceau suivant serait dit.
export function peutEtreParasite(texte) {
  const s = String(texte).trim().toLowerCase().replace(/[.!]$/, "");
  return s.length === 0 || PARASITES.some((p) => p.startsWith(s));
}
