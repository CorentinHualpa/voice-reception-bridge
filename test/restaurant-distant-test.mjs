// Banc du pont relie au TABLEAU DU RESTAURANT de Dale Voz (17/09/2026), sans reseau :
// un faux Dale Voz en memoire rend l'etat regle sur la tablette et recoit les ecritures.
// node test/restaurant-distant-test.mjs
import assert from "assert";
import { createPizzeria } from "../lib/pizzeria.js";

const horloge = new Date("2026-09-15T17:00:00Z"); // 19:00 a Paris
const JOUR = "2026-09-15";
const DEMAIN = "2026-09-16";
const DV = { tenantId: "t-1", agentSlug: "pizzeria" };

function fauxDaleVoz(reglages = {}) {
  const f = {
    poste: { fuseau: "Europe/Paris", services: "11:30-14:30,18:30-22:30", capaciteParQuart: 15, reserveParQuart: 0, delaiMinMinutes: 20, maxPizzas: 20, pauseJusqua: null, fermeLe: null, ...(reglages.poste || {}) },
    aujourdhui: { date: JOUR, charge: {}, quartsFermes: [], ruptures: [], allocationsParAppel: {}, ...(reglages.aujourdhui || {}) },
    demain: { date: DEMAIN, charge: {}, quartsFermes: [], ruptures: [], allocationsParAppel: {} },
    commandes: [], rappels: [], cartes: 0, lectures: 0,
    panne: false, numero: 41,
  };
  f.distant = {
    lireEtat: async () => { f.lectures++; return f.panne ? undefined : structuredClone({ poste: f.poste, aujourdhui: f.aujourdhui, demain: f.demain }); },
    ecrireCommande: async (dv, corps) => { if (f.panne) return null; f.commandes.push(corps); return { id: `c${f.commandes.length}`, numero: ++f.numero }; },
    ecrireRappel: async (dv, corps) => { if (f.panne) return null; f.rappels.push(corps); return { id: "r1" }; },
    pousserCarte: async () => { f.cartes++; return { ok: true }; },
  };
  return f;
}
const mk = (f, extra = {}) => createPizzeria({ menuFile: "menus/palazzo.json", maintenant: () => horloge, distant: f.distant, ecritureTimeoutMs: 200, ...extra });

let ok = 0;
const cas = async (nom, fn) => { await fn(); ok++; console.log("ok -", nom); };

await cas("sans tableau (404) le pont reste en local", async () => {
  const f = fauxDaleVoz();
  f.distant.lireEtat = async () => null;
  const p = mk(f);
  const r = await p.runAsync("proposer_heure_retrait", { nb_pizzas: 2 }, { dv: DV });
  assert.equal(r.heure_retrait, "19:30");
});

await cas("le délai et la capacité réglés sur la tablette priment sur la config locale", async () => {
  const f = fauxDaleVoz({ poste: { delaiMinMinutes: 45 } });
  const p = mk(f);
  const r = await p.runAsync("proposer_heure_retrait", { nb_pizzas: 2 }, { dv: DV });
  assert.equal(r.heure_retrait, "19:45");
});

await cas("la carte est poussée une fois au premier appel", async () => {
  const f = fauxDaleVoz();
  const p = mk(f);
  await p.rafraichir(DV);
  await p.rafraichir(DV, { forcer: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.cartes, 1);
});

await cas("une pause refuse la proposition ET l'enregistrement, avec l'heure de reprise", async () => {
  const f = fauxDaleVoz({ poste: { pauseJusqua: "2026-09-15T17:20:00Z" } });
  const p = mk(f);
  const r = await p.runAsync("proposer_heure_retrait", { nb_pizzas: 1 }, { dv: DV });
  assert.equal(r.disponible, false);
  assert.match(r.raison, /pause jusqu'à 19:20/);
  const e = await p.runAsync("enregistrer_commande", { prenom: "Luc", heure_retrait: "20:00", articles: [{ produit: "Roma", quantite: 1 }] }, { dv: DV, callSid: "P" });
  assert.equal(e.ok, false);
  assert.equal(f.commandes.length, 0);
  assert.match(p.contexteAppel(), /IMPORTANT : les commandes par téléphone sont en pause/);
});

await cas("fermé aujourd'hui, mais une commande pour demain passe", async () => {
  const f = fauxDaleVoz({ poste: { fermeLe: JOUR } });
  const p = mk(f);
  assert.equal((await p.runAsync("proposer_heure_retrait", { nb_pizzas: 1 }, { dv: DV })).disponible, false);
  const d = await p.runAsync("proposer_heure_retrait", { nb_pizzas: 1, jour: "demain" }, { dv: DV });
  assert.equal(d.disponible, true);
});

await cas("un ingrédient épuisé retire la pizza du chiffrage et bloque l'enregistrement", async () => {
  const f = fauxDaleVoz({ aujourdhui: { ruptures: [{ cle: "saumon fume", libelle: "Saumon fumé", genre: "ingredient", restant: null }] } });
  const p = mk(f);
  const c = await p.runAsync("chiffrer_commande", { articles: [{ produit: "Salmon Joe", quantite: 1 }, { produit: "Roma", quantite: 1 }] }, { dv: DV });
  assert.deepEqual(c.indisponibles.map((x) => x.produit), ["Salmon Joe"]);
  assert.equal(c.total_eur, 13);
  const e = await p.runAsync("enregistrer_commande", { prenom: "Ana", heure_retrait: "20:00", articles: [{ produit: "Salmon Joe", quantite: 1 }] }, { dv: DV, callSid: "S" });
  assert.equal(e.ok, false);
  assert.match(p.contexteAppel(), /Plus disponible aujourd'hui : Salmon Joe \(plus de saumon fumé\)/);
});

await cas("un stock limité plafonne, se décrémente après l'écriture, puis bloque", async () => {
  const f = fauxDaleVoz({ aujourdhui: { ruptures: [{ cle: "bari", libelle: "Bari", genre: "produit", restant: 2 }] } });
  const p = mk(f);
  const trop = await p.runAsync("chiffrer_commande", { articles: [{ produit: "Bari", quantite: 3 }] }, { dv: DV });
  assert.match(trop.indisponibles[0].raison, /il n'en reste que 2/);
  const e = await p.runAsync("enregistrer_commande", { prenom: "Max", heure_retrait: "20:00", articles: [{ produit: "Bari", quantite: 2 }] }, { dv: DV, callSid: "B1" });
  assert.equal(e.ok, true);
  const apres = p.run("chiffrer_commande", { articles: [{ produit: "Bari", quantite: 1 }] });
  assert.match(apres.indisponibles[0].raison, /épuisé aujourd'hui/);
});

await cas("un quart fermé sur la tablette est sauté et ne reçoit aucune pizza", async () => {
  const f = fauxDaleVoz({ aujourdhui: { quartsFermes: [1170] } }); // 19:30
  const p = mk(f);
  const r = await p.runAsync("proposer_heure_retrait", { nb_pizzas: 2 }, { dv: DV });
  assert.equal(r.heure_retrait, "19:45");
  const e = await p.runAsync("enregistrer_commande", { prenom: "Zoé", heure_retrait: "19:30", articles: [{ produit: "Etna", quantite: 1 }] }, { dv: DV, callSid: "Q" });
  assert.equal(e.ok, false);
});

await cas("la charge du four vient de Dale Voz : un redéploiement n'oublie rien", async () => {
  // 19:15 et 19:30 pleins : une pizza pour 19:30 ne peut plus cuire ni a 19:30 ni juste avant.
  const f = fauxDaleVoz({ aujourdhui: { charge: { 1155: 15, 1170: 15 } } });
  const p = mk(f);
  const r = await p.runAsync("proposer_heure_retrait", { nb_pizzas: 1, heure_souhaitee: "19:30" }, { dv: DV });
  assert.equal(r.heure_retrait, "19:45");
});

await cas("le numéro du jour vient de Dale Voz, et la commande y arrive entière", async () => {
  const f = fauxDaleVoz();
  const p = mk(f);
  const e = await p.runAsync("enregistrer_commande", { prenom: "Julien", heure_retrait: "20:15", articles: [{ produit: "Regina", quantite: 1 }, { produit: "Fiamma", quantite: 1, remarque: "bien cuite" }] }, { dv: DV, callSid: "J", from: "0612345678" });
  assert.equal(e.ok, true);
  assert.equal(e.numero, 42);
  const corps = f.commandes[0];
  assert.equal(corps.appelId, "J");
  assert.equal(corps.dateService, JOUR);
  assert.equal(corps.heureRetrait, "20:15");
  assert.equal(corps.totalEur, 32);
  assert.equal(corps.nbPizzas, 2);
  assert.equal(corps.telephone, "0612345678");
});

await cas("le même appel qui corrige ne se compte pas deux fois au four", async () => {
  // Dale Voz connait deja la premiere version (15 pizzas a 19:45) pour l'appel C.
  const f = fauxDaleVoz({ aujourdhui: { charge: { 1185: 15 }, allocationsParAppel: { C: [[1185, 15]] } } });
  const p = mk(f);
  const e = await p.runAsync("enregistrer_commande", { prenom: "Zoé", heure_retrait: "19:45", articles: [{ produit: "Etna", quantite: 2 }] }, { dv: DV, callSid: "C" });
  assert.equal(e.ok, true);
  assert.equal(e.heure_retrait, "19:45");
});

await cas("Dale Voz en panne : la commande est gardée et part plus tard, sans doublon", async () => {
  // 19:15, 19:30 et 19:45 pleins : ce qui ne tient pas a 20:00 ne peut pas remonter plus tot.
  const f = fauxDaleVoz({ aujourdhui: { charge: { 1155: 15, 1170: 15, 1185: 15 } } });
  const p = mk(f);
  await p.rafraichir(DV);
  f.panne = true;
  const e = await p.runAsync("enregistrer_commande", { prenom: "Inès", heure_retrait: "20:00", articles: [{ produit: "Antica Margherita", quantite: 3 }] }, { dv: DV, callSid: "I" });
  assert.equal(e.ok, true);
  assert.equal(p.enAttente().length, 1);
  // Pendant la panne, ses pizzas comptent quand meme au four.
  const r = p.run("proposer_heure_retrait", { nb_pizzas: 13, heure_souhaitee: "20:00" });
  assert.equal(r.heure_retrait, "20:15");
  f.panne = false;
  await p.viderAttente();
  assert.equal(p.enAttente().length, 0);
  assert.equal(f.commandes.length, 1);
});

await cas("un message à rappeler part dans Dale Voz avec le numéro appelant", async () => {
  const f = fauxDaleVoz();
  const p = mk(f);
  await p.rafraichir(DV);
  const r = await p.runAsync("transmettre_message", { prenom: "Martine", motif: "allergie", details: "fruits à coque" }, { dv: DV, callSid: "M", from: "0671421893" });
  assert.equal(r.ok, true);
  await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(f.rappels[0], { appelId: "M", telephone: "0671421893", prenom: "Martine", motif: "allergie", details: "fruits à coque" });
});

await cas("Dale Voz muet à la relecture : le dernier état connu reste appliqué", async () => {
  const f = fauxDaleVoz({ aujourdhui: { quartsFermes: [1170] } });
  const p = mk(f, { rafraichirApresMs: 0 });
  await p.rafraichir(DV);
  f.panne = true;
  const r = await p.runAsync("proposer_heure_retrait", { nb_pizzas: 2 }, { dv: DV });
  assert.equal(r.heure_retrait, "19:45");
});

console.log(`\n${ok} cas passes`);
process.exit(0);
