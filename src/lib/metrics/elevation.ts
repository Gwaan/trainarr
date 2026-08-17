/**
 * Dénivelé lu dans un **flux d'altitude**, avec filtre anti-bruit.
 *
 * ## Pourquoi ce module existe
 *
 * Deux endroits du système ont besoin de compter des mètres de montée dans la
 * même série : les splits kilométriques (`./splits`, qui attribuent chaque gain
 * au kilomètre où il est constaté) et le **dénivelé total** de la séance, écrit
 * en base à l'ingestion quand le fichier FIT ne porte pas `session.total_ascent`
 * (cas de la montre de l'athlète, qui n'écrit ni ce champ ni son pendant en
 * descente).
 *
 * Deux implémentations du même filtre auraient fini par diverger, et une séance
 * aurait alors annoncé un D+ que la somme de ses splits contredit sans qu'aucune
 * des deux valeurs soit explicable. Le balayage vit donc ici, une fois, et les
 * deux appelants en dérivent ce qu'ils affichent.
 *
 * ## Ce que la factorisation garantit, et ce qu'elle ne garantit pas
 *
 * Elle garantit **la méthode** : un seuil unique, une seule règle d'hystérésis,
 * un seul code. Un écart entre le résumé et les splits ne peut donc plus venir
 * de deux filtres différents.
 *
 * Elle ne garantit **pas l'égalité des deux chiffres**, et il ne faut pas la lui
 * demander : les deux appelants ne balaient pas la même fenêtre. Le total prend
 * la série entière ; les splits vont de la première à la dernière borne de
 * kilomètre (`bounds[0]` → `bounds[splitCount]`), ce qui laisse dehors les
 * points antérieurs au premier fix de distance **et** un reliquat final de moins
 * de 100 m (`MIN_PARTIAL_SPLIT_M`, qui ne fait pas un split). Un sprint final de
 * 88 m en côte compte donc dans le résumé sans apparaître dans aucun split — et
 * comme les fenêtres décident aussi du **premier repère** d'hystérésis, les deux
 * chaînes de références peuvent diverger de quelques dizaines de centimètres au
 * bord. S'ajoute que les splits ne totalisent que les montées, là où le résumé
 * compte les deux sens séparément.
 *
 * L'écart résiduel est donc une différence de **périmètre**, explicable ligne à
 * ligne — pas une divergence de méthode.
 *
 * ## Le filtre
 *
 * L'altimètre barométrique d'une montre oscille de quelques dizaines de
 * centimètres au repos. Sommer naïvement toutes les variations positives d'un
 * 10 km parfaitement plat produit plusieurs dizaines de mètres de D+ fantôme. On
 * ne retient donc une variation que lorsque l'altitude s'écarte d'au moins
 * {@link ELEVATION_NOISE_THRESHOLD_M} du dernier repère retenu — dans un sens
 * comme dans l'autre : le bruit de faible amplitude est filtré, une vraie bosse
 * de 3 m est conservée.
 *
 * **Le repère (hystérésis) court d'un bout à l'autre du balayage**, il ne se
 * réinitialise à aucune borne : une montée à cheval sur deux kilomètres est une
 * seule montée.
 *
 * ## Ce qu'on ne fait pas
 *
 * Aucune extrapolation, aucune symétrie supposée : la **perte** se mesure comme
 * le **gain**, sur les mêmes points. Déduire l'une de l'autre (« c'était une
 * boucle, donc D− = D+ ») serait inventer une donnée — une sortie point à point
 * n'a aucune raison de revenir à son altitude de départ, et une boucle réelle
 * n'y revient qu'à la précision de l'altimètre près.
 */

/**
 * Seuil d'hystérésis du dénivelé, en mètres. **Une seule valeur pour tout le
 * système** — cf. l'en-tête de ce module.
 */
export const ELEVATION_NOISE_THRESHOLD_M = 1;

/** Une variation d'altitude retenue par le filtre. */
export type ElevationMove = {
  /** Index, dans la série d'altitude, de l'échantillon où la variation est constatée. */
  index: number;
  /** Variation retenue, **signée** : positive en montée, négative en descente. */
  deltaM: number;
};

/** Dénivelé cumulé d'un balayage, les deux sens comptés séparément. */
export type ElevationChange = {
  /** Somme des montées retenues, en mètres — jamais négative. */
  gainM: number;
  /** Somme des descentes retenues, en mètres — **positive**, c'est une amplitude. */
  lossM: number;
};

/**
 * Les variations d'altitude retenues par le filtre, dans l'ordre de la série.
 *
 * Les `null` de la série sont sautés sans décaler quoi que ce soit : un canal
 * d'altitude clairsemé est le cas nominal d'un fichier FIT (cf.
 * `.claude/rules/data-import.md`), et les index restent ceux de l'axe commun à
 * tous les canaux — c'est ce qui permet aux splits d'attribuer chaque montée au
 * bon kilomètre.
 *
 * `from` et `until` bornent le balayage (demi-ouvert, comme une tranche). Les
 * splits s'en servent pour ne pas compter l'altitude d'avant le premier fix GPS,
 * qui n'appartient à aucun kilomètre et servirait de surcroît de premier repère
 * d'hystérésis hors trace.
 */
export function elevationMoves(
  altitude: readonly (number | null)[],
  from = 0,
  until = altitude.length,
): ElevationMove[] {
  const moves: ElevationMove[] = [];
  const start = Math.max(0, from);
  const end = Math.min(until, altitude.length);

  // Le dernier point retenu : c'est lui, et non le point précédent, qui sert de
  // référence — sans quoi une dérive de 20 cm par point s'accumulerait sans
  // jamais franchir le seuil, et une pente douce disparaîtrait.
  let reference: number | null = null;

  for (let index = start; index < end; index += 1) {
    const value = altitude[index];
    if (value === null || !Number.isFinite(value)) continue;

    if (reference === null) {
      reference = value;
      continue;
    }

    const deltaM = value - reference;
    if (deltaM >= ELEVATION_NOISE_THRESHOLD_M || -deltaM >= ELEVATION_NOISE_THRESHOLD_M) {
      moves.push({ index, deltaM });
      reference = value;
    }
  }

  return moves;
}

/**
 * Dénivelé positif **et** négatif de toute la série.
 *
 * Rend `null` — jamais `{ gainM: 0, lossM: 0 }` — quand la série porte moins de
 * deux mesures exploitables : sans deux points, il n'y a aucune variation à
 * mesurer, et « zéro » se lirait comme un terrain plat mesuré. La nuance décide
 * de ce qui est écrit en base : `NULL` (l'écran garde son tiret) plutôt qu'un
 * zéro inventé.
 *
 * Un vrai plat, lui, rend bien `{ gainM: 0, lossM: 0 }` : c'est une mesure.
 */
export function elevationChange(altitude: readonly (number | null)[]): ElevationChange | null {
  let measured = 0;
  for (const value of altitude) {
    if (value === null || !Number.isFinite(value)) continue;
    measured += 1;
    if (measured >= 2) break;
  }
  if (measured < 2) return null;

  let gainM = 0;
  let lossM = 0;
  for (const move of elevationMoves(altitude)) {
    if (move.deltaM > 0) gainM += move.deltaM;
    else lossM -= move.deltaM;
  }

  return { gainM, lossM };
}
