// Lignes par agence (Motralec : Herblay, Sevres, Etrechy).
// Un meme agent (Dany) decroche pour plusieurs numeros. Le pont sait quel numero a ete appele (`To` de Twilio) ;
// ce module en tire (1) une consigne courte pour Dany, qui sait ainsi de quelle agence il s'agit, et
// (2) les champs `appele` et `agence` du recap n8n, pour que le mail porte le bon intitule.
//
// Config : variable AGENCES_JSON = {"+33939241266":{"nom":"Herblay"},"+33...":{"nom":"Sèvres"}}.
// Absente ou invalide : le pont se comporte comme avant (aucune consigne ajoutee, `appele` seul dans le recap).
// Les horaires, adresses et telephones restent dans le prompt de Dany : ce module ne les porte pas.

// Twilio donne du E.164 ; on accepte aussi les ecritures humaines (0939241266, 33 9 39..., +33 (0)9 39...).
export function normaliserNumero(brut) {
  const s = String(brut ?? "").replace(/[^\d+]/g, "");
  if (!s) return "";
  let n;
  if (s.startsWith("+")) n = "+" + s.slice(1).replace(/\+/g, "");
  else if (s.startsWith("00")) n = "+" + s.slice(2);
  else if (/^0\d{9}$/.test(s)) n = "+33" + s.slice(1);
  else if (/^33\d{9}$/.test(s)) n = "+" + s;
  else n = s;
  return n.replace(/^\+330/, "+33"); // « +33 (0)9 » : le zero de tete saute
}

// Ne leve jamais : une variable mal ecrite ne doit pas empecher le pont de decrocher.
export function lireAgences(brut, journal = console) {
  const agences = new Map();
  if (!brut || !String(brut).trim()) return agences;
  let data;
  try {
    data = JSON.parse(brut);
  } catch (e) {
    journal.error(`[agences] AGENCES_JSON illisible (${e.message}), ignore`);
    return agences;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    journal.error("[agences] AGENCES_JSON doit etre un objet {numero: {nom}}, ignore");
    return agences;
  }
  for (const [numero, valeur] of Object.entries(data)) {
    const cle = normaliserNumero(numero);
    const nom = typeof valeur === "string" ? valeur : valeur?.nom;
    if (!/^\+\d{8,15}$/.test(cle) || typeof nom !== "string" || !nom.trim()) {
      journal.error(`[agences] entree ignoree : ${numero}`);
      continue;
    }
    agences.set(cle, { nom: nom.trim().slice(0, 60) });
  }
  return agences;
}

export function agenceDeLigne(agences, numeroAppele) {
  return agences.get(normaliserNumero(numeroAppele)) || null;
}

// Pas de « de ${nom} » : l'elision (« d'Etrechy ») se tromperait une fois sur deux.
export function consigneAgence(agence) {
  if (!agence?.nom) return "";
  return `Agence appelée par ce client : ${agence.nom}. S'il demande des horaires, une adresse ou un téléphone sans nommer d'agence, ou s'il parle de « l'agence », c'est celle-ci. Tu donnes les informations de cette agence seulement, et tu ne cites les autres que si on te les demande. Rien d'autre ne change : tu restes Dany, de Motralec.`;
}

// Champs ajoutes au recap n8n. `appele` toujours quand le numero est connu, `agence` seulement si la table le dit :
// n8n peut alors afficher le bon intitule meme si sa propre table ne connait pas encore la ligne.
export function champsAppelee(agences, numeroAppele) {
  const appele = normaliserNumero(numeroAppele);
  if (!appele) return {};
  const agence = agenceDeLigne(agences, appele);
  return agence ? { appele, agence: agence.nom } : { appele };
}
