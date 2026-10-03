// LE TRANSFERT D'APPEL VERS UN HUMAIN (16/09/2026, regle par agent depuis le 02/10/2026).
//
// « Passe-moi Lorenzo » : le pont bascule l'appel EN DIRECT. Il laisse finir la phrase
// d'annonce de l'agent, puis remplace le flux par un <Dial> grace a l'API REST de Twilio
// (modification d'un appel en cours). Les identifiants sont ceux du numero, que Dale Voz
// donne deja au pont pour verifier la signature Twilio.
//
// D'OU VIENT LE REGLAGE (02/10/2026) : de l'agent Dale Voz, `settings.telephone.transfert`,
// servi par /api/voice/session-config dans `telephone.transfert` (numero, nom annonce, quand,
// sonnerie, confirmation, siPasDeReponse) avec l'outil `transferer_appel` deja decrit. Les
// variables TRANSFERT_NUMERO / TRANSFERT_NOM restent le repli d'un pont sans Dale Voz.
//
// TROIS PIEGES, payes ou mesures avant de coder :
// - LA MESSAGERIE DU CONSEILLER. Un portable qui ne decroche pas bascule sur sa messagerie,
//   que Twilio compte comme un appel PRIS : l'appelant parle a un repondeur et l'agent ne
//   reprend jamais. Parade documentee par Twilio : <Number url> joue un message a la personne
//   appelee AVANT la mise en relation, et un <Gather> lui fait appuyer sur 1. Sans touche, on
//   raccroche sa jambe. ⚠ Twilio rend alors DialCallStatus=completed, pas no-answer (changelog
//   TwiML du 09/12/2020) : le pont tient lui-meme le registre de qui a appuye.
// - LE NUMERO PRESENTE. Un numero francais presente depuis l'etranger peut etre bloque par les
//   operateurs francais, et le tarif vers un mobile francais passe de 0,0404 a 0,1603 $/min
//   quand l'appelant presente n'est pas europeen (API Pricing, 02/10/2026). On presente donc
//   toujours le numero appele (celui de l'agent), et le message chuchote dit qui appelle.
// - LE RETOUR A L'AGENT. Apres un <Dial> sans reponse, le TwiML de l'action reconnecte l'appel
//   au pont par un nouveau <Connect><Stream>, avec un parametre « reprise » : c'est un appel
//   neuf pour le pont, qui retrouve la conversation dans son registre.
//
// Tout ce qui est ici est pur, sauf basculerAppel (reseau) : c'est ce qui se teste sans appel
// dans test/transfert-test.mjs.

/** Numero saisi a la francaise (06..., 07...) ou deja en E.164 -> E.164, sinon null. */
export function numeroE164(brut, indicatif = "33") {
  const s = String(brut || "").replace(/[\s.\-()]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(s)) return s;
  if (/^00[1-9]\d{6,14}$/.test(s)) return "+" + s.slice(2);
  if (/^0[1-9]\d{8}$/.test(s)) return `+${indicatif}${s.slice(1)}`;
  return null;
}

const xml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Le reglage effectif d'un appel : celui de l'agent Dale Voz, sinon celui des variables du
 * pont (sans Dale Voz, aucune confirmation ni reprise : c'etait le comportement du 16/09).
 */
export function reglageTransfert(telephoneDV, repli = {}) {
  const t = telephoneDV?.transfert;
  const numeroDV = t ? numeroE164(t.numero) : null;
  if (numeroDV) {
    const sonnerie = Math.min(45, Math.max(10, Math.round(Number(t.sonnerie) || 20)));
    return {
      numero: numeroDV,
      nom: typeof t.nom === "string" ? t.nom.trim() : "",
      sonnerie,
      confirmation: t.confirmation !== false,
      siPasDeReponse: t.siPasDeReponse === "message" ? "message" : "agent",
      source: "dalevoz",
    };
  }
  const numero = numeroE164(repli.numero);
  if (!numero) return null;
  return { numero, nom: (repli.nom || "").trim(), sonnerie: 25, confirmation: false, siPasDeReponse: "message", source: "pont" };
}

/** L'outil tel que le modele le voit, quand Dale Voz ne l'a pas fourni (pont sans Dale Voz). */
export function outilTransfert(nom) {
  const qui = nom || "quelqu'un de l'équipe";
  return {
    type: "function",
    name: "transferer_appel",
    description: `Transfère l'appel EN DIRECT à ${qui}, un humain de l'équipe. À appeler tout de suite, sans poser de question, dès que le client demande à parler à ${qui}, à un humain, à quelqu'un de l'équipe ou au patron (par exemple « passe-moi ${nom || "quelqu'un"} »). Ne pas l'utiliser pour une question à laquelle tu sais répondre.`,
    parameters: {
      type: "object",
      properties: {
        motif: { type: "string", description: "Pourquoi le client veut parler à quelqu'un, en quelques mots, s'il l'a dit." },
      },
    },
  };
}

/**
 * Le TwiML qui remplace le flux : on sonne chez l'humain. `callerId` est le numero Twilio
 * appele, pas celui du client (voir l'en-tete). `action` rend la main au pont a la fin de la
 * sonnerie ou de la conversation ; `annonceUrl` (confirmation) joue le message chuchote.
 * ringTone="fr" : l'appelant entend la tonalite francaise pendant la sonnerie, pas l'americaine.
 */
export function twimlTransfert({ numero, callerId, actionUrl, delaiSonnerie = 25, annonceUrl = "" }) {
  const attributs = [
    callerId ? `callerId="${xml(callerId)}"` : "",
    `timeout="${Number(delaiSonnerie) || 25}"`,
    'ringTone="fr"',
    // Deux heures au plus avec l'humain : c'est aussi le plafond qu'accepte Dale Voz pour un appel.
    'timeLimit="7200"',
    actionUrl ? `action="${xml(actionUrl)}" method="POST"` : "",
  ].filter(Boolean).join(" ");
  const number = annonceUrl
    ? `<Number url="${xml(annonceUrl)}" method="POST">${xml(numero)}</Number>`
    : `<Number>${xml(numero)}</Number>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial ${attributs}>${number}</Dial></Response>`;
}

// Voix de Twilio pour ce que l'agent ne dit pas lui-meme (message chuchote, au revoir sans
// reprise). Polly standard, comprise dans le prix de <Say>.
const VOIX = {
  fr: { voice: "Polly.Lea", language: "fr-FR" },
  es: { voice: "Polly.Lupe", language: "es-US" },
  en: { voice: "Polly.Joanna", language: "en-US" },
};
const voixDe = (langue) => VOIX[String(langue || "fr").slice(0, 2)] || VOIX.fr;
const dire = (texte, langue) => {
  const v = voixDe(langue);
  return `<Say voice="${v.voice}" language="${v.language}">${xml(texte)}</Say>`;
};

/** Le numero lu chiffre par chiffre, par paires a la francaise : « 06 12 34 56 78 ». */
export function numeroLisible(e164) {
  const s = String(e164 || "");
  if (/^\+33\d{9}$/.test(s)) return ("0" + s.slice(3)).replace(/(\d{2})(?=\d)/g, "$1 ");
  return s.replace(/^\+/, "+ ").split("").join(" ").replace(/\s+/g, " ");
}

const TEXTES = {
  fr: {
    annonce: (motif, appelant) => `Appel transféré par votre assistant téléphonique.${motif ? ` Motif : ${motif}.` : ""}${appelant ? ` L'appelant : ${appelant}.` : ""} Appuyez sur 1 pour prendre l'appel.`,
    rappel: "Appuyez sur 1 pour prendre l'appel.",
    nonPris: "Appel non pris. Au revoir.",
    rappelera: (qui) => `${qui} n'a pas pu répondre. Votre demande est transmise, on vous rappelle très vite à ce numéro. Merci, et à bientôt.`,
    reprise: (qui) => `${qui} n'est pas disponible pour le moment. Je peux prendre un message pour qu'on vous rappelle : qu'est-ce que je lui transmets?`,
    passe: (qui) => `Je vous passe ${qui}, ne quittez pas.`,
    equipe: "L'équipe",
    conseiller: "Le conseiller",
    unConseiller: "un conseiller",
  },
  es: {
    annonce: (motif, appelant) => `Llamada transferida por su asistente telefónico.${motif ? ` Motivo: ${motif}.` : ""}${appelant ? ` Quien llama: ${appelant}.` : ""} Pulse 1 para tomar la llamada.`,
    rappel: "Pulse 1 para tomar la llamada.",
    nonPris: "Llamada no tomada. Adiós.",
    rappelera: (qui) => `${qui} no pudo contestar. Su solicitud fue transmitida, le devolveremos la llamada muy pronto a este número. Gracias, hasta pronto.`,
    reprise: (qui) => `${qui} no está disponible por el momento. Puedo tomar un mensaje para que le devuelvan la llamada: ¿qué le transmito?`,
    passe: (qui) => `Le paso con ${qui}, no cuelgue.`,
    equipe: "El equipo",
    conseiller: "El asesor",
    unConseiller: "un asesor",
  },
  en: {
    annonce: (motif, appelant) => `Call transferred by your phone assistant.${motif ? ` Reason: ${motif}.` : ""}${appelant ? ` Caller: ${appelant}.` : ""} Press 1 to take the call.`,
    rappel: "Press 1 to take the call.",
    nonPris: "Call not taken. Goodbye.",
    rappelera: (qui) => `${qui} could not answer. Your request has been passed on, we will call you back very soon at this number. Thank you, goodbye.`,
    reprise: (qui) => `${qui} is not available right now. I can take a message so they call you back: what should I pass on?`,
    passe: (qui) => `I'm putting you through to ${qui}, please hold.`,
    equipe: "The team",
    conseiller: "The advisor",
    unConseiller: "an advisor",
  },
};
const textes = (langue) => TEXTES[String(langue || "fr").slice(0, 2)] || TEXTES.fr;

/**
 * Le message chuchote a la personne appelee (attribut url de <Number>), avant la mise en
 * relation : motif, numero de l'appelant, et la touche 1. Le prompt est dit deux fois ; sans
 * touche, on raccroche SA jambe et l'appelant revient au pont par l'action du <Dial>.
 */
export function twimlAnnonce({ motif = "", appelant = "", reponseUrl, langue = "fr" }) {
  const T = textes(langue);
  const gather = (texte) =>
    // 5 s apres chaque message : sur l'appel de test du 02/10/2026, une messagerie qui decroche faisait attendre
    // l'appelant 31 s de sonnerie avant que l'agent reprenne ; chaque seconde ici en est une de plus pour lui.
    `<Gather numDigits="1" timeout="5" action="${xml(reponseUrl)}" method="POST">${dire(texte, langue)}</Gather>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${gather(T.annonce(String(motif).slice(0, 160), appelant ? numeroLisible(appelant) : ""))}${gather(T.rappel)}${dire(T.nonPris, langue)}<Hangup/></Response>`;
}

/** La touche de la personne appelee : 1 la met en relation (TwiML vide), le reste raccroche sa jambe. */
export function twimlReponseAnnonce({ digits, langue = "fr" }) {
  if (String(digits || "").trim() === "1") return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${dire(textes(langue).nonPris, langue)}<Hangup/></Response>`;
}

/**
 * L'issue du transfert, en un mot que Dale Voz sait ecrire. Avec confirmation, seul l'appui
 * sur 1 vaut « pris » : une messagerie qui a decroche rend `completed` elle aussi.
 */
export function issueTransfert({ statut, duree = 0, confirmation = false, accepte = false }) {
  const s = String(statut || "");
  if (confirmation) {
    if (accepte && (s === "completed" || s === "answered")) return "pris";
    if (s === "busy") return "occupe";
    if (s === "failed") return "echec";
    if (s === "completed" || s === "answered") return "refuse"; // decroche sans appuyer : messagerie ou refus
    return "sans_reponse";
  }
  if ((s === "completed" || s === "answered") && Number(duree) > 0) return "pris";
  if (s === "busy") return "occupe";
  if (s === "failed") return "echec";
  return "sans_reponse";
}

/**
 * Ce qui suit la sonnerie, selon l'issue :
 * - pris : l'appel est fini, on raccroche sans rien dire (sans `action`, Twilio aurait enchaine
 *   sur la suite du TwiML et annonce un echec a un client qui venait de parler a Lorenzo) ;
 * - pas pris, reprise par l'agent : on reconnecte le pont (`repriseStreamUrl`) ;
 * - pas pris, message : une phrase, puis on raccroche ; l'equipe est prevenue a part.
 */
export function twimlApresTransfert({ issue, statut, nom, langue = "fr", repriseStreamUrl = "", parametres = {} }) {
  const pris = issue ? issue === "pris" : (statut === "completed" || statut === "answered");
  if (pris) return `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
  if (repriseStreamUrl) {
    const params = Object.entries({ ...parametres, reprise: "transfert" })
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `<Parameter name="${xml(k)}" value="${xml(v)}"/>`)
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(repriseStreamUrl)}">${params}</Stream></Connect></Response>`;
  }
  const T = textes(langue);
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${dire(T.rappelera(nom || T.equipe), langue)}<Hangup/></Response>`;
}

/**
 * L'annonce a l'appelant, dite par le PONT (02/10/2026) et non par le modele : au banc, le modele appelait
 * l'outil sans rien dire, puis il fallait un second aller-retour pour lui faire dire la phrase, soit pres de
 * 4 s de blanc apres « je voudrais parler a quelqu'un ». Fixe, donc pre-enregistree des le decroche.
 */
export function phraseAnnonceAppelant({ nom, langue = "fr" }) {
  const T = textes(langue);
  return T.passe(nom || T.unConseiller);
}

/** La premiere phrase de l'agent quand il reprend un appel que personne n'a pris. Fixe, donc pre-enregistrable. */
export function phraseReprise({ nom, langue = "fr" }) {
  const T = textes(langue);
  return T.reprise(nom || T.conseiller);
}

const A_RAPPELER = {
  fr: {
    issue: { sans_reponse: "personne n'a décroché", occupe: "ligne occupée", refuse: "appel non pris", echec: "le transfert n'a pas pu se faire" },
    texte: ({ qui, pourquoi, raccroche, reprise, motif, dit }) =>
      `Appel à rappeler : le transfert à ${qui} n'a pas abouti (${pourquoi})` +
      (raccroche ? ", et l'appelant a raccroché pendant la sonnerie." : reprise ? ", l'assistant a repris l'appel." : ".") +
      (motif ? ` Motif : ${motif}.` : "") + (dit ? ` Ce que la personne a dit ensuite : « ${dit} »` : ""),
    conseiller: "un conseiller",
  },
  es: {
    issue: { sans_reponse: "nadie contestó", occupe: "línea ocupada", refuse: "llamada no tomada", echec: "la transferencia no pudo hacerse" },
    texte: ({ qui, pourquoi, raccroche, reprise, motif, dit }) =>
      `Llamada por devolver: la transferencia a ${qui} no se concretó (${pourquoi})` +
      (raccroche ? ", y quien llamaba colgó mientras sonaba." : reprise ? ", el asistente retomó la llamada." : ".") +
      (motif ? ` Motivo: ${motif}.` : "") + (dit ? ` Lo que dijo después: « ${dit} »` : ""),
    conseiller: "un asesor",
  },
  en: {
    issue: { sans_reponse: "nobody answered", occupe: "line busy", refuse: "call not taken", echec: "the transfer could not be made" },
    texte: ({ qui, pourquoi, raccroche, reprise, motif, dit }) =>
      `Call to return: the transfer to ${qui} did not go through (${pourquoi})` +
      (raccroche ? ", and the caller hung up while it was ringing." : reprise ? ", the assistant took the call back." : ".") +
      (motif ? ` Reason: ${motif}.` : "") + (dit ? ` What they said next: "${dit}"` : ""),
    conseiller: "an advisor",
  },
};

/** L'alerte de reprise humaine d'un transfert qui n'a pas abouti, dans la langue de l'agent. */
export function texteARappeler({ issue, nom, motif = "", langue = "fr", raccroche = false, reprise = false, dit = "" }) {
  const L = A_RAPPELER[String(langue || "fr").slice(0, 2)] || A_RAPPELER.fr;
  return L.texte({ qui: nom || L.conseiller, pourquoi: L.issue[issue] || L.issue.sans_reponse, raccroche, reprise, motif, dit });
}

/** L'etat d'un appel chez Twilio (in-progress, completed...), ou null si Twilio ne repond pas. */
export async function etatAppelTwilio({ accountSid, authToken, callSid, timeoutMs = 6000 }) {
  if (!accountSid || !authToken || !callSid) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(callSid)}.json`,
      { headers: { Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64") }, signal: ctrl.signal },
    );
    if (!r.ok) return null;
    return (await r.json()).status || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Modifie l'appel en cours chez Twilio : le flux s'arrete et le TwiML donne s'execute. */
export async function basculerAppel({ accountSid, authToken, callSid, twiml, timeoutMs = 8000 }) {
  if (!accountSid || !authToken || !callSid) return { ok: false, erreur: "identifiants Twilio ou CallSid manquants" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(callSid)}.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ Twiml: twiml }),
        signal: ctrl.signal,
      },
    );
    if (r.ok) return { ok: true };
    const texte = await r.text();
    return { ok: false, erreur: `Twilio ${r.status} ${texte.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, erreur: e.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * LE REGISTRE DES TRANSFERTS EN COURS, par CallSid de l'appel d'origine. Les routes HTTP que
 * Twilio rappelle (message chuchote, touche, fin du <Dial>) et la connexion de reprise n'ont
 * que le CallSid : tout le reste (identifiants pour verifier la signature, reglage, fil Dale
 * Voz, conversation jusqu'ici) vit ici. En memoire : un redemarrage du pont pendant un
 * transfert retombe sur le chemin sans registre (message, puis on raccroche).
 */
export function creerRegistreTransferts({ dureeVieMs = 3 * 60 * 60 * 1000 } = {}) {
  const entrees = new Map();
  const nettoyage = setInterval(() => {
    const limite = Date.now() - dureeVieMs;
    for (const [sid, e] of entrees) if (e.creeA < limite) entrees.delete(sid);
  }, 10 * 60 * 1000);
  nettoyage.unref?.();
  return {
    poser(callSid, entree) { entrees.set(callSid, { ...entree, creeA: Date.now() }); return entrees.get(callSid); },
    lire(callSid) { return callSid ? entrees.get(callSid) || null : null; },
    retirer(callSid) { entrees.delete(callSid); },
    taille() { return entrees.size; },
  };
}
