// LE TRANSFERT D'APPEL VERS UN HUMAIN (16/09/2026).
//
// « Passe-moi Lorenzo » : jusqu'ici l'agent ne pouvait que transmettre un message
// pour que l'equipe rappelle. Le pont bascule desormais l'appel EN DIRECT : il laisse
// finir la phrase d'annonce de l'agent, puis remplace le flux par un <Dial> grace a
// l'API REST de Twilio (modification d'un appel en cours). Les identifiants sont ceux
// du numero, que Dale Voz donne deja au pont pour verifier la signature Twilio.
//
// Le numero de renvoi vient de TRANSFERT_NUMERO et le prenom annonce de TRANSFERT_NOM,
// POUR L'INSTANT (decision de Coq le 16/09/2026). La regle de la maison veut qu'un
// reglage de canal appartienne a l'agent et pas a une variable du pont : quand le
// transfert deviendra une capacite de Dale Voz, il passera dans settings.telephone.
//
// Tout ce qui est ici est pur, sauf basculerAppel (reseau) : c'est ce qui se teste
// sans appel dans test/transfert-test.mjs.

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

/** L'outil tel que le modele le voit. */
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
 * Le TwiML qui remplace le flux : on sonne chez l'humain. `callerId` est le numero
 * Twilio appele, pas celui du client : un numero francais presente par un operateur
 * etranger est bloque par les operateurs francais depuis 2024, celui du compte passe.
 * `action` rend la main au pont a la fin de la sonnerie ou de la conversation.
 */
export function twimlTransfert({ numero, callerId, actionUrl, delaiSonnerie = 25 }) {
  const attributs = [
    callerId ? `callerId="${xml(callerId)}"` : "",
    `timeout="${Number(delaiSonnerie) || 25}"`,
    actionUrl ? `action="${xml(actionUrl)}" method="POST"` : "",
  ].filter(Boolean).join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial ${attributs}><Number>${xml(numero)}</Number></Dial></Response>`;
}

/**
 * Ce qui suit la sonnerie. Decroche puis raccroche : l'appel est fini, on raccroche
 * sans rien dire (sans `action`, Twilio aurait enchaine sur la suite du TwiML et
 * annonce un echec a un client qui venait de parler a Lorenzo). Pas de reponse,
 * occupe, echec : une phrase, puis on raccroche ; le pont a deja laisse un message
 * a l'equipe pour qu'elle rappelle.
 */
export function twimlApresTransfert({ statut, nom }) {
  if (statut === "completed" || statut === "answered") {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
  }
  const qui = nom ? xml(nom) : "L'équipe";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice" language="fr-FR">${qui} n'a pas pu répondre. Nous vous rappelons très vite à ce numéro. Merci, et à bientôt.</Say><Hangup/></Response>`;
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
