/**
 * Points d'ancrage du DOM partagés par la page « Plan ».
 *
 * Un id de document est un contrat entre deux fichiers qui ne s'importent pas :
 * la proposition est un composant serveur (elle tirerait tout son sous-arbre
 * dans le bundle si un composant client l'importait), et c'est la modale de
 * création — cliente — qui a besoin de la désigner après une génération réussie.
 * La constante vit donc dans ce module neutre, plutôt qu'en littéral recopié des
 * deux côtés.
 */

/**
 * Conteneur de la proposition du coach.
 *
 * Porté par `PlanProposal` (avec `tabIndex={-1}`, sinon rien ne peut recevoir le
 * focus), visé par `PlanCreateDialog` : à l'adoption du succès, la modale se
 * ferme et son déclencheur disparaît avec le panneau de création. Sans ce
 * déplacement de focus, celui-ci retombe sur `<body>` — un lecteur d'écran
 * n'annoncerait rien du plan qui vient d'apparaître.
 */
export const PLAN_PROPOSAL_ANCHOR_ID = 'plan-proposal';
