# Palan · plugins Claude Code

Les skills et mods [Claude Code](https://code.claude.com) de Palan, réunis dans
une marketplace.

| Plugin | En bref |
|---|---|
| [`dev`](plugins/dev) | Cycle de développement d'une fonctionnalité, de la demande à la fusion : spécification courte, tests d'abord, revue en cascade, pull request. |
| [`feature-checklist`](plugins/feature-checklist) | Panneau « Bilan feature » qui remplace le tableau de fin du cycle `dev`, avec un bouton pour traiter chaque point. Installe `dev` avec lui. |
| [`notch-status`](plugins/notch-status) | Tes sessions Claude Code dans l'encoche du Mac, un aiguilleur pour qu'elles ne se marchent pas dessus, et l'usage de la semaine au pied de la saisie. |

## Installer un plugin

Dans Claude Code, en terminal :

```
/plugin install <plugin> --marketplace enzomerand/palan-plugins
```

Réponds `y` pour ajouter la marketplace, puis choisis la portée. Chaque plugin
décrit ses prérequis et son usage dans son dossier.

## Licence

MIT
