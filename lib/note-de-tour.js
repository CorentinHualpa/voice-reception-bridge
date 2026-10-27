// Note de tour pour Eleven Realtime (27/10/2026, vocal de Damien).
//
// Le tampon d'entree d'Eleven n'est jamais consomme : la transcription que le MODELE recoit a chaque tour reprend tout
// l'appel depuis le decroche (creerPartNouvelle ne corrige que la console et le recap). Appel reel du 27/10 a 12:19 UTC :
// apres « Ouais, parfait. », Dany a dit « C'est corrige » ; apres la ville (« Ce nom. »), il a redemande la ville, puis
// relu l'email une seconde fois : il reentendait l'adresse dans chaque message. La note dit au modele, juste avant la
// demande de reponse, ce que le client vient VRAIMENT de dire, a quoi cela repond, et ce qui est deja fait.
// Ce qui se CALCULE (la question a laquelle la phrase repond) est dit par le code : au banc, une note qui disait seulement
// « la ville a deja ete demandee » laissait encore le modele prendre « Ce nom. » pour une correction de l'email.
import { estRelectureEmail, parleDeLaVille } from "./relecture.js";

// Une phrase qui demande de repeter n'est pas une reponse : on ne la fait pas passer pour la ville.
// Teste sur le texte sans accents (« répétez », « répéter », « repete » se valent).
const DEMANDE_DE_REPETER_RE = /\?|\b(pardon|comment|quoi|repet\w*|pas compris)\b/;
const demandeDeRepeter = (s) => DEMANDE_DE_REPETER_RE.test(s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase());

export function noteDeTour({ nouveau, dialog = [] }) {
  const phrase = String(nouveau || "").replace(/\s+/g, " ").trim();
  if (!phrase) return null;
  const agent = dialog.filter((l) => l && l.who === "Agent").map((l) => String(l.msg || ""));
  const derniere = agent[agent.length - 1] || "";
  // Pas « uniquement » : un client qui dicte son email en deux fois (une pause de plus d'une seconde) fait deux tours,
  // et le second morceau seul ne veut rien dire (relecture critique du 27/10).
  let note = `(SYSTEME : le message precedent du client reprend tout l'appel depuis le debut. Il vient seulement de dire : « ${phrase} ». Reponds a cette phrase ; si elle complete ce qu'il dictait juste avant (adresse, numero, nom), assemble les deux. Ne redemande pas ce qu'il a deja donne.`;
  if (parleDeLaVille(derniere) && !demandeDeRepeter(phrase)) {
    note += " Cette phrase repond a ta question sur la ville : c'est sa ville, note-la telle quelle meme si elle te semble etrange, ne la redemande pas, ne dis pas « c'est corrige », et passe a l'etape suivante.";
  }
  if (agent.some((m) => estRelectureEmail(m))) note += " Deja fait : l'adresse mail a deja ete relue au client, ne la relis plus et ne la redemande plus.";
  return `${note})`;
}
