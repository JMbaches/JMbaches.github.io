#!/usr/bin/env python3
"""megao_enrich_vm.py — a lancer sur la VM Mégao (Windows, acces au lecteur M:).

Lit directement les tables Advantage Database Server de Mégao (CMDCLI.mkd /
CMDCLIB.mkd, format binaire proprietaire — voir la memoire de session
"project_megao_github_action.md" pour le detail complet du reverse engineering
et la justification de chaque offset ci-dessous) et envoie un email
recapitulatif (JSON en piece jointe) a commande.jmbaches@gmail.com. Cet email
est ensuite consomme par scripts/megao-enrich-sync.js cote GitHub Actions, qui
enrichit les dossiers Firestore DEJA CREES par la sync PDF habituelle
(accessoires + notes de suivi chantier).

⚠️ Volontairement AUCUNE cle Firebase sur cette VM (risque identifie : le
personnel Mégao a acces a cette VM). Ce script ne fait qu'envoyer un email —
il ne touche jamais Firestore directement.

⚠️ Decision a prendre par l'utilisateur avant mise en prod : quelles
identifiants SMTP utiliser pour l'envoi (variables d'environnement
MEGAO_SMTP_USER / MEGAO_SMTP_PASSWORD ci-dessous — reutiliser le compte
commande.jmbaches@gmail.com avec un mot de passe d'application dedie a CE
script, distinct de GMAIL_APP_PASSWORD cote GitHub Actions, est recommande
pour pouvoir revoquer l'un sans casser l'autre).

Lancement prevu : Planificateur de taches Windows, toutes les 5 min (comme la
sync PDF). Tenable a cette frequence UNIQUEMENT parce que le script ne
renvoie que ce qui a change depuis le dernier envoi (voir MEGAO_ENRICH_STATE_PATH
ci-dessous) — sans ca, chaque run renverrait la fenetre complete (des
centaines de commandes) toutes les 5 min, ce qui coute inutilement des
lectures Firestore cote megao-enrich-sync.js. Mettre "Ne pas demarrer une
nouvelle instance" dans les parametres de la tache planifiee, pour eviter
que 2 lectures des fichiers Mégao (~640 Mo) se chevauchent si un run met
plus de 5 min (reseau lent sur le lecteur M: par exemple).
"""

import os
import struct
import smtplib
import json
import sys
import hashlib
from datetime import datetime, timedelta
from email.message import EmailMessage

# ─── Configuration ────────────────────────────────────────────────────────────

MEGAO_DB_DIR = os.environ.get('MEGAO_DB_DIR', r'M:\MgwJMB\MGWJMBDB\JMBJMBACHES')
CMDCLI_PATH  = os.path.join(MEGAO_DB_DIR, 'CMDCLI.mkd')
CMDCLIB_PATH = os.path.join(MEGAO_DB_DIR, 'CMDCLIB.mkd')

SMTP_HOST = 'smtp.gmail.com'
SMTP_PORT = 587
SMTP_USER = os.environ.get('MEGAO_SMTP_USER', 'commande.jmbaches@gmail.com')
SMTP_PASSWORD = os.environ.get('MEGAO_SMTP_PASSWORD')  # obligatoire, pas de valeur par defaut
MAIL_TO = os.environ.get('MEGAO_MAIL_TO', 'commande.jmbaches@gmail.com')

WINDOW_DAYS = int(os.environ.get('MEGAO_ENRICH_WINDOW_DAYS', '90'))

# Fichier local (sur la VM) qui retient le dernier contenu envoye par commande,
# pour ne renvoyer que ce qui a change. Ce n'est PAS une donnee sensible (aucun
# secret dedans, juste des hachages) — perte du fichier sans consequence grave,
# le prochain run renverrait juste tout comme si c'etait la premiere fois.
STATE_PATH = os.environ.get(
    'MEGAO_ENRICH_STATE_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'megao_enrich_state.json'),
)

MARKER = b'\x93\xad\xc0\x38'
STRIDE_CMDCLIB = 670

# Prefixes de Codeart -> categorie d'accessoire (stock), confirmes sur les
# vraies donnees le 2026-07-20 (voir memoire de session pour le detail des
# volumes trouves par categorie). A faire valider avec JM avant usage reel du
# decompte stock — en particulier "contre-axe" et "sabots" (mentionnes dans
# une ancienne liste de 8 categories) n'ont pas de prefixe clairement
# identifie et ne figurent pas ci-dessous.
ACCESSORY_PREFIXES = {
    'telecommande':               ['ACVRTELECOM'],
    'flasque_murale':             ['ACVREQUFLASQ'],
    'mur_caillebotis_bois':       ['CAIBO'],
    'mur_caillebotis_pvc':        ['CAIPVC'],
    'mur_immerge':                ['MU1'],
    'passes_sangles':             ['ACVRCOFASSER', 'ACVRBOUCLSANG'],
    'bouchons':                   ['ACVRBOUCH'],
    'equerres_poutres_cornieres': ['ACVREQUPOUTR', 'ACVREQUTELESC', 'ACVREQUROUL', 'ACVRPOUTR', 'ACVRCORN'],
    'boucle_sangle':              ['ACVRBOUCL'],
}


def classify(codeart):
    for label, prefixes in ACCESSORY_PREFIXES.items():
        for p in prefixes:
            if codeart.startswith(p):
                return label
    return None


# ─── Lecture CMDCLI.mkd (en-tete commande, pour la date) ─────────────────────

def extract_cmdcli_dates(path, start_scan=50000):
    data = open(path, 'rb').read()
    dates = {}
    i = start_scan
    while True:
        i = data.find(MARKER, i)
        if i == -1:
            break
        rec = data[i:i + 20]
        if len(rec) < 14:
            i += 4
            continue
        numcmdc = struct.unpack_from('<i', rec, 4)[0]
        day, month = rec[9], rec[10]
        year = struct.unpack_from('<H', rec, 11)[0]
        if 1000 <= numcmdc <= 999999 and 1 <= month <= 12 and 1 <= day <= 31 and 1990 <= year <= 2030:
            try:
                dates[numcmdc] = datetime(year, month, day)
            except ValueError:
                pass
        i += 4
    return dates


# ─── Lecture CMDCLIB.mkd (lignes produits + notes) ───────────────────────────

def extract_cmdclib_lines(path, start_scan=50000):
    data = open(path, 'rb').read()
    lines = []
    i = start_scan
    while True:
        i = data.find(MARKER, i)
        if i == -1:
            break
        rec = data[i:i + STRIDE_CMDCLIB]
        if len(rec) < 400:
            i += 4
            continue
        numcmdc = struct.unpack_from('<i', rec, 8)[0]
        numligne = struct.unpack_from('<i', rec, 12)[0]
        if not (1000 <= numcmdc <= 999999 and 1 <= numligne <= 999):
            i += 4
            continue
        codeart = rec[38:51].split(b'\x00')[0].decode('latin1', 'replace').strip()
        design = rec[68:319].split(b'\x00')[0].decode('latin1', 'replace').strip()
        try:
            qte = struct.unpack_from('<d', rec, 338)[0]
        except struct.error:
            qte = None
        lines.append(dict(numcmdc=numcmdc, numligne=numligne, codeart=codeart, design=design, qte=qte))
        i += 4
    return lines


def dedupe_lines(lines):
    seen = set()
    out = []
    for l in lines:
        key = (l['numcmdc'], l['numligne'], l['codeart'], round(l['qte'], 3) if l['qte'] is not None else None, l['design'])
        if key in seen:
            continue
        seen.add(key)
        out.append(l)
    return out


# ─── Construction du payload ──────────────────────────────────────────────────

def build_payload(window_days):
    dates = extract_cmdcli_dates(CMDCLI_PATH)
    lines = dedupe_lines(extract_cmdclib_lines(CMDCLIB_PATH))

    cutoff = datetime.now() - timedelta(days=window_days)
    recent_orders = {num for num, d in dates.items() if d >= cutoff}

    orders = {}
    for l in lines:
        num = l['numcmdc']
        if num not in recent_orders:
            continue
        cat = classify(l['codeart'])
        is_note = (l['codeart'] == '' and l['design'])
        if not cat and not is_note:
            continue
        entry = orders.setdefault(str(num), {'accessoires': {}, 'notes': []})
        if cat:
            entry['accessoires'].setdefault(cat, []).append({
                'codeart': l['codeart'], 'design': l['design'], 'qte': l['qte'],
            })
        elif is_note:
            entry['notes'].append({'numligne': l['numligne'], 'texte': l['design']})

    return {
        'generatedAt': datetime.now().isoformat(),
        'windowDays': window_days,
        'orders': orders,
    }


# ─── Envoi email ──────────────────────────────────────────────────────────────

def send_payload(payload):
    if not SMTP_PASSWORD:
        print('MEGAO_SMTP_PASSWORD non defini — abandon (voir en-tete du script).', file=sys.stderr)
        sys.exit(1)

    body = json.dumps(payload, ensure_ascii=False, indent=2)

    msg = EmailMessage()
    msg['Subject'] = 'MEGAO-ENRICHISSEMENT'
    msg['From'] = SMTP_USER
    msg['To'] = MAIL_TO
    msg.set_content(f"Enrichissement Mégao genere le {payload['generatedAt']} "
                     f"({len(payload['orders'])} commande(s), fenetre {payload['windowDays']}j). "
                     f"Voir la piece jointe JSON.")
    msg.add_attachment(body.encode('utf-8'), maintype='application', subtype='json',
                        filename='enrichissement.json')

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.starttls()
        server.login(SMTP_USER, SMTP_PASSWORD)
        server.send_message(msg)


def hash_order(order):
    return hashlib.sha256(json.dumps(order, sort_keys=True).encode('utf-8')).hexdigest()


def load_state(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(path, state):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(state, f)


def main():
    payload = build_payload(WINDOW_DAYS)
    orders = payload['orders']
    print(f"{len(orders)} commande(s) dans la fenetre ({WINDOW_DAYS}j)")

    prev_state = load_state(STATE_PATH)
    new_state = {num: hash_order(o) for num, o in orders.items()}
    changed = {num: o for num, o in orders.items() if new_state[num] != prev_state.get(num)}

    if not changed:
        print('Rien de nouveau depuis le dernier envoi — aucun email.')
        return

    print(f"{len(changed)} commande(s) modifiee(s) depuis le dernier envoi — envoi de l'email")
    send_payload({**payload, 'orders': changed})
    save_state(STATE_PATH, new_state)
    print('Email envoyé, état local mis à jour.')


if __name__ == '__main__':
    main()
