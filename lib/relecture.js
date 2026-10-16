// RELECTURE UNIQUE DE L'EMAIL (15/10/2026, vocal 8 de Damien, appel de M. Mbaye du 15/10 a 10:45 UTC) : Dany a
// relu l'adresse epelee DEUX fois, puis l'a fait epeler une troisieme, alors que son prompt dit « une seule
// relecture, jamais deux » depuis le 09/10. Le modele ne tient pas la regle quand le client repond « Non » sans
// dire ce qui est faux : il redemande l'adresse et la relit de nouveau. Deuxieme recidive, donc le pont la tient.
//
// RELECTURE_UNIQUE (variable du service) = la phrase dite a la place d'une deuxieme relecture, par exemple
// « C'est noté, merci. Vous êtes dans quelle ville, s'il vous plaît ? ». Vide : garde coupee.
// 16/10/2026 : elargie a « au plus DEUX questions sur l'email » (voir estQuestionEmail), relecture comprise.
// Apres la deuxieme question sur l'email entendue (meme en partie), le texte de chaque reponse part a la lecture
// phrase par phrase (voir partSure) : une reponse qui se met a epeler n'est plus lue a partir de la phrase qui
// epelle, la phrase ci-dessus est lue a la place, et l'historique du modele le sait (server.js).
// La fenetre se ferme des qu'une reponse dite parle de la ville (etape suivante du deroule), apres un remplacement,
// ou a la cloture. Elle ne s'arme pas si la ville a deja ete demandee : la phrase de remplacement la redemanderait.
// Ne marche qu'avec la lecture ElevenLabs : c'est elle qui donne au pont le texte AVANT le son.

// Sans accents, MEME LONGUEUR que le texte (les positions servent a couper le texte d'origine). Casse gardee.
function sansAccents(t) {
  return String(t).split("").map((c) => {
    const d = c.normalize("NFD").replace(/\p{M}/gu, "");
    return d.length === 1 ? d : "x";
  }).join("");
}
const normaliser = (t) => sansAccents(t).toLowerCase();

// Trois lettres isolees separees par des virgules (« N, D, I ») : aucune phrase francaise n'en contient.
const LETTRES_VIRGULES_RE = /(?:^|[^a-z0-9'])[a-z]\s*,\s*[a-z]\s*,\s*[a-z](?![a-z0-9])/;
// Trois MAJUSCULES isolees separees par des espaces, tirets ou points (« N D I », « N-D-I », « N. D. I. »).
const LETTRES_MAJ_RE = /(?:^|[^A-Za-z0-9'])[A-Z](?:\s*[-.,]\s*|\s+)[A-Z](?:\s*[-.,]\s*|\s+)[A-Z](?![A-Za-z0-9])/;
// « N comme Nicolas, D comme David » : deux fois suffit.
const COMME_RE = /(?:^|[^a-z0-9'])[a-z] comme [a-z]/g;
// Annonce d'une epellation (« Je vous épelle », « je répète », « je relis »). Pas « épeler » seul : « Pourriez-vous
// me l'épeler ? » est justement la demande qu'on veut entendre vite.
const ANNONCE_RE = /\bje (?:vous )?(?:epelle|repete|relis)\b/;
// Une lettre isolee suivie d'une virgule, d'un tiret, d'un point ou de la fin : debut possible d'une epellation.
const LETTRE_ISOLEE_RE = /(?:^|[^a-z0-9'])[a-z](?:\s*[,-]|\.(?=\s|$)|\s*$)/;

export function estRelecture(texte) {
  const s = normaliser(texte);
  if (LETTRES_VIRGULES_RE.test(s) || LETTRES_MAJ_RE.test(sansAccents(texte))) return true;
  if ((s.match(COMME_RE) || []).length >= 2) return true;
  // « je vous épelle : N, » : l'epellation commence. La lettre doit etre SUIVIE d'une virgule, d'un tiret ou d'un
  // point : en flux, « Je répète : u » est le debut de « un conseiller », pas une lettre.
  const a = s.search(ANNONCE_RE);
  return a >= 0 && /(?:^|[^a-z0-9'])[a-z](?:\s*[,-]|\.(?=\s))/.test(s.slice(a + 4));
}

// Une relecture de l'ADRESSE : elle epelle et parle d'arobase. Seule elle arme la fenetre (un nom epele ne compte pas).
export function estRelectureEmail(texte) {
  return estRelecture(texte) && /arobase|@/.test(normaliser(texte));
}

// Nombre de caracteres du texte pas encore lu qui peuvent partir a la lecture sans risque : les phrases FINIES
// (ponctuation forte suivie d'une espace), jamais a partir d'une annonce ou d'une lettre isolee. Une phrase est
// donc lue entiere ou pas du tout : « D'accord, voici l'adresse : » ne se fait jamais couper au milieu.
export function partSure(reste) {
  const s = normaliser(reste);
  let fin = s.length;
  for (const re of [ANNONCE_RE, LETTRE_ISOLEE_RE]) {
    const i = s.search(re);
    if (i >= 0) fin = Math.min(fin, i);
  }
  for (let i = Math.min(fin, s.length - 1) - 1; i >= 0; i--) if (/[.!?…]/.test(s[i]) && /\s/.test(s[i + 1])) return i + 2;
  return 0;
}

// Une QUESTION sur l'email : une phrase qui finit par « ? » et parle de mail ou d'arobase (« Quelle est votre adresse
// mail ? », « Et après l'arobase ? », « Pourriez-vous me redire votre adresse mail complète ? », une relecture).
// 16/10/2026, banc sur ligne degradee : sans aucune relecture, Dany a redemande l'adresse quatre fois de suite.
// Au plus DEUX questions sur l'email par appel (la premiere demande comprise) : la garde remplace les suivantes.
export function estQuestionEmail(texte) {
  if (estRelectureEmail(texte)) return true; // « … arobase gmail point com. C'est bien ça ? » : deux phrases
  return normaliser(texte).split(/(?<=[.!?…])\s+/).some((p) => /\?/.test(p) && /\b(e-?mail|mail|arobase|courriel)\b/.test(p));
}

// La reponse dite parle-t-elle de la ville (etape qui suit l'email) ?
export function parleDeLaVille(texte) {
  return /\bville\b/.test(normaliser(texte));
}
