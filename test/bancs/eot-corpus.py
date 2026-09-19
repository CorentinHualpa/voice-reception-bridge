# Récupère le corpus français de fin de tour de LiveKit et l'étale en WAV + manifeste.
#
# Pourquoi ce corpus et pas le nôtre : le jeu d'épreuve fabriqué par `fabriquer-pauses.mjs` est de la
# SYNTHÈSE, et une synthèse à qui on donne un fragment le prononce avec une intonation descendante, donc
# comme une phrase finie. Le modèle répond « terminé » à « Mon numéro c'est zéro six » et il a
# acoustiquement raison. Aucun chiffre tiré de ces fixtures ne dit quoi que ce soit sur un modèle qui
# écoute la PROSODIE. Il faut de vraies personnes qui hésitent pour de vrai.
#
# `livekit/eot-bench-data` (CC-BY-4.0, ouvert, non restreint) est le premier corpus public de ce genre :
# de vrais tours de parole humains face à un agent, dans 14 langues. La part française tient 400 tours,
# 71 minutes, et chaque tour porte TOUS ses silences d'au moins 100 ms. Le dernier silence est la vraie
# fin du tour (étiquette `eot`), tous les précédents sont des hésitations en cours de phrase (`hold`) :
# 400 fins et 654 hésitations, c'est exactement la matière qui manquait.
#
# Usage : python test/bancs/eot-corpus.py [dossier de destination]
# Le corpus fait ~140 Mo, il n'est PAS versionné (voir .gitignore).

import io
import json
import os
import sys
import urllib.request
import wave

URL = "https://huggingface.co/datasets/livekit/eot-bench-data/resolve/main/data/fr/validation-00000-of-00001.parquet"
ICI = os.path.dirname(os.path.abspath(__file__))
DEST = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ICI, "fixtures", "eot-livekit")


def telecharger(vers):
    if os.path.exists(vers) and os.path.getsize(vers) > 1_000_000:
        print("parquet déjà là :", vers)
        return
    print("téléchargement du corpus français…")
    urllib.request.urlretrieve(URL, vers)
    print("  %.1f Mo" % (os.path.getsize(vers) / 1e6))


def etaler(parquet, dossier):
    import pyarrow.parquet as pq

    lignes = pq.read_table(parquet).to_pylist()
    audios = os.path.join(dossier, "audio")
    os.makedirs(audios, exist_ok=True)
    tours = []
    for r in lignes:
        octets = r["audio"]["bytes"]
        nom = r["id"] + ".wav"
        with open(os.path.join(audios, nom), "wb") as f:
            f.write(octets)
        w = wave.open(io.BytesIO(octets))
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, r["id"]
        spans = r["silence_spans"]
        tours.append({
            "id": r["id"],
            "fichier": "audio/" + nom,
            "duree": round(r["duration"], 3),
            # Le dernier silence est la fin du tour, les autres sont des hésitations.
            "spans": [
                {
                    "debut": round(s["start"], 3),
                    "fin": round(s["end"], 3),
                    "etiquette": "eot" if i == len(spans) - 1 else "hold",
                }
                for i, s in enumerate(spans)
            ],
            "texte": " ".join(m["word"].strip() for m in (r["words"] or [])),
        })
    manifeste = {
        "source": "livekit/eot-bench-data (CC-BY-4.0)",
        "langue": "fr",
        "tours": len(tours),
        "eot": sum(1 for t in tours for s in t["spans"] if s["etiquette"] == "eot"),
        "hold": sum(1 for t in tours for s in t["spans"] if s["etiquette"] == "hold"),
        "liste": tours,
    }
    with open(os.path.join(dossier, "manifeste.json"), "w", encoding="utf-8") as f:
        json.dump(manifeste, f, ensure_ascii=False, indent=1)
    print("%d tours, %d fins de tour, %d hésitations -> %s" % (
        manifeste["tours"], manifeste["eot"], manifeste["hold"], dossier))


if __name__ == "__main__":
    os.makedirs(DEST, exist_ok=True)
    parquet = os.path.join(DEST, "validation-fr.parquet")
    telecharger(parquet)
    etaler(parquet, DEST)
