/**
 * Ce que l'écran dit tant que le **dénivelé** n'a pas été rattrapé sur tout
 * l'historique — fonctions pures, testées.
 *
 * ## Pourquoi ces phrases ne sont pas facultatives
 *
 * `activities.elevation_gain_m` / `elevation_loss_m` n'existent que depuis leur
 * migration, et la correction d'altitude de la VO₂max (formule de Peter Greif)
 * en dépend entièrement. Tant que `pnpm db:backfill:elevation` n'est pas passé,
 * les séances récentes sont corrigées et l'historique ne l'est pas : le nuage de
 * la page « Progression » mêle **deux grandeurs sur le même axe**, et l'écart à
 * 30 jours compare une fenêtre corrigée à une fenêtre qui ne l'est pas — un
 * artefact d'ingestion affiché comme une progression.
 *
 * C'est la règle du dépôt (`.claude/rules/data-import.md`) : tant qu'un
 * rattrapage n'est pas passé, l'écran doit **dire** que sa lecture est
 * provisoire plutôt que de laisser croire à un historique complet. Le précédent
 * est `describePendingBests` (`progression/_lib/personal-bests-model.ts`), à
 * ceci près qu'ici l'enjeu est plus grand : là-bas une colonne restait vide,
 * ici deux nombres de nature différente se retrouvent sur la même courbe.
 *
 * ## Deux formulations, deux emprises
 *
 * Le panneau a la place d'expliquer **et** de nommer la commande — c'est une
 * opération d'administration que l'application ne déclenche pas elle-même, et
 * l'athlète et l'exploitant sont la même personne ici. La tuile, elle, n'a
 * qu'une ligne sous un chiffre : elle avertit, et laisse le panneau expliquer.
 */

/** Le pluriel français de « séance », accordé sur le compte. */
function sessions(count: number): string {
  return count > 1 ? `${count} séances` : `${count} séance`;
}

/**
 * L'avertissement du **panneau** de VO₂max, `null` quand tout l'historique
 * porte son dénivelé.
 *
 * Il nomme ce que le lecteur voit (un nuage de points), la cause, et le geste —
 * dans cet ordre : « la courbe est fausse » sans « voici comment la réparer »
 * ne serait qu'une inquiétude de plus.
 */
export function describePendingElevation(pendingActivities: number): string | null {
  if (pendingActivities <= 0) return null;

  const many = pendingActivities > 1;
  return (
    `VO₂max provisoire : le dénivelé de ${sessions(pendingActivities)} reste à ` +
    `établir, ${many ? "ces séances ne portent" : "cette séance ne porte"} donc pas ` +
    "la correction d'altitude que portent les plus récentes. Le nuage et l'écart " +
    "à 30 jours mêlent les deux tant que la commande pnpm db:backfill:elevation " +
    "n'a pas été lancée."
  );
}

/**
 * L'avertissement en version **tuile** : une ligne sous un chiffre, `null` quand
 * il n'y a rien à signaler. Ni cause ni commande — la place n'y est pas, et le
 * panneau de « Progression » les porte.
 */
export function shortPendingElevationNote(pendingActivities: number): string | null {
  return pendingActivities <= 0
    ? null
    : `Provisoire : le dénivelé de ${sessions(pendingActivities)} reste à établir.`;
}

/**
 * La note complète d'une **tuile** de VO₂max : la fenêtre d'agrégation, suivie
 * de l'avertissement quand il y a lieu.
 *
 * Une seule chaîne parce que la tuile n'a qu'une ligne de note : accoler
 * l'avertissement à la fenêtre vaut mieux que de faire disparaître la seconde
 * pour laisser place au premier. `window` vide est admis — c'est la tuile du
 * tableau de bord, qui n'annonce pas sa fenêtre.
 */
export function vo2maxTileNote(pendingActivities: number, window: string): string {
  const pending = shortPendingElevationNote(pendingActivities);
  return pending === null ? window : `${window} ${pending}`.trim();
}
