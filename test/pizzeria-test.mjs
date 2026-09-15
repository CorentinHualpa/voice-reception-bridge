// Banc du profil pizzeria : totaux, rapprochement des noms, capacite du four. Sans reseau.
// node test/pizzeria-test.mjs
import assert from "assert";
import { createPizzeria, frEuros, heureOrale } from "../lib/pizzeria.js";

let horloge = new Date("2026-09-15T17:00:00Z"); // 19:00 a Paris
const mk = () => createPizzeria({ menuFile: "menus/palazzo.json", maintenant: () => horloge });
let ok = 0;
const cas = (nom, fn) => { fn(); ok++; console.log("ok -", nom); };

cas("montants dits en toutes lettres", () => {
  assert.equal(frEuros(57.5), "cinquante-sept euros cinquante");
  assert.equal(frEuros(11), "onze euros");
  assert.equal(heureOrale(19 * 60 + 45), "dix-neuf heures quarante-cinq");
});

cas("total exact avec supplement, alias et dessert", () => {
  const p = mk();
  const r = p.run("chiffrer_commande", { articles: [
    { produit: "Regina", quantite: 2 },
    { produit: "quatre fromages", quantite: 1, supplements: ["burrata"] },
    { produit: "tiramisu", quantite: 1 },
    { produit: "Cola", quantite: 1 },
  ] });
  assert.equal(r.total_eur, 57.5);
  assert.equal(r.nb_pizzas, 3);
  assert.equal(r.lignes[1].produit, "4 Formaggi");
  assert.ok(!r.inconnus);
});

cas("un nom ambigu est refuse au lieu d'etre devine", () => {
  const r = mk().run("chiffrer_commande", { articles: [{ produit: "Fiorella", quantite: 1, supplements: ["jambon"] }] });
  assert.ok(r.inconnus && r.inconnus[0].demande.includes("jambon"));
  assert.equal(r.total_eur, 11);
});

cas("un produit hors carte est signale avec des propositions", () => {
  const r = mk().run("chiffrer_commande", { articles: [{ produit: "Calzone", quantite: 1 }] });
  assert.equal(r.inconnus.length, 1);
  assert.equal(r.inconnus[0].proches.length, 3);
});

cas("premiere heure : delai minimal arrondi au quart d'heure", () => {
  const r = mk().run("proposer_heure_retrait", { nb_pizzas: 3 });
  assert.equal(r.heure_retrait, "19:30"); // 19:00 + 20 min = 19:20 -> 19:30
});

cas("four plein : la commande remonte sur les quarts precedents, puis decale", () => {
  const p = mk();
  const big = p.run("enregistrer_commande", { prenom: "Luc", heure_retrait: "19:30", articles: [{ produit: "Roma", quantite: 15 }] }, { callSid: "A" });
  assert.equal(big.ok, true);
  // 19:15-19:30 plein, 19:00-19:15 encore libre (il est 19:00 pile) : 5 pizzas de plus tiennent a 19:30
  const r1 = p.run("proposer_heure_retrait", { nb_pizzas: 5, heure_souhaitee: "19:30" });
  assert.equal(r1.heure_retrait, "19:30");
  const r2 = p.run("enregistrer_commande", { prenom: "Ana", heure_retrait: "19:30", articles: [{ produit: "Capri", quantite: 15 }] }, { callSid: "B" });
  assert.equal(r2.ok, true);
  const r3 = p.run("proposer_heure_retrait", { nb_pizzas: 4, heure_souhaitee: "19:30" });
  assert.equal(r3.heure_retrait, "19:45");
  assert.ok(r3.note);
});

cas("une nouvelle commande du meme appel remplace la precedente", () => {
  const p = mk();
  p.run("enregistrer_commande", { prenom: "Zoé", heure_retrait: "19:45", articles: [{ produit: "Etna", quantite: 15 }] }, { callSid: "C" });
  const r = p.run("enregistrer_commande", { prenom: "Zoé", heure_retrait: "19:45", articles: [{ produit: "Etna", quantite: 2 }] }, { callSid: "C" });
  assert.equal(r.ok, true);
  assert.equal(p.commandes().length, 1);
  assert.equal(p.run("proposer_heure_retrait", { nb_pizzas: 13, heure_souhaitee: "19:45" }).heure_retrait, "19:45");
});

cas("commande de groupe renvoyee a l'equipe", () => {
  const r = mk().run("proposer_heure_retrait", { nb_pizzas: 25 });
  assert.equal(r.disponible, false);
  assert.match(r.raison, /groupe/);
});

cas("fin de service : proposition pour le lendemain", () => {
  horloge = new Date("2026-09-15T20:20:00Z"); // 22:20
  const r = mk().run("proposer_heure_retrait", { nb_pizzas: 2 });
  assert.equal(r.disponible, false);
  assert.equal(r.premier_creneau_demain.heure_retrait, "11:45");
  horloge = new Date("2026-09-15T17:00:00Z");
});

cas("heure refusee si trop proche ou hors service", () => {
  const p = mk();
  assert.equal(p.run("enregistrer_commande", { prenom: "Max", heure_retrait: "19:05", articles: [{ produit: "Bari", quantite: 1 }] }, {}).ok, false);
  assert.equal(p.run("enregistrer_commande", { prenom: "Max", heure_retrait: "16:00", articles: [{ produit: "Bari", quantite: 1 }] }, {}).ok, false);
  assert.equal(p.run("enregistrer_commande", { prenom: "Max", heure_retrait: "12:00", jour: "demain", articles: [{ produit: "Bari", quantite: 1 }] }, {}).ok, true);
});

cas("un rechiffrage qui perd des articles est signale", () => {
  const p = mk();
  p.run("chiffrer_commande", { articles: [{ produit: "Pacino", quantite: 1 }, { produit: "Celentano", quantite: 1 }] }, { callSid: "G" });
  const r = p.run("chiffrer_commande", { articles: [{ produit: "Bellucci", quantite: 1 }] }, { callSid: "G" });
  assert.match(r.attention, /Pacino, Celentano/);
  const r2 = p.run("chiffrer_commande", { articles: [{ produit: "Pacino", quantite: 1 }, { produit: "Celentano", quantite: 1 }, { produit: "Bellucci", quantite: 1 }] }, { callSid: "G" });
  assert.equal(r2.attention, undefined);
});

cas("un prenom de remplissage est refuse", () => {
  const r = mk().run("enregistrer_commande", { prenom: "Client", heure_retrait: "20:00", articles: [{ produit: "Roma", quantite: 2 }] }, { callSid: "D" });
  assert.equal(r.ok, false);
  assert.match(r.raison, /prénom/);
});

cas("un message transmis deux fois dans le meme appel reste unique et se complete", () => {
  const p = mk();
  p.run("transmettre_message", { motif: "demande de réservation", details: "4 personnes samedi 20h" }, { callSid: "E" });
  const r = p.run("transmettre_message", { prenom: "Élodie", motif: "demande de réservation" }, { callSid: "E" });
  assert.equal(r.deja_transmis, true);
  assert.equal(p.messages().length, 1);
  assert.equal(p.messages()[0].prenom, "Élodie");
});

cas("la carte montree au modele porte les prononciations des clients", () => {
  assert.match(mk().carteTexte(), /Celentano.*selentina/);
});

cas("garde de cloture : seulement si rien n'est enregistre", () => {
  const p = mk();
  assert.ok(p.consigneCloture("Merci pour votre commande, à tout à l'heure !", { callSid: "F", outils: [] }));
  assert.equal(p.consigneCloture("C'est noté, une Regina.", { callSid: "F", outils: [] }), null);
  assert.equal(p.consigneCloture("Merci pour votre commande", { callSid: "F", outils: ["enregistrer_commande"] }), null);
  p.run("enregistrer_commande", { prenom: "Léo", heure_retrait: "20:00", articles: [{ produit: "Roma", quantite: 1 }] }, { callSid: "F" });
  assert.equal(p.consigneCloture("Merci pour votre commande", { callSid: "F", outils: [] }), null);
});

cas("contexte d'appel : heure locale et salutation", () => {
  const t = mk().contexteAppel();
  assert.match(t, /19:00/);
  assert.match(t, /bonsoir/);
});

console.log(`\n${ok} cas passes`);
