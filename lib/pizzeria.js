// Outils de prise de commande d'une pizzeria (profil AGENT_TOOLS=pizzeria).
// Tout ce qui se calcule (total, heure de retrait) est calcule ICI et jamais par le modele :
// un modele vocal se trompe sur les additions et invente des disponibilites.
//
// Capacite : le four sort CAPACITE_PAR_QUART pizzas par quart d'heure. Une commande de n pizzas
// retiree a l'heure T occupe les quarts d'heure qui precedent T, en remontant tant qu'il le faut.
// Seules les commandes prises au telephone par l'agent sont comptees : le comptoir, les halles et
// les plateformes de livraison ne sont pas visibles, d'ou la reserve configurable.

import fs from "fs";

const UNITES = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
function fr2(n) {
  if (n < 20) return UNITES[n];
  if (n < 70) { const t = Math.floor(n / 10), u = n % 10, d = { 2: "vingt", 3: "trente", 4: "quarante", 5: "cinquante", 6: "soixante" }[t]; return u === 0 ? d : u === 1 ? d + "-et-un" : d + "-" + UNITES[u]; }
  if (n < 80) return n === 71 ? "soixante-et-onze" : "soixante-" + UNITES[n - 60];
  if (n === 80) return "quatre-vingts";
  return "quatre-vingt-" + UNITES[n - 80];
}
export function frNombre(n) {
  n = Math.round(n);
  if (n < 100) return fr2(n);
  if (n < 1000) { const c = Math.floor(n / 100), r = n % 100; const cent = c === 1 ? "cent" : UNITES[c] + " cent" + (r === 0 ? "s" : ""); return r ? cent + " " + fr2(r) : cent; }
  return String(n);
}
export function frEuros(x) {
  const e = Math.floor(x + 1e-9), c = Math.round((x - e) * 100);
  return `${frNombre(e)} euro${e > 1 ? "s" : ""}${c ? " " + fr2(c) : ""}`;
}
export function heureOrale(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${frNombre(h)} heure${h > 1 ? "s" : ""}${m ? " " + fr2(m) : ""}`;
}
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export function parseHeure(s) {
  const m = String(s || "").trim().match(/^(\d{1,2})\s*(?:h|:)\s*(\d{2})?/i);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] || 0);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}
const round2 = (x) => Math.round(x * 100) / 100;

function norm(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(pizzas?|la|le|les|l|une|un|des|de|du|d)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}
function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function score(demande, nom) {
  const a = norm(demande), b = norm(nom);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 4 && (b.includes(a) || a.includes(b))) return 0.9;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}
const scoreItem = (demande, it) => Math.max(score(demande, it.nom), ...(it.alias || []).map((a) => score(demande, a)));
// Un rapprochement approximatif partage entre deux articles (« jambon » : blanc ou de Parme ?)
// est refuse : mieux vaut faire preciser le client que facturer le mauvais.
function trouver(liste, demande) {
  const notes = liste.map((it) => [it, scoreItem(demande, it)]);
  const best = Math.max(0, ...notes.map((x) => x[1]));
  const ex = notes.filter((x) => x[1] === best);
  if (best < 0.8 || (best < 1 && ex.length > 1)) return null;
  return ex[0][0];
}
function proches(liste, demande) {
  return liste.map((it) => [it.nom, scoreItem(demande, it)]).sort((x, y) => y[1] - x[1]).slice(0, 3).map((x) => x[0]);
}

// Date et minutes depuis minuit dans le fuseau du restaurant (le serveur tourne en UTC).
function momentLocal(date, timeZone) {
  const f = new Intl.DateTimeFormat("fr-FR", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { dateKey: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), jour: p.weekday, libelle: `${p.weekday} ${Number(p.day)}/${p.month}` };
}

// Nom normalise pour les ruptures : le MEME calcul que `normaliserNom` de Dale Voz
// (packages/core/src/restaurant-calcul.ts). S'ils divergent, une rupture tapee sur la
// tablette ne retire plus rien au telephone.
function normNom(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
// Les ingredients d'un produit : sa description decoupee aux virgules, sans les morceaux
// qui portent un prix ou un supplement (« Supplement burrata ou bufala 4,50 € » de la planche).
function ingredientsDe(p) {
  return String(p.description ?? "").split(/[,.](?!\d)/)
    .map((x) => x.replace(/\(.*?\)/g, "").trim())
    .filter((x) => !/\d/.test(x) && !/^suppl[ée]ment/i.test(x) && normNom(x).length >= 3)
    .map(normNom);
}
function toucheParRupture(p, r) {
  if (r.genre === "produit") return normNom(p.nom) === r.cle || (p.alias || []).some((a) => normNom(a) === r.cle);
  return ingredientsDe(p).some((ing) => ` ${ing} `.includes(` ${r.cle} `));
}
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

export function createPizzeria(opts = {}) {
  const {
    menuFile,
    dataFile = "",
    capaciteParQuart = 15,
    reserveParQuart = 0,
    delaiMinMinutes = 20,
    maxPizzas = 20,
    services: servicesTxt = "11:30-14:30,18:30-22:30",
    timeZone = "Europe/Paris",
    maintenant = () => new Date(),
    // LE TABLEAU DU RESTAURANT (17/09/2026) : { lireEtat, ecrireCommande, ecrireRappel, pousserCarte },
    // chacun recoit { tenantId, agentSlug }. Absent : tout reste local, comme avant.
    distant = null,
    ecritureTimeoutMs = 4000,
    rafraichirApresMs = 8000,
  } = opts;

  const menu = JSON.parse(fs.readFileSync(menuFile, "utf8"));
  const produits = menu.produits || [];
  const supplements = menu.supplements || [];
  const parseServices = (txt) => String(txt || "").split(",").map((s) => s.split("-").map(parseHeure)).filter((s) => s[0] != null && s[1] != null);
  const servicesLocaux = parseServices(servicesTxt);

  let commandes = [], messages = [], enAttente = [];
  try { if (dataFile) ({ commandes = [], messages = [], enAttente = [] } = JSON.parse(fs.readFileSync(dataFile, "utf8"))); } catch {}
  const charge = new Map(); // "YYYY-MM-DD|minutes de fin du quart" -> pizzas deja au four
  const cle = (dateKey, fin) => `${dateKey}|${fin}`;
  const appliquer = (cmd, signe) => { for (const [fin, n] of cmd.allocation || []) { const k = cle(cmd.dateKey, fin); charge.set(k, (charge.get(k) || 0) + signe * n); } };
  commandes.forEach((c) => appliquer(c, 1));
  const sauver = () => { if (!dataFile) return; try { fs.writeFileSync(dataFile, JSON.stringify({ commandes, messages, enAttente })); } catch (e) { console.error("[pizzeria] save KO", e.message); } };

  // L'etat regle sur la tablette, tel que Dale Voz l'a rendu. Quand il existe, il PRIME sur la
  // configuration locale (capacite, delai, services) et remplace la charge en memoire : un
  // redeploiement du pont n'oublie plus les pizzas deja au four.
  let etat = null; // { recuLe, poste, jours: { [dateKey]: { charge: Map, quartsFermes: Set, ruptures, allocationsParAppel } } }
  let dvDefaut = null;
  let cartePoussee = false;

  const cfg = () => {
    const p = etat?.poste;
    if (!p) return { capacite: Math.max(1, capaciteParQuart - reserveParQuart), delaiMin: delaiMinMinutes, maxPizzas, services: servicesLocaux, timeZone };
    const services = parseServices(p.services);
    return {
      capacite: Math.max(1, Number(p.capaciteParQuart) - Math.max(0, Number(p.reserveParQuart) || 0)),
      delaiMin: Number(p.delaiMinMinutes),
      maxPizzas: Number(p.maxPizzas),
      services: services.length ? services : servicesLocaux,
      timeZone: p.fuseau || timeZone,
    };
  };
  const jourDistant = (dateKey) => etat?.jours?.[dateKey] || null;

  // Pizzas deja placees dans un quart. `exclureAppel` : la commande que cet appel REMPLACE.
  function chargeDe(dateKey, fin, exclureAppel) {
    const j = jourDistant(dateKey);
    if (!j) return charge.get(cle(dateKey, fin)) || 0;
    let n = j.charge.get(fin) || 0;
    for (const [f, x] of (exclureAppel && j.allocationsParAppel[exclureAppel]) || []) if (f === fin) n -= x;
    // Ce qui est enregistre ici mais pas encore arrive dans Dale Voz compte aussi.
    for (const e of enAttente) {
      if (e.type !== "commande" || e.corps.dateService !== dateKey || e.corps.appelId === exclureAppel) continue;
      for (const [f, x] of e.corps.allocation || []) if (f === fin) n += x;
    }
    return Math.max(0, n);
  }
  const quartFerme = (dateKey, fin) => Boolean(jourDistant(dateKey)?.quartsFermes.has(fin));
  const rupturesDu = (dateKey) => jourDistant(dateKey)?.ruptures || [];

  // Pause : plus aucune nouvelle commande au telephone. Fermeture : pour ce jour-la seulement.
  function blocage(dateKey) {
    const p = etat?.poste;
    if (!p) return null;
    if (p.pauseJusqua && new Date(p.pauseJusqua).getTime() > maintenant().getTime()) {
      const fin = momentLocal(new Date(p.pauseJusqua), cfg().timeZone).minutes;
      return { raison: `les commandes par téléphone sont en pause jusqu'à ${hhmm(fin)}`, consigne: `Ne prendre aucune commande. Proposer de transmettre la demande à l'équipe avec transmettre_message, ou de rappeler après ${heureOrale(fin)}.` };
    }
    if (p.fermeLe && p.fermeLe === dateKey) {
      return { raison: "le restaurant ne prend plus de commandes par téléphone aujourd'hui", consigne: "Proposer une commande pour demain, ou transmettre la demande à l'équipe avec transmettre_message." };
    }
    return null;
  }

  function jourCible(jour) {
    const tz = cfg().timeZone;
    const aujourdhui = momentLocal(maintenant(), tz);
    if (jour === "demain") return { ...momentLocal(new Date(maintenant().getTime() + 86400000), tz), minutesNow: -1 };
    return { ...aujourdhui, minutesNow: aujourdhui.minutes };
  }

  // Remonte depuis l'heure de retrait T en remplissant les quarts d'heure libres du meme service.
  // Un quart ferme sur la tablette ne recoit aucune pizza.
  function allouer(dateKey, T, n, debutService, minutesNow, exclureAppel) {
    const { capacite } = cfg();
    let reste = n; const allocation = [];
    for (let fin = T; reste > 0 && fin - 15 >= debutService && (minutesNow < 0 || fin - 15 >= minutesNow); fin -= 15) {
      const libre = quartFerme(dateKey, fin) ? 0 : capacite - chargeDe(dateKey, fin, exclureAppel);
      if (libre > 0) { const t = Math.min(libre, reste); allocation.push([fin, t]); reste -= t; }
    }
    return reste === 0 ? allocation : null;
  }

  function chercherCreneau(n, heureSouhaitee, jour, exclureAppel) {
    const { delaiMin, services } = cfg();
    const j = jourCible(jour);
    const plusTot = j.minutesNow < 0 ? 0 : j.minutesNow + delaiMin;
    const cible = heureSouhaitee != null ? parseHeure(heureSouhaitee) : null;
    const depart = Math.ceil(Math.max(cible ?? 0, plusTot) / 15) * 15;
    for (const [debut, fin] of services) {
      for (let T = Math.max(depart, debut + 15); T <= fin; T += 15) {
        if (quartFerme(j.dateKey, T)) continue;
        const allocation = allouer(j.dateKey, T, n, debut, j.minutesNow, exclureAppel);
        if (allocation) return { j, T, allocation, cible };
      }
    }
    return { j, T: null, cible };
  }

  function chiffrer(articles, dateKey = jourCible().dateKey) {
    const lignes = [], inconnus = [], prixManquants = [], indisponibles = [];
    let total = 0, nbPizzas = 0;
    const ruptures = rupturesDu(dateKey);
    for (const a of Array.isArray(articles) ? articles : []) {
      const q = Math.max(1, Math.round(Number(a.quantite) || 1));
      const p = trouver(produits, a.produit);
      if (!p) { inconnus.push({ demande: a.produit, proches: proches(produits, a.produit) }); continue; }
      // Une rupture declaree sur la tablette retire le produit, et un stock limite plafonne la quantite.
      const epuise = ruptures.find((r) => toucheParRupture(p, r) && (r.restant == null || r.restant <= 0));
      if (epuise) { indisponibles.push({ produit: p.nom, raison: epuise.genre === "produit" ? "épuisé aujourd'hui" : `plus de ${String(epuise.libelle).toLowerCase()} aujourd'hui` }); continue; }
      const limite = ruptures.find((r) => toucheParRupture(p, r) && r.restant != null && q > r.restant);
      if (limite) { indisponibles.push({ produit: p.nom, raison: `il n'en reste que ${limite.restant} aujourd'hui` }); continue; }
      let unit = p.prix_eur;
      if (unit == null) prixManquants.push(p.nom);
      const sups = [];
      for (const s of Array.isArray(a.supplements) ? a.supplements : []) {
        const ms = trouver(supplements, s);
        if (!ms) { inconnus.push({ demande: `supplément ${s}`, proches: proches(supplements, s) }); continue; }
        sups.push(ms.nom);
        if (ms.prix_eur == null) prixManquants.push(ms.nom); else if (unit != null) unit += ms.prix_eur;
      }
      const sousTotal = unit == null ? null : round2(unit * q);
      if (sousTotal != null) total += sousTotal;
      nbPizzas += (p.pizzas || 0) * q;
      lignes.push({ produit: p.nom, quantite: q, prix_unitaire_eur: unit, supplements: sups, retraits: a.retraits || [], remarque: a.remarque || "", sous_total_eur: sousTotal });
    }
    total = round2(total);
    return { lignes, inconnus, prixManquants, indisponibles, total, nbPizzas };
  }

  function proposerHeure({ nb_pizzas, heure_souhaitee, jour }, ctx = {}) {
    const n = Math.max(0, Math.round(Number(nb_pizzas) || 0));
    const { maxPizzas, services } = cfg();
    const bloque = blocage(jourCible(jour).dateKey);
    if (bloque) return { disponible: false, ...bloque };
    if (n > maxPizzas) return { disponible: false, raison: `commande de groupe (plus de ${maxPizzas} pizzas)`, consigne: "Ne pas enregistrer : prendre le prénom et le détail avec transmettre_message, l'équipe rappelle pour confirmer." };
    const r = chercherCreneau(n, heure_souhaitee, jour, ctx.callSid || null);
    if (r.T == null) {
      const demain = jour === "demain" ? null : chercherCreneau(n, null, "demain");
      return { disponible: false, jour: r.j.libelle, raison: "plus aucun créneau possible sur ce jour (service terminé ou four complet)", premier_creneau_demain: demain && demain.T != null ? { heure_retrait: hhmm(demain.T), heure_orale: heureOrale(demain.T) } : null };
    }
    const decale = r.cible != null && r.T > Math.ceil(r.cible / 15) * 15;
    return {
      disponible: true, jour: r.j.libelle, heure_retrait: hhmm(r.T), heure_orale: heureOrale(r.T),
      ...(decale ? { note: `l'heure souhaitée (${hhmm(r.cible)}) n'est pas possible, c'est la première heure qui tient` } : {}),
      ...(r.cible != null && services.every(([d, f]) => r.cible < d + 15 || r.cible > f) ? { note_horaires: "l'heure demandée est hors des services" } : {}),
    };
  }

  // Prenoms de remplissage : le modele en invente quand il a oublie de demander (constate au banc).
  const PRENOM_FACTICE = /^(client|cliente|inconnu|inconnue|anonyme|monsieur|madame|mr|mme|non (communiqué|précisé|renseigné)|n\/?a|x|test|customer|guest)$/i;
  function enregistrer({ prenom, heure_retrait, jour, articles, remarque }, ctx = {}) {
    if (!String(prenom || "").trim() || PRENOM_FACTICE.test(String(prenom).trim())) return { ok: false, raison: "prénom manquant : demander le prénom au client, ne jamais l'inventer" };
    // ctx.recapConfirme est calcule par le pont (recapitulatif dit, puis le client a parle). Absent = non verifie.
    if (ctx.recapConfirme === false) return { ok: false, raison: "récapitulatif non confirmé : récapituler en une phrase (produits, heure, prénom, total), demander si c'est bien ça, attendre le oui du client, puis rappeler enregistrer_commande" };
    const { maxPizzas, services, delaiMin } = cfg();
    const j = jourCible(jour);
    const bloque = blocage(j.dateKey);
    if (bloque) return { ok: false, ...bloque };
    const c = chiffrer(articles, j.dateKey);
    if (c.indisponibles.length) return { ok: false, raison: "des articles ne sont plus disponibles : le dire au client et proposer autre chose avant d'enregistrer", indisponibles: c.indisponibles };
    if (!c.lignes.length) return { ok: false, raison: "aucun article reconnu", inconnus: c.inconnus };
    if (c.inconnus.length) return { ok: false, raison: "des articles ne sont pas sur la carte, les faire préciser avant d'enregistrer", inconnus: c.inconnus };
    if (c.nbPizzas > maxPizzas) return { ok: false, raison: `commande de groupe (plus de ${maxPizzas} pizzas) : passer par transmettre_message` };
    const T = parseHeure(heure_retrait);
    if (T == null) return { ok: false, raison: "heure_retrait illisible, format HH:MM attendu" };

    // Une commande par appel : la reprendre remplace la precedente (le client corrige).
    const precedente = ctx.callSid ? commandes.find((x) => x.callSid === ctx.callSid) : null;
    if (precedente) { appliquer(precedente, -1); commandes = commandes.filter((x) => x !== precedente); }

    const service = services.find(([d, f]) => T >= d + 15 && T <= f);
    const allocation = service && !quartFerme(j.dateKey, T) && (j.minutesNow < 0 || T >= j.minutesNow + delaiMin) ? allouer(j.dateKey, T, c.nbPizzas, service[0], j.minutesNow, ctx.callSid || null) : null;
    if (!allocation) {
      if (precedente) { commandes.unshift(precedente); appliquer(precedente, 1); }
      const alt = proposerHeure({ nb_pizzas: c.nbPizzas, heure_souhaitee: heure_retrait, jour }, ctx);
      return { ok: false, raison: "cette heure de retrait n'est plus tenable", alternative: alt };
    }
    const numero = precedente ? precedente.numero : commandes.filter((x) => x.dateKey === j.dateKey).length + 1;
    const cmd = {
      ts: new Date().toISOString(), numero, callSid: ctx.callSid || null, telephone: ctx.from || null,
      prenom: String(prenom).trim(), dateKey: j.dateKey, jour: j.libelle, heure_retrait: hhmm(T),
      lignes: c.lignes, total_eur: c.total, prix_manquants: c.prixManquants, remarque: remarque || "", allocation, nb_pizzas: c.nbPizzas,
    };
    appliquer(cmd, 1);
    commandes.unshift(cmd);
    if (commandes.length > 300) commandes.length = 300;
    sauver();
    return { ok: true, numero, prenom: cmd.prenom, jour: j.libelle, heure_retrait: cmd.heure_retrait, heure_orale: heureOrale(T), total_eur: c.total, total_oral: frEuros(c.total), ...(c.prixManquants.length ? { attention: `prix inconnu pour : ${c.prixManquants.join(", ")}, total incomplet` } : {}) };
  }

  function transmettre({ prenom, motif, details }, ctx = {}) {
    // Un message par appel : un second appel (doublon du modele, ou prenom donne apres coup) complete le premier.
    const existant = ctx.callSid ? messages.find((m) => m.callSid === ctx.callSid) : null;
    if (existant) {
      if (prenom && !existant.prenom) existant.prenom = prenom;
      if (motif && !existant.motif.includes(motif)) existant.motif = existant.motif ? `${existant.motif} ; ${motif}` : motif;
      if (details && !existant.details.includes(details)) existant.details = existant.details ? `${existant.details} ${details}` : details;
      sauver();
      return { ok: true, deja_transmis: true, consigne: "Déjà transmis à l'équipe, complété. Ne pas le redire deux fois." };
    }
    messages.unshift({ ts: new Date().toISOString(), callSid: ctx.callSid || null, telephone: ctx.from || null, prenom: prenom || "", motif: motif || "", details: details || "" });
    if (messages.length > 300) messages.length = 300;
    sauver();
    return { ok: true, consigne: "Dire que l'équipe rappelle au numéro depuis lequel la personne appelle, dès que possible." };
  }

  const ARTICLES = {
    type: "array",
    description: "Les articles, un par produit distinct.",
    items: {
      type: "object",
      properties: {
        produit: { type: "string", description: "Nom du produit tel qu'il figure sur la carte." },
        quantite: { type: "integer", minimum: 1 },
        supplements: { type: "array", items: { type: "string" }, description: "Suppléments payants demandés, noms de la carte." },
        retraits: { type: "array", items: { type: "string" }, description: "Ingrédients à retirer (sans supplément de prix)." },
        remarque: { type: "string" },
      },
      required: ["produit", "quantite"],
    },
  };
  const JOUR = { type: "string", enum: ["aujourd_hui", "demain"], description: "Par défaut aujourd_hui." };

  const tools = [
    { type: "function", name: "chiffrer_commande", description: "Calcule le détail et le TOTAL exact d'une commande à partir de la carte. À appeler dès que le client a dit ce qu'il veut, et à chaque modification, AVANT d'annoncer un prix. Ne jamais additionner soi-même.", parameters: { type: "object", properties: { articles: ARTICLES }, required: ["articles"] } },
    { type: "function", name: "proposer_heure_retrait", description: "Donne la première heure de retrait possible selon la charge du four. À appeler avant d'annoncer ou d'accepter une heure. Ne jamais promettre une heure sans cet outil.", parameters: { type: "object", properties: { nb_pizzas: { type: "integer", minimum: 0 }, heure_souhaitee: { type: "string", description: "Heure demandée par le client, format HH:MM sur 24 heures. Omettre si le client veut le plus tôt possible." }, jour: JOUR }, required: ["nb_pizzas"] } },
    { type: "function", name: "enregistrer_commande", description: "Enregistre la commande DÉFINITIVE, uniquement après que le client a confirmé le récapitulatif, le total, son prénom et l'heure de retrait. Le rappeler dans le même appel remplace la commande.", parameters: { type: "object", properties: { prenom: { type: "string" }, heure_retrait: { type: "string", description: "HH:MM sur 24 heures, celle donnée par proposer_heure_retrait." }, jour: JOUR, articles: ARTICLES, remarque: { type: "string" } }, required: ["prenom", "heure_retrait", "articles"] } },
    { type: "function", name: "transmettre_message", description: "Transmet à l'équipe une demande qu'un humain doit traiter : réclamation, geste commercial, allergie ou intolérance, grossesse, commande de groupe, question sans réponse sûre. L'équipe rappelle le numéro appelant.", parameters: { type: "object", properties: { prenom: { type: "string" }, motif: { type: "string", description: "Le motif en quelques mots." }, details: { type: "string" } }, required: ["motif"] } },
  ];

  // Dernier chiffrage par appel. L'outil est sans etat : quand le client ajoute un produit, le modele
  // rechiffre parfois l'ajout seul et perd le reste (constate au banc le 15/09/2026). On lui signale
  // ce qui a disparu d'un chiffrage a l'autre ; c'est a lui de verifier aupres du client.
  const derniersChiffrages = new Map();
  function run(name, args, ctx = {}) {
    if (name === "chiffrer_commande") {
      const c = chiffrer(args.articles);
      const avant = ctx.callSid ? derniersChiffrages.get(ctx.callSid) : null;
      const disparus = avant ? avant.filter((nom) => !c.lignes.some((l) => l.produit === nom)) : [];
      if (ctx.callSid) derniersChiffrages.set(ctx.callSid, c.lignes.map((l) => l.produit));
      return { lignes: c.lignes, nb_pizzas: c.nbPizzas, total_eur: c.total, total_oral: frEuros(c.total), ...(disparus.length ? { attention: `Absents de ce chiffrage alors qu'ils étaient dans le précédent : ${disparus.join(", ")}. Chaque chiffrage doit reprendre la commande ENTIÈRE. Si le client ne les a pas annulés, rechiffrer avec eux avant d'annoncer le total.` } : {}), ...(c.inconnus.length ? { inconnus: c.inconnus, consigne: "Ces articles ne sont pas sur la carte : proposer les plus proches ou faire répéter." } : {}), ...(c.prixManquants.length ? { prix_inconnus: c.prixManquants, consigne_prix: "Ne pas inventer ces prix : dire qu'ils seront confirmés au comptoir." } : {}), ...(c.indisponibles.length ? { indisponibles: c.indisponibles, consigne_disponibilite: "Ces produits ne sont plus disponibles aujourd'hui : le dire simplement et proposer autre chose de la carte. Ils ne sont pas comptés dans le total." } : {}) };
    }
    if (name === "proposer_heure_retrait") return proposerHeure(args, ctx);
    if (name === "enregistrer_commande") return enregistrer(args, ctx);
    if (name === "transmettre_message") return transmettre(args, ctx);
    return { ok: false, raison: `outil inconnu ${name}` };
  }

  // Garde de cloture : le modele peut remercier « pour votre commande » sans avoir appele
  // enregistrer_commande (constate au banc le 15/09/2026). Le prompt l'interdit, mais un prompt
  // n'est pas un invariant : si la phrase de cloture d'une commande part alors que rien n'est
  // enregistre pour cet appel, on renvoie une consigne une seule fois.
  // Seule la phrase de cloture definitive declenche : « c'est note » ou « ce sera pret » se disent
  // aussi en cours de commande, et une consigne a tort ferait enregistrer avant la confirmation.
  const CLOTURE_COMMANDE = /merci pour votre commande|thank you for your order|gracias por su pedido|grazie per (il suo |l')?ordine/i;
  function consigneCloture(texte, ctx = {}) {
    if (!CLOTURE_COMMANDE.test(texte || "")) return null;
    if ((ctx.outils || []).includes("enregistrer_commande")) return null;
    if (ctx.callSid && commandes.some((c) => c.callSid === ctx.callSid)) return null;
    return "(SYSTÈME : tu viens d'annoncer la commande comme notée, mais enregistrer_commande n'a pas été appelé : rien n'est enregistré. Si le client a confirmé le récapitulatif, appelle enregistrer_commande maintenant avec exactement les éléments confirmés, puis confirme en une phrase courte que c'est bien enregistré. Si aucune commande n'a été confirmée, excuse-toi brièvement et reprends le récapitulatif.)";
  }

  function contexteAppel() {
    const { services, timeZone: tz } = cfg();
    const m = momentLocal(maintenant(), tz);
    const enCours = services.find(([d, f]) => m.minutes >= d && m.minutes < f);
    const prochain = services.find(([d]) => m.minutes < d);
    const etatService = enCours ? `service en cours jusqu'à ${hhmm(enCours[1])}` : prochain ? `restaurant fermé, prochain service à ${hhmm(prochain[0])}` : "services du jour terminés, prochain service demain";
    const lignes = [`Nous sommes ${m.libelle}, il est ${hhmm(m.minutes)} (heure locale du restaurant). État : ${etatService}. Salutation : ${m.minutes >= 17 * 60 ? "bonsoir" : "bonjour"}.`];
    // Ce que le restaurant a regle sur sa tablette, dit au modele des le decroche. Les outils
    // l'appliquent de toute facon : ceci evite qu'il propose ce qu'on lui refusera ensuite.
    const bloque = blocage(m.dateKey);
    if (bloque) lignes.push(`IMPORTANT : ${bloque.raison}. ${bloque.consigne}`);
    const ruptures = rupturesDu(m.dateKey);
    const epuises = [], limites = [];
    for (const r of ruptures) {
      const noms = produits.filter((p) => toucheParRupture(p, r)).map((p) => p.nom);
      const quoi = noms.length ? noms.join(", ") : r.libelle;
      if (r.restant == null || r.restant <= 0) epuises.push(r.genre === "produit" ? quoi : `${quoi} (plus de ${String(r.libelle).toLowerCase()})`);
      else limites.push(`${quoi} (il n'en reste que ${r.restant})`);
    }
    if (epuises.length) lignes.push(`Plus disponible aujourd'hui : ${epuises.join(" ; ")}. Ne pas les proposer.`);
    if (limites.length) lignes.push(`Quantité limitée aujourd'hui : ${limites.join(" ; ")}.`);
    return lignes.join("\n");
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Le lien avec le tableau du restaurant dans Dale Voz                                       */
  /* ---------------------------------------------------------------------------------------- */

  // Relit l'etat du restaurant (8 s de cache). Sans reponse, on garde le dernier etat connu :
  // une panne de Dale Voz ne doit pas rendre au pont une charge du four vide.
  async function rafraichir(dv, { forcer = false } = {}) {
    if (!distant || !dv?.tenantId || !dv?.agentSlug) return;
    dvDefaut = dv;
    if (!forcer && etat && Date.now() - etat.recuLe < rafraichirApresMs) return;
    let brut;
    try { brut = await distant.lireEtat(dv); } catch { brut = undefined; }
    if (brut === undefined) return;
    if (brut === null) { etat = null; return; }
    const jours = {};
    for (const k of ["aujourdhui", "demain"]) {
      const d = brut[k];
      if (!d?.date) continue;
      jours[d.date] = {
        charge: new Map(Object.entries(d.charge || {}).map(([f, n]) => [Number(f), Number(n)])),
        quartsFermes: new Set((d.quartsFermes || []).map(Number)),
        ruptures: Array.isArray(d.ruptures) ? d.ruptures : [],
        allocationsParAppel: d.allocationsParAppel || {},
      };
    }
    etat = { recuLe: Date.now(), poste: brut.poste || null, jours };
    if (!cartePoussee && distant.pousserCarte) {
      cartePoussee = true;
      Promise.resolve(distant.pousserCarte(dv, { produits, supplements })).then((r) => { if (!r) cartePoussee = false; }).catch(() => { cartePoussee = false; });
    }
  }

  const corpsCommande = (cmd) => ({
    appelId: cmd.callSid, telephone: cmd.telephone, prenom: cmd.prenom, dateService: cmd.dateKey,
    heureRetrait: cmd.heure_retrait, lignes: cmd.lignes, totalEur: cmd.total_eur, prixManquants: cmd.prix_manquants,
    remarque: cmd.remarque || null, allocation: cmd.allocation, nbPizzas: cmd.nb_pizzas ?? (cmd.allocation || []).reduce((s, [, n]) => s + n, 0),
  });

  // Ce que Dale Voz sait desormais : la charge et le stock limite suivent sans attendre la relecture.
  function integrerCommande(corps) {
    const j = jourDistant(corps.dateService);
    if (!j) return;
    for (const [f, x] of j.allocationsParAppel[corps.appelId] || []) j.charge.set(f, (j.charge.get(f) || 0) - x);
    for (const [f, x] of corps.allocation || []) j.charge.set(f, (j.charge.get(f) || 0) + x);
    if (corps.appelId) j.allocationsParAppel[corps.appelId] = corps.allocation;
    for (const r of j.ruptures) {
      if (r.restant == null) continue;
      let pris = 0;
      for (const l of corps.lignes || []) {
        const p = produits.find((x) => x.nom === l.produit) || { nom: l.produit };
        if (toucheParRupture(p, r)) pris += l.quantite;
      }
      if (pris) r.restant = Math.max(0, r.restant - pris);
    }
  }

  function mettreEnAttente(type, dv, corps) {
    const i = enAttente.findIndex((e) => e.type === type && corps.appelId && e.corps.appelId === corps.appelId && type === "commande");
    const entree = { type, dv, corps, essais: 0, depuis: new Date().toISOString() };
    if (i >= 0) enAttente[i] = entree; else enAttente.push(entree);
    sauver();
    console.error(`[restaurant] ${type} mise en attente (${enAttente.length} en attente)`);
  }

  let videEnCours = false;
  async function viderAttente() {
    if (!distant || videEnCours || !enAttente.length) return;
    videEnCours = true;
    try {
      for (const e of [...enAttente]) {
        const r = await (e.type === "commande" ? distant.ecrireCommande(e.dv, e.corps) : distant.ecrireRappel(e.dv, e.corps)).catch(() => null);
        if (r) {
          enAttente = enAttente.filter((x) => x !== e);
          if (e.type === "commande") {
            const cmd = commandes.find((c) => c.callSid && c.callSid === e.corps.appelId);
            if (cmd && r.numero) cmd.numero = r.numero;
            integrerCommande(e.corps);
          }
          console.log(`[restaurant] ${e.type} en attente envoyée`);
        } else if (++e.essais >= 40) {
          enAttente = enAttente.filter((x) => x !== e);
          console.error(`[restaurant] ${e.type} abandonnée après 40 essais : ${JSON.stringify(e.corps).slice(0, 300)}`);
        }
      }
      sauver();
    } finally {
      videEnCours = false;
    }
  }
  if (distant) setInterval(() => { viderAttente(); }, 30000).unref?.();

  // Ce que le serveur appelle : relit l'etat avant de chiffrer, proposer ou enregistrer, puis
  // ecrit dans Dale Voz ce qui vient d'etre enregistre. `run` reste synchrone pour les bancs.
  async function runAsync(name, args, ctx = {}) {
    const dv = ctx.dv || dvDefaut;
    if (distant && dv && ["chiffrer_commande", "proposer_heure_retrait", "enregistrer_commande"].includes(name)) {
      await Promise.race([rafraichir(dv), attendre(2500)]);
    }
    const out = run(name, args, ctx);
    if (!distant || !dv || !out?.ok) return out;
    if (name === "enregistrer_commande") {
      const cmd = commandes.find((c) => (ctx.callSid ? c.callSid === ctx.callSid : false)) || commandes[0];
      const corps = corpsCommande(cmd);
      const r = await Promise.race([Promise.resolve(distant.ecrireCommande(dv, corps)).catch(() => null), attendre(ecritureTimeoutMs).then(() => undefined)]);
      if (r?.numero) {
        cmd.numero = r.numero;
        out.numero = r.numero;
        integrerCommande(corps);
        sauver();
      } else {
        mettreEnAttente("commande", dv, corps);
      }
    }
    if (name === "transmettre_message") {
      // Seul le message de CET appel d'outil part : Dale Voz complete lui-meme un message du meme appel.
      const corps = { appelId: ctx.callSid || null, telephone: ctx.from || null, prenom: args.prenom || null, motif: args.motif || "", details: args.details || null };
      Promise.resolve(distant.ecrireRappel(dv, corps)).catch(() => null).then((r) => { if (!r) mettreEnAttente("rappel", dv, corps); });
    }
    return out;
  }

  function carteTexte() {
    const parCat = new Map();
    for (const p of produits) { const k = p.categorie || p.type || "Autres"; if (!parCat.has(k)) parCat.set(k, []); parCat.get(k).push(p); }
    // Les alias sont montres au modele : c'est lui qui entend « Selentina » et doit penser Celentano.
    const blocs = [...parCat].map(([cat, liste]) => `## ${cat}\n` + liste.map((p) => `- ${p.nom} : ${p.prix_eur == null ? "prix non communiqué" : String(p.prix_eur).replace(".", ",") + " €"}${p.description ? ". " + p.description : ""}${p.alias?.length ? ` (les clients disent aussi : ${p.alias.join(", ")})` : ""}`).join("\n"));
    if (supplements.length) blocs.push("## Suppléments\n" + supplements.map((s) => `- ${s.nom} : ${s.prix_eur == null ? "prix non communiqué" : String(s.prix_eur).replace(".", ",") + " €"}`).join("\n"));
    return blocs.join("\n\n");
  }

  return {
    tools, run, runAsync, rafraichir, viderAttente, contexteAppel, carteTexte, consigneCloture,
    commandes: () => commandes, messages: () => messages, enAttente: () => enAttente,
  };
}
