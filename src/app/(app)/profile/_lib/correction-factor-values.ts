import type { Vo2maxCorrectionDto } from '@/data/vo2max-correction';

import { formatCivilFullDate, formatCorrectionFactor, formatDistance } from '../../_lib/format';

/**
 * Ce que le bloc « Facteur correctif de la VO₂max » affiche — fonctions pures,
 * testées.
 *
 * Le panneau règle **une seule chose** : le facteur manuel, qui prend le pas sur
 * le calcul. Tout le reste y est en lecture — mais indispensable : imposer une
 * valeur sans voir celle qu'on remplace, ni sur quoi elle est calibrée, revient
 * à écrire à l'aveugle.
 *
 * L'historique des courses, lui, n'est pas ici mais sur la page « Progression » :
 * ce sont des performances, pas un réglage.
 */

export type CorrectionFactorSettings = {
  /**
   * Le facteur imposé, prêt pour le champ. **Chaîne vide = automatique**, ce
   * qui est exactement ce que le champ vide veut dire à la soumission.
   */
  manual: string;
  /** Le facteur automatique, écrit — `×1` quand aucune course ne calibre. */
  automatic: string;
  /** Sur quoi il est calibré, ou pourquoi il ne l'est pas. Une phrase. */
  automaticNote: string;
};

const UNAVAILABLE_NOTE: Record<
  NonNullable<Vo2maxCorrectionDto['unavailable']>,
  string
> = {
  'no-race':
    'Aucune course déclarée : le calcul automatique ne recale rien. Déclare une course depuis le détail d’une séance pour qu’il ait de quoi travailler.',
  'no-race-with-heart-rate':
    'Tes courses déclarées ne portent aucune fréquence cardiaque : il n’y a rien à comparer à leur chrono, et rien ne s’invente.',
  'no-usable-race':
    'Aucune de tes courses déclarées ne produit un écart crédible. Le détail figure sur la page « Progression », dans « Courses déclarées ».',
};

/**
 * Les valeurs du panneau.
 *
 * `today` ne sert qu'au millésime de la course qui calibre : elle peut dater de
 * deux ans, et « dimanche 17 mai » ne désignerait alors aucun jour.
 */
export function toCorrectionFactorSettings(
  correction: Vo2maxCorrectionDto,
  today: string,
): CorrectionFactorSettings {
  const calibrating = correction.races.find(
    (race) => race.id === correction.calibratedOnRaceId,
  );

  const automaticNote =
    calibrating === undefined
      ? UNAVAILABLE_NOTE[correction.unavailable ?? 'no-race']
      : `Calibré sur ${calibrating.name ?? formatDistance(calibrating.distanceM)}${
          formatCivilFullDate(calibrating.racedOn, today) === null
            ? ''
            : `, ${formatCivilFullDate(calibrating.racedOn, today)}`
        } — ta meilleure course déclarée au sens de ce calcul.`;

  return {
    // Le champ porte la valeur **telle qu'elle est en base**, pas le facteur
    // appliqué : les deux diffèrent dès que le manuel est vide, et pré-remplir
    // le champ avec le facteur automatique le figerait au premier
    // enregistrement — l'athlète perdrait le mode automatique sans l'avoir
    // demandé.
    manual:
      correction.manualFactor === null
        ? ''
        : String(correction.manualFactor).replace('.', ','),
    automatic: formatCorrectionFactor(correction.automaticFactor),
    automaticNote,
  };
}
