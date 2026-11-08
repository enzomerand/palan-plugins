---
name: feature
description: Cycle de développement d'une fonctionnalité, de la spécification à la pull request, optimisé pour consommer peu de contexte. À utiliser dès qu'il s'agit d'ajouter, de modifier ou de retirer une fonctionnalité dans un dépôt de code, que la demande soit formulée par la commande ou en langage naturel.
---

Demande : $ARGUMENTS

Si ce champ est vide, la demande est celle que je viens de formuler.

## Règle de sobriété, prioritaire sur tout le reste

Tout ce qui entre dans cette conversation y reste et m'est refacturé à chaque
tour. Ta contrainte permanente est donc le volume de contexte, pas le nombre
d'étapes.

Trois conséquences, qui l'emportent sur toute autre consigne de ce document.

Ne fais jamais entrer un contenu volumineux dans le fil principal. Toute lecture
de plus de deux fichiers passe par un sous-agent, qui te rendra ses constats et
non les fichiers. Filtre les sorties de commandes avant qu'elles n'arrivent :
`--stat`, `--quiet`, `| tail`, `grep` sur les échecs. Jamais un `cat` de fichier
entier, jamais une sortie de tests complète quand elle est verte — la ligne de
résumé suffit, et en cas d'échec seuls les blocs en échec.

Ne relis jamais deux fois le même fichier. S'il est déjà dans la conversation, il
y est encore.

Sois bref. Pas de récapitulatif de ce que tu viens de faire, pas d'annonce de ce
que tu vas faire, pas de reformulation de ma demande. Tes propres réponses sont
du contexte payé à chaque tour, et elles sont facturées environ cinq fois le prix
d'un token lu.

## Langues

En anglais ce que la machine consomme : code, identifiants, commentaires,
messages de commit. En français ce que je lis : questions, annonces, constats de
revue, description de pull request, résumé. Ne traduis ni ne réémets jamais mes
messages.

## 1. Contexte du projet

Si `CLAUDE.md` est absent ou vide, fais-le construire par l'agent `explore`, qui
lira la configuration, les dépendances, les scripts et l'arborescence et te
rendra une synthèse. Écris ensuite le fichier : Commandes, Architecture,
Conventions, Pièges. N'y mets que du vérifié, marque « à confirmer » ce qui est
déduit, laisse une section vide plutôt que de l'inventer, et garde l'ensemble
sous 150 lignes — ce fichier est chargé à chaque message de chaque session
future, sa taille est un impôt permanent.

Vérifie aussi que `.gitignore` contient `.claude/work/`, ajoute la ligne sinon,
et crée le dossier `.claude/work/` s'il n'existe pas. Si `.claude/work/journal.csv`
n'existe pas, crée-le avec cette seule ligne d'en-tête :
`date,slug,nature,ampleur,passes_revue,bloquants,deep,simplif,tests_reecrits,abandon`

Relève enfin, en une ligne pour moi, lesquelles de ces portes existent réellement
dans ce dépôt : formateur, linter, vérificateur de types, suite de tests,
intégration continue, `gh` authentifié. Si aucune porte automatique n'existe,
dis-le-moi franchement : la revue par modèle devient alors le seul filet, ce qui
est la configuration la plus coûteuse et la moins fiable. Ne les installe pas de
ta propre initiative, signale-le une fois et continue.

## 2. Calibrage

Deux axes, annoncés ensemble en une seule ligne : la nature du changement et son
ampleur.

Nature : création, modification ou suppression. En cas de doute, c'est une
modification — le coût d'une mauvaise classification est asymétrique, traiter une
modification comme une création fait casser du code existant en silence.

Ampleur : Léger, Standard ou Structurant. Applique ensuite le parcours
correspondant.

Léger, moins d'environ 150 lignes et aucune décision irréversible : étapes 3, 5,
6 et 7. Tu sautes la spécification de l'étape 4, mais jamais l'étape 4b si la
nature est modification ou suppression — c'est justement sur un petit changement
d'existant que la régression silencieuse passe le plus facilement.

Standard : tout le document, sauf ce qui est marqué Structurant.

Structurant, quel que soit le nombre de lignes : schéma de données, contrat
d'API, authentification ou permissions, nouvelle dépendance, argent ou données
personnelles, tout ce qu'un commit ultérieur ne peut pas défaire proprement.

## 3. État initial et ouverture de la pull request

Regarde d'abord s'il existe déjà une branche ou une pull request ouverte pour ce
slug. Si oui, ne recrée rien : applique la section Reprise en fin de document.

Sinon : arbre propre, `main` à jour, puis une branche dédiée à cette seule
fonctionnalité — jamais de réutilisation d'une branche existante, jamais deux
fonctionnalités sur la même branche. Nomme-la d'après le slug de la demande.

Lance la suite de tests et ne rapporte que la ligne de résultat. Si elle est déjà
rouge, arrête-toi et dis-le-moi : ne corrige pas ces échecs et ne les déclare pas
hors sujet, sans référence verte au départ la revue finale ne prouve plus rien.

Pousse ensuite la branche et ouvre immédiatement une pull request en brouillon,
avec `gh pr create --draft`, une par fonctionnalité. Elle est ouverte maintenant
et non à la fin, pour que l'intégration continue tourne sur chaque commit au lieu
de tout découvrir après coup. Si `gh` est absent, contente-toi de la branche et
signale-le-moi en une ligne.

## 4. Spécification

Dix lignes maximum, en français, directement dans la conversation — pas de
fichier, sauf si Structurant, auquel cas `.claude/work/<slug>.spec.md`, qui n'est
jamais commité.

Contenu : le problème, trois à six critères d'acceptation testables, ce qui est
explicitement hors périmètre, et le geste manuel par lequel je constaterai que ça
marche.

Pas d'agent relecteur sur ce document. Si quelque chose est réellement ambigu,
pose-moi toutes tes questions en une seule fois, numérotées, en français. Ne me
demande rien que tu peux trancher toi-même. N'attends pas mon accord ensuite :
continue sauf si je t'arrête.

Si Structurant, ajoute avant de coder : deux options envisagées, celle que tu
retiens et le critère qui tranche, le chemin de retour arrière. Quatre lignes.

## 4b. Si c'est une modification ou une suppression

À faire avant l'étape 5, jamais après. Envoie l'agent `explore` cartographier
l'existant et rends-moi sa synthèse en six lignes au plus : où vit le
comportement actuel, qui l'appelle, quels tests l'encodent, quelles données déjà
enregistrées en dépendent, quels réglages ou drapeaux le pilotent, ce qui casse
si le comportement change.

Trois règles en découlent, et elles priment sur la vitesse.

Un test existant qui échoue après ton changement est une alerte, pas une corvée.
Deux cas seulement : soit il encode le comportement que je te demande justement de
changer, et tu le réécris ; soit il a détecté une régression, et c'est ton code
qui est faux. Tu ne modifies jamais un test pour le faire passer sans avoir
tranché entre les deux, et tu me listes en français chaque test existant que tu
as réécrit, avec sa justification en une ligne. C'est la première cause de
régression silencieuse.

Les appelants existants continuent de fonctionner, sauf si la spécification dit
explicitement le contraire. Si le changement rompt un contrat, dis-le-moi avant
de coder, pas dans le résumé final.

Les données déjà enregistrées survivent au changement. Si une migration est
nécessaire, le changement devient Structurant quelle que soit sa taille : dis-le
moi, reviens à l'étape 4 pour produire les quatre lignes d'options et de chemin
de retour, puis reprends ici. Ne poursuis pas en Standard sous prétexte que
l'étape 4 est déjà passée.

Pour une suppression, ajoute une porte à l'étape 6, avant la boucle de revue :
un `grep` sur chaque symbole retiré doit ne plus rien renvoyer, y compris dans la
configuration, les scripts, les migrations et la documentation. Tant qu'une
référence subsiste, la suppression n'est pas terminée.

## 5. Implémentation

Si l'étape 4b a eu lieu, sa cartographie te suffit : ne relance pas `explore`,
tu paierais deux fois la même lecture. Sinon, fais-lui établir la liste des
fichiers à modifier et des points d'accroche. Dans les deux cas, tu ne lis
toi-même que ces fichiers-là.

Découpe en tâches livrables seules, un commit par tâche. Pour chacune, écris
d'abord les tests qui encodent les critères d'acceptation concernés, lance-les
et constate qu'ils échouent, puis seulement implémente jusqu'à ce qu'ils passent.
Un test écrit après le code valide le code, pas l'intention ; un test rouge
d'abord est le seul regard extérieur sur ton travail que ce cycle possède. Si un
critère d'acceptation n'a pas de test au moment de fusionner, il n'est pas
couvert, quoi qu'en disent les revues.

Tout ce que tu découvres en chemin et qui sort du périmètre de la spécification —
un défaut voisin, une dette qui saute aux yeux, une amélioration évidente — va
dans la description de la pull request sous « À suivre », jamais dans le code de
cette fonctionnalité. L'élargissement en cours de route est le principal
destructeur de budget.

Au-delà de quatre tâches, ou si le travail t'oblige à lire largement, délègue la
tâche entière à un sous-agent plutôt que de charger le fil principal.

## 6. Vérification

Les portes gratuites d'abord, dans cet ordre, et rien ne continue tant qu'une
porte est rouge : formatage, linter, vérificateur de types, suite de tests.

Ajoute une porte de non-régression : avec `git diff --name-only`, liste les
fichiers de tests déjà existants qui apparaissent modifiés, et dis-moi en une
ligne pourquoi chacun a dû changer. Un test existant réécrit pour passer est la
première cause de régression silencieuse, et le seul défaut du cycle qui ne
produit aucun signal visible.

Pour toutes ces portes, ne rapporte que les lignes de résultat, et en cas
d'échec uniquement les blocs fautifs. Ce que ces outils attrapent ne doit jamais
être payé à un modèle.

Puis la boucle de revue, sur `git diff` uniquement, jamais sur les fichiers
entiers.

Première passe par l'agent `reviewer-fast`. Corrige tout ce qu'il classe
BLOQUANT, relance les portes gratuites, puis relance `reviewer-fast` sur le seul
diff de tes corrections. Deux cycles au maximum. S'il reste du bloquant, arrête
et liste-le-moi en français.

Seconde passe par l'agent `reviewer-deep` dans trois cas : le changement est
Structurant ; la première passe a remonté au moins un BLOQUANT ; ou le diff
touche une surface où une erreur ne se voit pas — routes et contrôleurs,
authentification ou permissions, requêtes et migrations, paiement, traitement
d'entrées externes. Les faux négatifs de `reviewer-fast` se concentrent là, et
c'est pour eux que la seconde passe existe. Hors de ces trois cas, elle n'a pas
lieu.

Puis la passe de simplification, qui n'est jamais facultative et ne se déclare
jamais faite sans preuve. Appelle l'agent `simplifier` sur le diff. S'il rend des
propositions, applique-les et regroupe-les dans un commit distinct préfixé
`refactor:`. S'il rend `RAS`, écris-le-moi explicitement en une ligne.

Dans les deux cas tu produis une trace : soit un commit `refactor:`, soit la
mention `simplification : RAS`. Sans l'une ou l'autre, cette étape n'a pas eu
lieu, quoi que tu en penses. Relance ensuite les portes gratuites, car une
simplification casse aussi souvent qu'elle allège.

Tests navigateur en dernier, si l'interface a été touchée.

## 7. Livraison

Complète la description de la pull request ouverte à l'étape 3 : critères
d'acceptation, geste de vérification manuelle, points restés ouverts, et si
Structurant la ligne de retour arrière. Sors-la de l'état brouillon.

Puis intègre et pousse, à condition que les sept points suivants soient vrais.
Vérifie-les, ne les suppose pas.

Les portes gratuites sont vertes, réellement exécutées à l'instant, code de
retour vérifié. La boucle de revue est close sans aucun constat BLOQUANT
subsistant. `main` a été réintégré dans la branche et la suite de tests relancée
après coup, car une branche verte peut casser une fois fusionnée. Il ne reste
aucun conflit. La passe de simplification a laissé sa trace, commit `refactor:`
ou mention `RAS` — vérifie-la, ne la suppose pas ; si elle manque, retourne à
l'étape 6 avant d'aller plus loin. L'arbre de travail est propre. Et si le dépôt
a une intégration continue, ses vérifications sont passées au vert sur la pull request — attends-les
avec `gh pr checks --watch` plutôt que de fusionner à l'aveugle.

Si l'un de ces points est faux, ne fusionne pas : laisse la pull request ouverte,
dis-moi lequel bloque, et arrête-toi là.

Si tous sont vrais, fusionne en un seul commit annulable puis pousse :
`gh pr merge --squash --delete-branch`, ou à défaut une fusion sans avance rapide
sur `main` suivie d'un push. L'objectif est qu'un unique `git revert` suffise à
retirer toute la fonctionnalité.

Ne pousse jamais en force. Ne fusionne jamais une branche autre que celle de
cette fonctionnalité. Ne modifie jamais l'historique de `main`.

Puis le compte rendu final, en français.

Si l'outil `mcp__feature-checklist__report` figure parmi tes outils, chargé ou
différé (charge-le alors avec ToolSearch), appelle-le au lieu d'écrire le
tableau : il affiche le bilan dans le panneau latéral « Bilan feature »
(plugin `feature-checklist`), avec des boutons pour traiter chaque élément
écarté et chaque risque, répondre à chaque décision et fusionner. Ses champs
suivent les règles du tableau ci-dessous : constats vérifiés, une phrase par
note, tableau vide pour « néant ». Puis fais exactement ce que dit sa réponse :
en général rien d'autre dans la conversation que la ligne éventuelle sur
`CLAUDE.md` décrite plus bas, et le tableau seulement si elle le demande.

Sinon, écris-le exactement sous cette forme. Sept lignes, jamais une de moins :
si une entrée est sans objet, écris « néant » plutôt que de supprimer la ligne.
Une ligne absente doit se voir.

| | Élément | État |
|---|---|---|
| 🔍 | Revue de code | ☑ close, aucun bloquant — ou ☐ et ce qui reste |
| 🧹 | Simplification | ☑ faite — ou ☐ et pourquoi |
| 🌐 | Tests navigateur | ☑ passés — ou ☐ et pourquoi, ou sans objet |
| ⛔ | Écarté | ce qui était demandé et n'a pas été fait, et pourquoi |
| ❓ | À décider | ce qui attend un arbitrage de ma part |
| ⚠️ | Risque | ce qui peut mal tourner, ou néant |
| 🔀 | Fusionnée | ☑ sur `main` — ou ☐ et ce qui bloque |

Une phrase par cellule, pas de prose autour du tableau, pas de récapitulatif de
ce que tu viens de faire.

Les trois premières lignes et la dernière sont des constats, pas des déclarations
d'intention : tu les vérifies avant de les écrire, jamais de mémoire. Pour la
simplification, la case ☑ suppose la trace exigée à l'étape 6 — commit
`refactor:` ou mention RAS ; elle n'est pas reportée ici, mais elle doit exister.
Une case ☐ signifie que le cycle n'est pas terminé — dis alors explicitement ce qui manque, et ne fusionne
pas. « Sans objet » n'est admis que pour les tests navigateur, quand l'interface
n'a pas été touchée.

Si la session a révélé un piège absent de `CLAUDE.md`, ajoute sous le tableau (ou
seule dans la conversation, si le bilan est dans le panneau) une seule ligne proposant ce qu'il faudrait y inscrire, sans l'écrire toi-même.

Enfin, ajoute une ligne à `.claude/work/journal.csv`, sans rien m'en dire :
la date, le slug, la nature (creation/modification/suppression), l'ampleur
(leger/standard/structurant), le nombre de passes de `reviewer-fast`, le nombre
total de constats BLOQUANT trouvés, si `reviewer-deep` a tourné (0/1), si la
simplification a produit un commit ou RAS (commit/ras), le nombre de tests
existants réécrits, et si le cycle s'est terminé par un abandon (0/1). Une ligne
en cas d'abandon aussi. Ce journal est ce qui permet de régler le cycle sur des
faits plutôt qu'à l'impression.

## Abandon propre

Le cycle peut se terminer sans livraison, et c'est parfois la bonne décision.
Arrête-toi et propose l'abandon dans trois cas : la spécification s'est révélée
fausse deux fois, le travail dépasse largement ce qu'annonçait le calibrage, ou
tu as découvert une solution nettement meilleure hors du périmètre convenu.

Dans ce cas, ne fusionne rien. Dis-moi en quatre lignes ce que tu as appris, ce
qui coince et ce que tu ferais autrement. Attends ma réponse. Si je confirme,
ferme la pull request, supprime la branche locale et distante, et ne laisse rien
derrière toi. Un abandon au tiers du chemin coûte infiniment moins cher qu'une
fonctionnalité livrée à contresens.

## Reprise

Si tu reprends un travail interrompu, ne recommence rien : la branche et la pull
request existent déjà. Lis l'historique des commits de la branche et la
description de la pull request pour retrouver où en était le cycle, dis-moi en
une ligne à quelle étape tu reprends, et continue.

## Règles permanentes

Aucun secret, aucune clé, aucun `.env` dans un commit.

Identifiants, noms de fichiers et noms de tests en anglais, quelle que soit la
langue de la spécification.

Si une étape démontre que la spécification était fausse, reviens à l'étape 4 et
préviens-moi.

Si tu bloques deux fois sur la même erreur, arrête-toi et demande.
