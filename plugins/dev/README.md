# dev : le cycle feature

Un skill qui mène chaque fonctionnalité de la demande à la fusion, dans un cycle
court, vérifiable et économe en contexte.

## Pourquoi

Sans cadre, un agent code tout de suite, se relit peu et finit par un résumé
qu'il faut éplucher. Le skill `feature` impose un cycle :

- **Une spécification avant le code** : trois à six critères d'acceptation
  testables, ce qui est hors périmètre, et un calibrage (léger, standard,
  structurant) qui dose le reste du cycle.
- **Les tests d'abord**, un commit par tâche, sur une branche avec sa pull
  request brouillon.
- **Peu de contexte consommé** : tout ce qui entre dans la conversation est
  renvoyé à chaque tour. La lecture du code passe par des sous-agents qui ne
  rendent que leurs constats, et les sorties de commandes sont filtrées.
- **Une revue en cascade** : un relecteur rapide (Haiku) sur chaque diff, un
  second (Sonnet) seulement pour un changement structurant ou un bloquant trouvé.
- **Une fusion sûre** : sept conditions vérifiées, puis un seul commit squash,
  qu'un `git revert` suffit à retirer. Un hook refuse push en force, commit
  direct sur `main` et ajout de secrets, quoi que décide le modèle.
- **Un bilan franc** : ce qui a été écarté, ce qui reste à décider, les risques.

## Contenu

| Élément | Rôle |
|---|---|
| skill `feature` | Le cycle, de la demande à la fusion. |
| `explore` (Haiku) | Lit le code et ne rend que ses constats. |
| `reviewer-fast` (Haiku) | Première revue de chaque diff : défauts mécaniques. |
| `reviewer-deep` (Sonnet) | Seconde revue : conception et risques. |
| `simplifier` (Sonnet) | Propose ce qui peut être retiré avant la fusion. |
| hook `feature-router.sh` | Oriente vers le cycle toute demande de fonctionnalité faite dans un dépôt Git. |
| hook `git-guard.sh` | Refuse push en force, commit direct sur `main`, réécriture d'historique et ajout de secrets. |

## Installation

```
/plugin install dev --marketplace enzomerand/palan-plugins
```

Prérequis : `git`, `gh` connecté à GitHub, `python3` (utilisé par les hooks).

Pour un bilan dans un panneau plutôt qu'un tableau, installe plutôt
[`feature-checklist`](../feature-checklist), qui installe `dev` avec lui.

## Utilisation

Demande une fonctionnalité en langage naturel, ou tape `/dev:feature <demande>`.
Le cycle est pensé pour une session Sonnet. Pour coder sans lui, écris « sans
cycle » dans la demande ou exporte `DEV_ROUTER=off`.

## Bon à savoir

- Chaque cycle ajoute une ligne à `.claude/work/journal.csv` dans le dépôt
  (ignoré par Git), pour mesurer ce que trouvent la revue et la simplification.
- Un agent du même nom dans `.claude/agents/` ou `~/.claude/agents/` masque
  celui du plugin.
- Aucune intégration continue n'est requise. Si le dépôt en a, le skill attend
  ses vérifications avant de fusionner.
