// Accueil du telephone : « bonjour/bonsoir » ecrit dans le texte (porte Telephone de DaleVoz) devient le bon mot
// selon l'heure du restaurant, bonsoir des 17 h (meme regle que la consigne de lib/pizzeria.js). Grok le faisait
// souvent de lui-meme malgre le « mot pour mot », mais pas a coup sur : c'est le pont qui tranche.
export function saluerSelonHeure(texte, date = new Date(), timeZone = process.env.TIME_ZONE || "Europe/Paris") {
  // formatToParts : en fr-FR, format() rend « 17 h », que Number() lit NaN (et tout devenait « bonjour »).
  const parts = new Intl.DateTimeFormat("fr-FR", { timeZone, hour: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const heure = Number(parts.find((p) => p.type === "hour")?.value);
  const mot = heure >= 17 ? "bonsoir" : "bonjour";
  // ⚠ DaleVoz remplace DEJA bonjour/bonsoir selon l'heure sur la porte Telephone (salutationSelonHeure) : un
  // « bonjour/bonsoir » y devient « bonsoir/bonsoir », que Chiara a dit tel quel le 30/09 (« elle begaye »).
  // Toute paire separee par une barre, doublon compris, se ramene donc a un seul mot.
  return String(texte || "").replace(/bon(?:jour|soir)\s*\/\s*bon(?:jour|soir)/gi, (m) =>
    m[0] === m[0].toUpperCase() ? mot[0].toUpperCase() + mot.slice(1) : mot);
}
