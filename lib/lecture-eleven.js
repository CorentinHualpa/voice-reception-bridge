// LECTURE PAR ELEVENLABS (28/09/2026, Palazzo) : la voix de l'agent n'est plus celle de Grok.
//
// Pourquoi : l'accent italien de Chiara. Grok n'a aucun reglage d'accent (essais du 16/09, sans effet), alors
// qu'Eleven v4 en suit un par balise de jeu (« [said warmly with a strong Italian accent] »), et Coq a retenu
// l'essai voix Chiara + v4 Turbo + cette balise. Banc du 28/09 : 28 syntheses sur 28 restees en FRANCAIS avec
// cette voix et cette balise (la meme balise sur une autre voix italienne a fait TRADUIRE la phrase en italien :
// toute nouvelle voix ou balise se rejoue au banc avant d'aller sur la ligne).
//
// Comment : Grok ne sait pas repondre en texte seul (`modalities` et `output_modalities` ignores sans erreur,
// mesure le 28/09), donc on garde toute la mecanique du pont et on LIT la transcription de sa propre reponse
// (`response.output_audio_transcript.delta`). Sa voix est jetee, sauf en secours (voir `surEchec`).
//
// Le texte arrive par morceaux d'environ une seconde, un peu en avance sur la voix de Grok (« Bonjour ! Chez
// Palazzo, notre carte sans viande » a 0,99 s, la suite a 1,90 s, 2,96 s...). On synthetise donc morceau par
// morceau, en coupant de preference sur une fin de phrase, et on joue dans l'ordre. Seul le PREMIER morceau
// compte pour la latence : ensuite le texte a toujours de l'avance sur ce qui se joue.
//
// Chaque morceau porte la balise (elle vaut pour une requete, pas pour la suivante) et le texte deja dit en
// `previous_text`, pour que l'intonation enchaine. Sortie directe en `ulaw_8000` : le format de Twilio, rien
// a convertir. Connexions HTTPS gardees ouvertes : pas de poignee de main TLS a chaque morceau.

import https from "node:https";
import { ulawDecodeSample } from "./audio.js";

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 20000, maxSockets: 16 });

// SILENCES DE BORD (28/09/2026). Chaque synthese commence par 50 a 200 ms de silence et finit par 200 a 360 ms
// (mesure, v4 Turbo, voix Chiara). Morceau apres morceau, ca faisait 0,4 a 0,5 s de blanc a chaque jointure et
// l'accueil passait de 22 s d'un seul tenant a 24,7 s decoupe. On rogne : le debut du premier morceau (c'est de
// la latence pure), et chaque jointure ramenee a une pause de phrase (~140 ms). Rien d'autre n'est touche.
// ⚠ Seuil BAS : une fin de phrase s'eteint doucement (le « -de » de « commande », le souffle de « écoute ! »
// restent entre 100 et 600 pendant 200 ms), alors que le vrai silence d'ElevenLabs est sous 30. Un seuil a 400
// mangeait ces fins (« passer comment » entendu au banc).
const FENETRE = 80;           // 10 ms a 8 kHz
const SEUIL_PAROLE = 60;      // RMS PCM16 : au-dessus, ce n'est plus du silence
const GARDE_DEBUT = { premier: 240, suivant: 480 }; // octets gardes avant la voix : 30 ms, puis 60 ms
const GARDE_FIN = 640;        // 80 ms gardees apres le dernier son
const RETENUE_FIN = 4000;     // la fin de chaque morceau attend 500 ms, le temps de savoir si c'est du silence
const DEBUT_MAX = 6400;       // au-dela de 800 ms sans voix, on ne rogne plus rien (filet)

function fenetreParle(buf, i) {
  let s = 0;
  for (let j = 0; j < FENETRE; j++) { const x = ulawDecodeSample(buf[i + j]); s += x * x; }
  return Math.sqrt(s / FENETRE) > SEUIL_PAROLE;
}
// Rogne le silence de tete et de queue d'un morceau livre en flux. `pousser` et `finir` rendent ce qui peut partir.
export function creerRognure({ premier = false } = {}) {
  let tete = Buffer.alloc(0), debutFait = false, attente = Buffer.alloc(0);
  const garde = premier ? GARDE_DEBUT.premier : GARDE_DEBUT.suivant;
  function sortirQueue(fin) {
    if (!fin) {
      if (attente.length <= RETENUE_FIN) return [];
      const part = attente.subarray(0, attente.length - RETENUE_FIN);
      attente = Buffer.from(attente.subarray(attente.length - RETENUE_FIN));
      return [part];
    }
    let derniere = -1;
    for (let i = 0; i + FENETRE <= attente.length; i += FENETRE) if (fenetreParle(attente, i)) derniere = i + FENETRE;
    const reste = derniere < 0 ? attente : attente.subarray(0, Math.min(attente.length, derniere + GARDE_FIN));
    attente = Buffer.alloc(0);
    return reste.length ? [reste] : [];
  }
  return {
    pousser(m) {
      if (!debutFait) {
        tete = Buffer.concat([tete, m]);
        let premiere = -1;
        for (let i = 0; i + FENETRE <= tete.length; i += FENETRE) if (fenetreParle(tete, i)) { premiere = i; break; }
        if (premiere < 0 && tete.length < DEBUT_MAX) return [];
        debutFait = true;
        attente = premiere < 0 ? tete : Buffer.from(tete.subarray(Math.max(0, premiere - garde)));
        tete = null;
        return sortirQueue(false);
      }
      attente = Buffer.concat([attente, m]);
      return sortirQueue(false);
    },
    finir() {
      if (!debutFait) { debutFait = true; attente = tete || Buffer.alloc(0); tete = null; }
      return sortirQueue(true);
    },
  };
}

// Configuration lue dans l'environnement. `null` quand la lecture ElevenLabs n'est pas demandee ou incomplete.
export function configLectureEleven(env = process.env) {
  if ((env.LECTURE || "grok").toLowerCase() !== "elevenlabs") return null;
  const cle = env.ELEVENLABS_API_KEY || "";
  const voix = env.ELEVEN_VOIX || "";
  if (!cle || !voix) {
    console.error(`[lecture] LECTURE=elevenlabs mais ${!cle ? "ELEVENLABS_API_KEY" : "ELEVEN_VOIX"} manque : voix de Grok conservee`);
    return null;
  }
  return {
    cle,
    voix,
    modele: env.ELEVEN_MODELE || "eleven_v4_turbo",
    balise: (env.ELEVEN_BALISE || "").trim(),
    // Langue imposee a la synthese (« fr »). Sans elle, une phrase pleine de noms italiens (« la 4 Formaggi, la
    // Veggie et l'Antica Margherita ») glissait vers l'italien, et « 4 » se lisait « four » (banc du 30/09).
    langue: (env.ELEVEN_LANGUE || "").trim(),
    stabilite: Number(env.ELEVEN_STABILITE ?? 0.5),
    similarite: Number(env.ELEVEN_SIMILARITE ?? 0.75),
    delaiPremierOctetMs: Number(env.ELEVEN_DELAI_MAX_MS ?? 4000),
    delaiTotalMs: Number(env.ELEVEN_DUREE_MAX_MS ?? 20000),
  };
}

// Le texte que Grok ecrit pour sa voix, rendu lisible a une autre voix : les puces de liste (« - Veggie : »)
// deviennent une simple pause, les espaces multiples tombent. Les traits d'union des noms (« Saint-Jean-de-Védas »)
// ne sont pas touches : seul un tiret ENTOURE d'espaces, ou en tete, est une puce.
export function texteALire(t) {
  return String(t || "")
    .replace(/(^|\s)[-•*]\s+/g, "$1")
    .replace(/\s{2,}/g, " ");
}

const FIN_PHRASE = /[.!?…:;](?=["»”')\]]*(\s|$))/g;
const MIN_PREMIER = 12; // un premier morceau plus court ne s'envoie pas seul (« Bien sûr, » puis « c'est tout à fait »)
const MIN_VIRGULE_PREMIER = 20; // le premier morceau coupe a une virgule seulement si la proposition est assez longue
const MAX_SANS_FIN = 60; // au-dela, on n'attend plus la fin de phrase : on coupe a la derniere virgule ou au dernier mot
// Le premier morceau attend une ponctuation au plus ce delai apres le premier texte (voir `presse`).
export const ATTENTE_PREMIER_MS = 350;

// Coupe au dernier ESPACE : la suite d'un mot entame reste dans le tampon. ⚠ OpenAI livre son texte par
// fragments de mots (« Je compr » puis « ends »), Grok par groupes de mots entiers : couper « tout le tampon »
// lisait des moities de mots, et un premier morceau de deux mots (« Je comprends ») lu seul s'entendait
// « Je… comprends », avec un blanc (appel de Coq du 01/10/2026).
function auDernierMot(tampon) {
  const i = tampon.search(/\s\S*$/);
  if (i <= 0) return { part: "", reste: tampon };
  return { part: tampon.slice(0, i), reste: tampon.slice(i) };
}

// Decoupe le tampon : ce qui part maintenant, et ce qui attend la suite. Fonction pure, testee a part.
//   premier = aucun morceau n'est encore parti pour cette reponse (c'est lui qui fait la latence)
//   presse  = le premier texte attend depuis ATTENTE_PREMIER_MS : on ne guette plus la ponctuation
//   fin     = le modele a fini, tout part
export function decouper(tampon, { premier = false, presse = false, fin = false } = {}) {
  if (!tampon.trim()) return { part: "", reste: fin ? "" : tampon };
  if (fin) return { part: tampon, reste: "" };
  let derniere = -1;
  for (const m of tampon.matchAll(FIN_PHRASE)) derniere = m.index + m[0].length;
  if (derniere > 0) {
    // Les guillemets ou parentheses fermants restent avec leur phrase, y compris le « » » precede d'une espace.
    const apres = tampon.slice(derniere).match(/^(?:\s*["»”')\]])*/)[0].length;
    const coupe = derniere + apres;
    if (tampon.slice(0, coupe).trim().length >= (premier ? 2 : 1)) return { part: tampon.slice(0, coupe), reste: tampon.slice(coupe) };
  }
  const long = tampon.trim().length;
  const virgule = tampon.search(/,(?=\s)[^,]*$/); // derniere virgule suivie d'un espace (pas « 4,50 »)
  const avantVirgule = virgule >= 0 ? tampon.slice(0, virgule + 1).trim().length : 0;
  // Premier morceau : une proposition entiere vaut mieux qu'un morceau trop court lu avec sa propre intonation.
  if (premier && !presse && long < MAX_SANS_FIN) {
    if (avantVirgule >= MIN_VIRGULE_PREMIER) return { part: tampon.slice(0, virgule + 1), reste: tampon.slice(virgule + 1) };
    return { part: "", reste: tampon };
  }
  if (long >= MAX_SANS_FIN || (premier && presse && long >= MIN_PREMIER)) {
    if (avantVirgule >= MIN_PREMIER) return { part: tampon.slice(0, virgule + 1), reste: tampon.slice(virgule + 1) };
    const mot = auDernierMot(tampon);
    if (mot.part.trim().length >= MIN_PREMIER) return mot;
  }
  return { part: "", reste: tampon };
}

// Une synthese en flux : `surMorceau(buffer)` a chaque paquet recu, promesse resolue a la fin.
function synthetiser(cfg, texte, precedent, surMorceau, etat) {
  return new Promise((resolve, reject) => {
    const corps = JSON.stringify({
      text: cfg.balise ? `${cfg.balise} ${texte}` : texte,
      model_id: cfg.modele,
      ...(cfg.langue ? { language_code: cfg.langue } : {}),
      ...(precedent ? { previous_text: precedent.slice(-300) } : {}),
      voice_settings: { stability: cfg.stabilite, similarity_boost: cfg.similarite },
    });
    const req = https.request({
      host: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${encodeURIComponent(cfg.voix)}/stream?output_format=ulaw_8000`,
      method: "POST",
      agent,
      headers: { "xi-api-key": cfg.cle, "content-type": "application/json", "content-length": Buffer.byteLength(corps) },
    }, (res) => {
      if (res.statusCode !== 200) {
        let msg = "";
        res.on("data", (d) => { msg += d; });
        res.on("end", () => { clearTimeout(minuteur); reject(Object.assign(new Error(`HTTP ${res.statusCode} ${msg.slice(0, 200)}`), { statut: res.statusCode })); });
        return;
      }
      res.on("data", (d) => {
        if (etat.coupe) return;
        if (!etat.premierOctet) { etat.premierOctet = Date.now(); clearTimeout(minuteur); minuteur = setTimeout(() => req.destroy(new Error("synthese trop longue")), cfg.delaiTotalMs); }
        surMorceau(d);
      });
      res.on("end", () => { clearTimeout(minuteur); resolve(); });
      res.on("error", (err) => { clearTimeout(minuteur); reject(err); });
    });
    let minuteur = setTimeout(() => req.destroy(new Error(`aucun son en ${cfg.delaiPremierOctetMs} ms`)), cfg.delaiPremierOctetMs);
    etat.annuler = () => { clearTimeout(minuteur); req.destroy(new Error("coupee")); };
    req.on("error", (err) => { clearTimeout(minuteur); reject(err); });
    req.end(corps);
  });
}

const reessayable = (err) => !err.statut || err.statut === 429 || err.statut >= 500;

// ACCUEIL PRE-ENREGISTRE (30/09/2026). L'accueil est une phrase fixe : la faire ecrire par Grok a chaque appel
// coutait 1,5 s de mise en route plus 1 a 5 s de Grok (6,7 s de silence au decroche sur l'appel de Coq du 30/09).
// Il est synthetise une fois par texte, garde en memoire du service, et rejoue des que DaleVoz a repondu.
const cacheAccueil = new Map();

// Une lecture par appel. `flux(marque, ...)` ouvre la lecture d'UNE reponse de l'agent.
export function creerLectureEleven(cfg, { log = console.log } = {}) {
  const t = () => "";

  // Ouvre la connexion avant la premiere reponse et verifie la voix : une cle morte ou une voix retiree se
  // voit ici, avant que le client attende, et l'appel part directement sur la voix de Grok.
  function chauffer() {
    return new Promise((resolve) => {
      const req = https.request({ host: "api.elevenlabs.io", path: `/v1/voices/${encodeURIComponent(cfg.voix)}`, method: "GET", agent, headers: { "xi-api-key": cfg.cle } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200 ? true : `HTTP ${res.statusCode}`));
      });
      req.setTimeout(3000, () => req.destroy(new Error("delai")));
      req.on("error", (err) => resolve(String(err.message || err)));
      req.end();
    });
  }

  function flux(marque, { surSon, surEchec }) {
    let tampon = "", dit = "", finDemandee = false, coupe = false, fini = false, echoue = false;
    let tete = 0, octets = 0, premierTexteA = 0, premierSonA = 0;
    const segments = [];
    const quandFinis = [];
    let minuteurDecoupe = null, minuteurPremier = null;

    function terminer() {
      if (fini) return;
      fini = true;
      clearTimeout(minuteurDecoupe); clearTimeout(minuteurPremier);
      const cbs = quandFinis.splice(0);
      // Differe : les appelants reprennent leur propre enchainement (coupure, fin de reponse) avant la suite.
      setImmediate(() => { for (const cb of cbs) cb(); });
    }
    function verifierFin() {
      if (fini) return;
      if (coupe) { terminer(); return; }
      if (finDemandee && !tampon.trim() && tete >= segments.length) {
        // Le decoupage reel se lit dans le journal : un blanc entendu au milieu d'une phrase s'y voit tout de suite.
        if (segments.length > 1) log(`[lecture] n°${marque} morceaux : ${segments.map((s) => `« ${s.texte.trim().slice(0, 50)} »`).join(" | ")} ${t()}`);
        terminer();
      }
    }
    // Joue dans l'ordre : la tete passe en direct, les suivants attendent leur tour en memoire.
    function avancer() {
      while (tete < segments.length && segments[tete].termine) {
        tete++;
        const s = segments[tete];
        if (s) { for (const m of s.morceaux.splice(0)) livrer(m); }
      }
      verifierFin();
    }
    function livrer(m) {
      if (coupe) return;
      if (!premierSonA) premierSonA = Date.now();
      octets += m.length;
      surSon(m);
    }
    function lancer(texte) {
      const lisible = texteALire(texte);
      if (!lisible.trim()) return;
      const idx = segments.length;
      const s = { texte: lisible, morceaux: [], termine: false, etat: { coupe: false, premierOctet: 0, annuler: null }, depuis: Date.now() };
      segments.push(s);
      const precedent = dit;
      dit = `${dit} ${lisible}`.trim();
      const rognure = creerRognure({ premier: idx === 0 });
      const emettre = (m) => { if (coupe || !m.length) return; if (idx === tete) livrer(m); else s.morceaux.push(m); };
      const surMorceau = (m) => { if (coupe) return; for (const x of rognure.pousser(m)) emettre(x); };
      const essai = (n) => synthetiser(cfg, lisible, precedent, surMorceau, s.etat).catch((err) => {
        if (coupe || s.etat.coupe) return;
        if (n === 0 && !s.etat.premierOctet && reessayable(err)) {
          log(`[lecture] n°${marque} morceau ${idx + 1} : ${err.message}, nouvel essai ${t()}`);
          return new Promise((r) => setTimeout(r, 150)).then(() => essai(1));
        }
        throw err;
      });
      essai(0).then(() => {
        for (const x of rognure.finir()) emettre(x);
        if (idx === 0 && s.etat.premierOctet) log(`[lecture] n°${marque} premier son ElevenLabs ${s.etat.premierOctet - s.depuis} ms apres l'envoi, ${s.depuis - premierTexteA} ms de decoupe ${t()}`);
      }).catch((err) => {
        if (coupe) return;
        log(`[lecture] ECHEC n°${marque} morceau ${idx + 1} « ${lisible.slice(0, 60)} » : ${err.message} ${t()}`);
        if (!echoue) { echoue = true; surEchec?.({ octetsLivres: octets, erreur: err.message }); }
        coupe = true; // plus rien de cette reponse ne sort par ElevenLabs
        for (const o of segments) if (o !== s) { o.etat.coupe = true; o.etat.annuler?.(); }
      }).finally(() => { s.termine = true; avancer(); });
    }
    function traiter() {
      minuteurDecoupe = null;
      if (coupe) return;
      const presse = premierTexteA > 0 && Date.now() - premierTexteA >= ATTENTE_PREMIER_MS;
      for (;;) {
        const { part, reste } = decouper(tampon, { premier: segments.length === 0, presse, fin: finDemandee });
        if (!part) break;
        tampon = reste;
        lancer(part);
      }
      verifierFin();
    }

    return {
      marque,
      get fini() { return fini; },
      get octets() { return octets; },
      get texteRecu() { return premierTexteA > 0; },
      texte(delta) {
        if (coupe || fini || !delta) return;
        if (!premierTexteA) {
          premierTexteA = Date.now();
          // Sans ponctuation dans ce delai, le premier morceau part quand meme, coupe au dernier mot entier.
          minuteurPremier = setTimeout(() => { if (!segments.length) traiter(); }, ATTENTE_PREMIER_MS + 5);
        }
        tampon += delta;
        // 30 ms de battement : deux morceaux de Grok arrivent souvent dans la meme milliseconde (« Bien sûr,
        // c'est tout à fait » puis « possible ! Deux Regina... »), et couper entre eux casse l'intonation.
        if (!minuteurDecoupe) minuteurDecoupe = setTimeout(traiter, 30);
      },
      fin() {
        if (coupe || fini) return;
        finDemandee = true;
        clearTimeout(minuteurDecoupe);
        traiter();
      },
      couper() {
        if (coupe && fini) return;
        coupe = true;
        for (const s of segments) { s.etat.coupe = true; s.etat.annuler?.(); }
        terminer();
      },
      quandFini(cb) {
        if (fini) setImmediate(cb);
        else quandFinis.push(cb);
      },
    };
  }

  // La voix d'une phrase fixe, en entier, rognee comme un premier morceau, depuis le cache quand elle y est.
  function accueil(texte) {
    const lisible = texteALire(texte);
    const cleCache = [cfg.voix, cfg.modele, cfg.balise, cfg.langue, cfg.stabilite, cfg.similarite, lisible].join("|");
    const deja = cacheAccueil.get(cleCache);
    if (deja) return deja.then((ulaw) => ({ ulaw, cache: true }));
    const rognure = creerRognure({ premier: true });
    const parts = [];
    const p = synthetiser(cfg, lisible, "", (m) => { for (const x of rognure.pousser(m)) parts.push(x); }, { coupe: false, premierOctet: 0, annuler: null })
      .then(() => { for (const x of rognure.finir()) parts.push(x); const b = Buffer.concat(parts); if (!b.length) throw new Error("accueil vide"); return b; });
    cacheAccueil.set(cleCache, p);
    p.catch(() => cacheAccueil.delete(cleCache));
    if (cacheAccueil.size > 50) cacheAccueil.delete(cacheAccueil.keys().next().value);
    return p.then((ulaw) => ({ ulaw, cache: false }));
  }

  return { flux, chauffer, accueil, cfg };
}
