# Provenance et licences des ambiances

Tous les enregistrements du catalogue sont dans le **domaine public** : CC0 1.0 Universal,
ou versement volontaire par l'auteur (`PD-author` sur Wikimedia Commons, qui a le même effet
juridique : pas d'attribution, pas de reversement). Ils sont donc redistribuables à
l'intérieur d'un produit commercial. Aucun fichier sous licence non commerciale, sous
Public Domain Mark (qui n'est pas une licence mais une simple affirmation par un tiers,
invérifiable sur un enregistrement récent) ou exigeant une attribution n'a été retenu,
précisément parce que le pont est vendu à des clients.

| Ambiance | Fichier | Source | Licence | Page de licence |
|---|---|---|---|---|
| Centre d'appels | `centre-appels.wav` | archive.org, collection *office-sound-effects*, `121116-bank-interior-ambience-office-doors-footstaps-printer-typing-voices-17642.mp3` | CC0 1.0 | https://archive.org/details/office-sound-effects |
| Bureau | `bureau.wav` | archive.org, collection *office-sound-effects*, `mixkit-office-ambience-447.wav` | CC0 1.0 | https://archive.org/details/office-sound-effects |
| Salle de restaurant | `salle.wav` | archive.org, collection *Designers-Choice-Collection-Ambiences*, `AMBRest-...Restaurant Or Bar Walla...mp3` | CC0 1.0 | https://archive.org/details/Designers-Choice-Collection-Ambiences |
| Rue | `rue.wav` | Wikimedia Commons, `Sagetyrtle_-_citystreet3_(cc0)_(freesound).mp3` | CC0 1.0 | https://commons.wikimedia.org/wiki/File:Sagetyrtle_-_citystreet3_(cc0)_(freesound).mp3 |
| Restaurant animé | `restaurant.wav` | Wikimedia Commons, `Restaurant_ambience.ogg` (pdsounds.org n° 274, « restaurant_walla », enregistré par stephan en 2007) | Domaine public par l'auteur (`PD-author`) | https://commons.wikimedia.org/wiki/File:Restaurant_ambience.ogg |

Le préréglage **bruit de confort** n'a pas de fichier : il est synthétisé à la volée. Ce n'est
pas un décor mais du bruit de confort au sens du codec (RFC 3389), dont le rôle est justement de
n'évoquer aucun lieu.

## Refabriquer un fichier

```
node scripts/chercher-extrait.mjs <source> --duree 90
node scripts/preparer-ambiance.mjs <id> <source> --debut <secondes> --duree 90
```

Le premier script cherche la fenêtre la plus vivante de l'enregistrement, le second produit le
WAV 8 kHz bouclé. Les deux mesurent le **relief**, l'écart en dB entre les tranches de 200 ms
calmes et fortes. En dessous de 6 dB, le fond s'entend comme un défaut de ligne et non comme un
lieu : c'est ce qui a fait rejeter la première version, entièrement synthétisée.

## Écartés, et pourquoi

- **Pixabay** : licence compatible, mais aucune URL de fichier accessible sans exécuter le
  JavaScript de leur lecteur.
- **Freesound** : les meilleures pistes de bureau sont en CC BY-NC, incompatible avec un produit vendu.
- **`Cafe_ambiance.ogg`** (Wikimedia, CC0, 20 min) : parfaitement libre, mais mesuré à 3,5 dB de
  relief sur la totalité de ses vingt minutes. C'est une nappe de foule dense, sans événement isolé.
- **`78_cafe-restaurant-background`** (archive.org) : aucune licence explicite, et le statut d'un
  enregistrement antérieur à 1972 aux États-Unis est incertain.
- **`Bundesautobahn_A6.flac`** (Wikimedia) : CC BY 3.0, donc attribution obligatoire. Écarté pour
  ne pas imposer une mention à chaque client.
