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
  } = opts;

  const menu = JSON.parse(fs.readFileSync(menuFile, "utf8"));
  const produits = menu.produits || [];
  const supplements = menu.supplements || [];
  const services = servicesTxt.split(",").map((s) => s.split("-").map(parseHeure)).filter((s) => s[0] != null && s[1] != null);
  const capacite = Math.max(1, capaciteParQuart - reserveParQuart);

  let commandes = [], messages = [];
  try { if (dataFile) ({ commandes = [], messages = [] } = JSON.parse(fs.readFileSync(dataFile, "utf8"))); } catch {}
  const charge = new Map(); // "YYYY-MM-DD|minutes de fin du quart" -> pizzas deja au four
  const cle = (dateKey, fin) => `${dateKey}|${fin}`;
  const appliquer = (cmd, signe) => { for (const [fin, n] of cmd.allocation || []) { const k = cle(cmd.dateKey, fin); charge.set(k, (charge.get(k) || 0) + signe * n); } };
  commandes.forEach((c) => appliquer(c, 1));
  const sauver = () => { if (!dataFile) return; try { fs.writeFileSync(dataFile, JSON.stringify({ commandes, messages })); } catch (e) { console.error("[pizzeria] save KO", e.message); } };

  function jourCible(jour) {
    const aujourdhui = momentLocal(maintenant(), timeZone);
    if (jour === "demain") return { ...momentLocal(new Date(maintenant().getTime() + 86400000), timeZone), minutesNow: -1 };
    return { ...aujourdhui, minutesNow: aujourdhui.minutes };
  }

  // Remonte depuis l'heure de retrait T en remplissant les quarts d'heure libres du meme service.
  function allouer(dateKey, T, n, debutService, minutesNow) {
    let reste = n; const allocation = [];
    for (let fin = T; reste > 0 && fin - 15 >= debutService && (minutesNow < 0 || fin - 15 >= minutesNow); fin -= 15) {
      const libre = capacite - (charge.get(cle(dateKey, fin)) || 0);
      if (libre > 0) { const t = Math.min(libre, reste); allocation.push([fin, t]); reste -= t; }
    }
    return reste === 0 ? allocation : null;
  }

  function chercherCreneau(n, heureSouhaitee, jour) {
    const j = jourCible(jour);
    const plusTot = j.minutesNow < 0 ? 0 : j.minutesNow + delaiMinMinutes;
    const cible = heureSouhaitee != null ? parseHeure(heureSouhaitee) : null;
    const depart = Math.ceil(Math.max(cible ?? 0, plusTot) / 15) * 15;
    for (const [debut, fin] of services) {
      for (let T = Math.max(depart, debut + 15); T <= fin; T += 15) {
        const allocation = allouer(j.dateKey, T, n, debut, j.minutesNow);
        if (allocation) return { j, T, allocation, cible };
      }
    }
    return { j, T: null, cible };
  }

  function chiffrer(articles) {
    const lignes = [], inconnus = [], prixManquants = [];
    let total = 0, nbPizzas = 0;
    for (const a of Array.isArray(articles) ? articles : []) {
      const q = Math.max(1, Math.round(Number(a.quantite) || 1));
      const p = trouver(produits, a.produit);
      if (!p) { inconnus.push({ demande: a.produit, proches: proches(produits, a.produit) }); continue; }
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
    return { lignes, inconnus, prixManquants, total, nbPizzas };
  }

  function proposerHeure({ nb_pizzas, heure_souhaitee, jour }) {
    const n = Math.max(0, Math.round(Number(nb_pizzas) || 0));
    if (n > maxPizzas) return { disponible: false, raison: `commande de groupe (plus de ${maxPizzas} pizzas)`, consigne: "Ne pas enregistrer : prendre le prénom et le détail avec transmettre_message, l'équipe rappelle pour confirmer." };
    const r = chercherCreneau(n, heure_souhaitee, jour);
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

  function enregistrer({ prenom, heure_retrait, jour, articles, remarque }, ctx = {}) {
    if (!String(prenom || "").trim()) return { ok: false, raison: "prénom manquant" };
    const c = chiffrer(articles);
    if (!c.lignes.length) return { ok: false, raison: "aucun article reconnu", inconnus: c.inconnus };
    if (c.inconnus.length) return { ok: false, raison: "des articles ne sont pas sur la carte, les faire préciser avant d'enregistrer", inconnus: c.inconnus };
    if (c.nbPizzas > maxPizzas) return { ok: false, raison: `commande de groupe (plus de ${maxPizzas} pizzas) : passer par transmettre_message` };
    const T = parseHeure(heure_retrait);
    if (T == null) return { ok: false, raison: "heure_retrait illisible, format HH:MM attendu" };

    // Une commande par appel : la reprendre remplace la precedente (le client corrige).
    const precedente = ctx.callSid ? commandes.find((x) => x.callSid === ctx.callSid) : null;
    if (precedente) { appliquer(precedente, -1); commandes = commandes.filter((x) => x !== precedente); }

    const j = jourCible(jour);
    const service = services.find(([d, f]) => T >= d + 15 && T <= f);
    const allocation = service && (j.minutesNow < 0 || T >= j.minutesNow + delaiMinMinutes) ? allouer(j.dateKey, T, c.nbPizzas, service[0], j.minutesNow) : null;
    if (!allocation) {
      if (precedente) { commandes.unshift(precedente); appliquer(precedente, 1); }
      const alt = proposerHeure({ nb_pizzas: c.nbPizzas, heure_souhaitee: heure_retrait, jour });
      return { ok: false, raison: "cette heure de retrait n'est plus tenable", alternative: alt };
    }
    const numero = precedente ? precedente.numero : commandes.filter((x) => x.dateKey === j.dateKey).length + 1;
    const cmd = {
      ts: new Date().toISOString(), numero, callSid: ctx.callSid || null, telephone: ctx.from || null,
      prenom: String(prenom).trim(), dateKey: j.dateKey, jour: j.libelle, heure_retrait: hhmm(T),
      lignes: c.lignes, total_eur: c.total, prix_manquants: c.prixManquants, remarque: remarque || "", allocation,
    };
    appliquer(cmd, 1);
    commandes.unshift(cmd);
    if (commandes.length > 300) commandes.length = 300;
    sauver();
    return { ok: true, numero, prenom: cmd.prenom, jour: j.libelle, heure_retrait: cmd.heure_retrait, heure_orale: heureOrale(T), total_eur: c.total, total_oral: frEuros(c.total), ...(c.prixManquants.length ? { attention: `prix inconnu pour : ${c.prixManquants.join(", ")}, total incomplet` } : {}) };
  }

  function transmettre({ prenom, motif, details }, ctx = {}) {
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

  function run(name, args, ctx) {
    if (name === "chiffrer_commande") {
      const c = chiffrer(args.articles);
      return { lignes: c.lignes, nb_pizzas: c.nbPizzas, total_eur: c.total, total_oral: frEuros(c.total), ...(c.inconnus.length ? { inconnus: c.inconnus, consigne: "Ces articles ne sont pas sur la carte : proposer les plus proches ou faire répéter." } : {}), ...(c.prixManquants.length ? { prix_inconnus: c.prixManquants, consigne_prix: "Ne pas inventer ces prix : dire qu'ils seront confirmés au comptoir." } : {}) };
    }
    if (name === "proposer_heure_retrait") return proposerHeure(args);
    if (name === "enregistrer_commande") return enregistrer(args, ctx);
    if (name === "transmettre_message") return transmettre(args, ctx);
    return { ok: false, raison: `outil inconnu ${name}` };
  }

  function contexteAppel() {
    const m = momentLocal(maintenant(), timeZone);
    const enCours = services.find(([d, f]) => m.minutes >= d && m.minutes < f);
    const prochain = services.find(([d]) => m.minutes < d);
    const etat = enCours ? `service en cours jusqu'à ${hhmm(enCours[1])}` : prochain ? `restaurant fermé, prochain service à ${hhmm(prochain[0])}` : "services du jour terminés, prochain service demain";
    return `Nous sommes ${m.libelle}, il est ${hhmm(m.minutes)} (heure locale du restaurant). État : ${etat}. Salutation : ${m.minutes >= 17 * 60 ? "bonsoir" : "bonjour"}.`;
  }

  function carteTexte() {
    const parCat = new Map();
    for (const p of produits) { const k = p.categorie || p.type || "Autres"; if (!parCat.has(k)) parCat.set(k, []); parCat.get(k).push(p); }
    const blocs = [...parCat].map(([cat, liste]) => `## ${cat}\n` + liste.map((p) => `- ${p.nom} : ${p.prix_eur == null ? "prix non communiqué" : String(p.prix_eur).replace(".", ",") + " €"}${p.description ? ". " + p.description : ""}`).join("\n"));
    if (supplements.length) blocs.push("## Suppléments\n" + supplements.map((s) => `- ${s.nom} : ${s.prix_eur == null ? "prix non communiqué" : String(s.prix_eur).replace(".", ",") + " €"}`).join("\n"));
    return blocs.join("\n\n");
  }

  return { tools, run, contexteAppel, carteTexte, commandes: () => commandes, messages: () => messages };
}
