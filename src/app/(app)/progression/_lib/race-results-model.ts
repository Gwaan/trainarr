import type { RaceCalibrationDto, Vo2maxCorrectionDto } from "@/data/vo2max-correction";

import {
  formatCivilFullDate,
  formatClock,
  formatCorrectionFactor,
  formatDistance,
  formatNumber,
} from "../../_lib/format";

/**
 * Le tableau des courses déclarées et la phrase qui explique le facteur —
 * fonctions pures, testées.
 *
 * Rien n'est recalculé ici : le DAL rend déjà, pour chaque course, les deux
 * VO₂max comparées, leur rapport et le verdict. Ce module met ces valeurs en
 * français.
 *
 * ## Pourquoi une phrase, et pas seulement un nombre
 *
 * « ×1,11 » affiché seul est inexploitable : on ne sait ni d'où il sort, ni s'il
 * faut le croire, ni comment le faire changer. La phrase dit **quelle course**
 * l'a produit et **les deux valeurs comparées** — c'est ce qui permet à
 * l'athlète de trancher entre « ma FC tourne haut » et « j'ai mal saisi un
 * chrono ».
 */

/**
 * Le formatage du facteur vit dans `(app)/_lib/format` avec les autres : trois
 * écrans l'affichent (la page « Progression », le panneau de réglage, cette
 * table). Réexporté ici, où ce module et son test le cherchent.
 */
export { formatCorrectionFactor };

export type RaceRow = {
  key: number;
  /** Jour de la course en toutes lettres, `null` si la date stockée n'en est pas une. */
  day: string | null;
  /** Nom de l'épreuve, ou la distance à défaut — une ligne sans intitulé ne se lit pas. */
  name: string;
  distance: string;
  time: string;
  /**
   * Ce que la course dit du facteur : son rapport, ou la raison pour laquelle
   * elle n'en produit pas.
   */
  calibration: string;
  /** C'est **elle** qui porte le facteur retenu. */
  calibrating: boolean;
  /** La séance qui l'a enregistrée, `null` si elle a été courue sans montre. */
  href: string | null;
};

/** Ce qu'une course apporte au facteur, en une cellule. */
function calibrationOf(race: RaceCalibrationDto): string {
  switch (race.status) {
    case "eligible":
      // Le rapport, et rien d'autre : les deux VO₂max comparées sont dans le
      // pied du panneau pour la course qui calibre, et les répéter sur chaque
      // ligne ferait un tableau de six colonnes sur un téléphone.
      return race.factor === null ? "—" : formatCorrectionFactor(race.factor);
    case "no-heart-rate":
      return "sans FC";
    case "out-of-bounds":
      return race.factor === null
        ? "écartée"
        : `${formatCorrectionFactor(race.factor)} — écartée`;
    case "not-computable":
      return "non exploitable";
  }
}

/**
 * Les lignes du tableau, dans l'ordre du DAL — de la course la plus récente à la
 * plus ancienne.
 *
 * `today` ne sert qu'au millésime : une course peut dater de deux ans, et
 * « dimanche 17 mai » ne désignerait alors aucun jour en particulier.
 */
export function buildRaceRows(
  correction: Vo2maxCorrectionDto,
  today: string,
): RaceRow[] {
  return correction.races.map((race) => ({
    key: race.id,
    day: formatCivilFullDate(race.racedOn, today),
    name: race.name ?? formatDistance(race.distanceM),
    distance: formatDistance(race.distanceM),
    time: formatClock(race.timeS),
    calibration: calibrationOf(race),
    calibrating: correction.calibratedOnRaceId === race.id,
    href: race.activityId === null ? null : `/activities/${race.activityId}`,
  }));
}

/** Un titre court et son explication : ce que le pied de panneau affiche. */
export type CorrectionCopy = { title: string; description: string };

const UNAVAILABLE_COPY: Record<
  NonNullable<Vo2maxCorrectionDto["unavailable"]>,
  CorrectionCopy
> = {
  "no-race": {
    title: "VO₂max non recalée",
    description:
      "Aucune course déclarée : l’estimation repose entièrement sur ta fréquence cardiaque, et elle peut s’écarter de la réalité dans un sens comme dans l’autre. Ouvre une séance de course et déclare-la — Trainarr en tirera l’écart entre ton chrono et ce que ta FC laissait lire.",
  },
  "no-race-with-heart-rate": {
    title: "VO₂max non recalée",
    description:
      "Tes courses déclarées ne portent aucune fréquence cardiaque : sans elle, il n’y a rien à comparer au chrono, et rien ne s’invente. Lie une course à une séance enregistrée avec une ceinture ou un capteur au poignet pour caler l’estimation.",
  },
  "no-usable-race": {
    title: "VO₂max non recalée",
    description:
      "Aucune de tes courses déclarées ne produit un écart crédible : effort trop court pour le modèle, chrono hors domaine, ou rapport si éloigné de 1 qu’il trahit une mesure fausse plutôt qu’une physiologie. Le détail est dans la colonne de droite du tableau.",
  },
};

/**
 * La phrase qui explique le facteur en vigueur.
 *
 * Les deux VO₂max de la course qui calibre y figurent en toutes lettres : c'est
 * la seule façon de comprendre pourquoi le facteur vaut ce qu'il vaut, et de
 * voir tout de suite qu'un chrono a été mal saisi.
 */
export function describeCorrection(correction: Vo2maxCorrectionDto): CorrectionCopy {
  if (correction.source === "manual") {
    const automatic =
      correction.calibratedOnRaceId === null
        ? "Tes courses n’en produisent aucun de leur côté."
        : `Tes courses en donneraient ${formatCorrectionFactor(correction.automaticFactor)}.`;

    return {
      title: `VO₂max recalée ${formatCorrectionFactor(correction.factor)} — facteur imposé`,
      description: `Ce facteur vient de tes réglages, pas de tes courses : il remplace le calcul automatique. ${automatic} Vide le champ dans « Réglages › Profil » pour revenir au calcul.`,
    };
  }

  const calibrating = correction.races.find(
    (race) => race.id === correction.calibratedOnRaceId,
  );
  if (calibrating === undefined || correction.unavailable !== null) {
    return UNAVAILABLE_COPY[correction.unavailable ?? "no-race"];
  }

  const label = calibrating.name ?? formatDistance(calibrating.distanceM);
  const comparison =
    calibrating.timeVo2max === null || calibrating.hrVo2max === null
      ? ""
      : ` : ${formatNumber(calibrating.timeVo2max, 1)} par le chrono contre ${formatNumber(
          calibrating.hrVo2max,
          1,
        )} par la fréquence cardiaque.`;

  return {
    title: `VO₂max recalée ${formatCorrectionFactor(correction.factor)}`,
    description: `Calibrée sur ta meilleure course déclarée, ${label}${comparison} Toutes tes VO₂max estimées sont multipliées par ce facteur — c’est la méthode de Runalyze, et c’est ce qui explique l’essentiel de l’écart entre les deux applications.`,
  };
}
