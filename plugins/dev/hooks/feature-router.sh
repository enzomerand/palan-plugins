#!/usr/bin/env bash
# UserPromptSubmit : injecte une consigne de routage quand la demande ressemble
# à un travail de fonctionnalité. N'écrit rien dans les autres cas, pour ne
# consommer aucun contexte inutilement.
# Désactivation : export DEV_ROUTER=off
set -u
[ "${DEV_ROUTER:-on}" = "off" ] && exit 0

PROMPT=$(python3 -c 'import sys,json;print(json.load(sys.stdin).get("prompt",""))' 2>/dev/null) || exit 0
[ -z "$PROMPT" ] && exit 0

# Hors dépôt Git, le cycle n'a pas de sens.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Échappatoires explicites de l'utilisateur.
# « sans cycle » n'importe où ; les formes interrogatives seulement en tête de
# phrase, sinon « ajoute X et explique pourquoi » échappe au cycle.
echo "$PROMPT" | grep -iEq 'sans (le )?cycle|sans le skill|pas de cycle' && exit 0
echo "$PROMPT" | grep -iEq '^\s*(explique|pourquoi|comment|est-ce que|qu.est-ce|c.est quoi|juste une question|peux-tu m.expliquer)' && exit 0

# Verbes de travail sur fonctionnalité, français et anglais.
echo "$PROMPT" | grep -iEq \
  'ajoute|ajouter|implémente|implementer|implémenter|crée |créer |développe|développer|modifie|modifier|change |changer|corrige|corriger|supprime|supprimer|retire |retirer|refactor|renomme|renommer|add |implement|build |fix |remove |delete |rename' || exit 0

cat <<'MSG'
[routage] Cette demande porte sur une fonctionnalité du dépôt. Applique le skill
`feature` du plugin `dev` : commence par annoncer nature et ampleur (étape 2),
puis suis le cycle. Si le calibrage donne Léger, prends le parcours court. Si la
demande n'est finalement pas un travail de code, ignore ce message.
MSG
exit 0
