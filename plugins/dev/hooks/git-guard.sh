#!/usr/bin/env bash
# PreToolUse sur Bash : refuse mécaniquement les commandes que le cycle interdit,
# quoi que le modèle ait décidé. Code de sortie 2 = commande bloquée, le message
# sur stderr est renvoyé au modèle.
set -u
CMD=$(python3 -c 'import sys,json;print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null) || exit 0
[ -z "$CMD" ] && exit 0

deny() { echo "[git-guard] Refusé : $1" >&2; exit 2; }

# 1. Poussée en force, sous toutes ses formes.
echo "$CMD" | grep -Eq 'git\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+[A-Za-z0-9_./-]+)' \
  && deny "poussée en force. Le cycle ne réécrit jamais l'historique distant."

# 2. Poussée vers main/master, quelle que soit la branche courante
#    (refspec explicite : HEAD:main, feat:main, main).
echo "$CMD" | grep -Eq 'git\s+push\b.*\s[A-Za-z0-9_./-]*:?(main|master)(\s|$)' \
  && deny "poussée vers la branche principale. Passe par la pull request."

# 3. Depuis main/master, tout commit ou tout push est direct par définition.
if echo "$CMD" | grep -Eq '\bgit\s+(commit|push)\b'; then
  BR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  case "$BR" in main|master)
    deny "tu es sur $BR : ni commit ni push ici. Crée une branche de fonctionnalité." ;;
  esac
fi

# 4. Contournement de la protection de branche côté GitHub.
echo "$CMD" | grep -Eq '\bgh\s+pr\s+merge\b.*--admin\b' \
  && deny "fusion en --admin : contourne la protection de branche."

# 5. Réécriture d'historique sur la branche principale.
echo "$CMD" | grep -Eq '\bgit\s+(reset\s+--hard\s+origin/(main|master)|rebase\b.*\b(main|master)\b.*--onto|branch\s+-D\s+(main|master))' \
  && deny "réécriture de l'historique de la branche principale."

# 6. Ajout de secrets à l'index.
echo "$CMD" | grep -Eq '\bgit\s+add\b.*(\.env\b|\.env\.[a-z]+|id_rsa|\.pem\b|credentials\.json|service-account.*\.json)' \
  && deny "ajout d'un fichier de secrets à l'index. Vérifie .gitignore."
echo "$CMD" | grep -Eq '\bgit\s+add\s+(-A|--all|\.)\s*$' && [ -f .env ] && ! git check-ignore -q .env 2>/dev/null \
  && deny "git add global alors qu'un .env non ignoré est présent."

# 7. Suppression de données de travail hors cycle.
echo "$CMD" | grep -Eq 'rm\s+-rf?\s+(\.git\b|/|~|\$HOME)\s*$' \
  && deny "suppression destructive hors périmètre."

exit 0
