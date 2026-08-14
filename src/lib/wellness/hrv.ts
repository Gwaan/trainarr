/**
 * La **variante** de variabilité cardiaque qu'une montre publie — et comment
 * l'étiqueter partout pareil.
 *
 * ## Pourquoi ce module existe
 *
 * « HRV » n'est pas une grandeur, c'est une famille. Les deux qui circulent :
 *
 * - **rMSSD** — racine carrée de la moyenne des carrés des différences entre
 *   intervalles RR *successifs*. C'est la référence du domaine en récupération :
 *   elle reflète surtout l'activité parasympathique.
 * - **SDNN** — écart-type des intervalles RR sur la fenêtre. Elle mesure la
 *   variabilité *totale*, périodes lentes comprises, et vaut couramment le
 *   double d'un rMSSD pris la même nuit.
 *
 * Elles se ressemblent (des millisecondes, une nuit, un cœur) et **ne se
 * comparent pas**. Ranger un SDNN dans la colonne du rMSSD serait un mensonge de
 * données : c'est exactement ce que `CLAUDE.md` interdit. Chacune a donc sa
 * colonne, et tout écran qui affiche une HRV dit **laquelle**.
 *
 * ## Les deux règles, écrites une fois pour toute l'application
 *
 * 1. **Sur une journée qui porte les deux, rMSSD gagne** ({@link readHrv}) —
 *    c'est la référence du domaine, et une montre qui pousse les deux n'a aucune
 *    raison de faire préférer la seconde.
 * 2. **Une tendance ne mélange jamais les deux** : une série trace la variante
 *    **majoritaire** de sa fenêtre ({@link majorityHrvVariant}) et l'annonce
 *    dans son libellé. Une courbe qui sauterait de 45 ms (SDNN) à 90 ms (rMSSD)
 *    au changement de montre montrerait une « chute » qui n'a pas eu lieu.
 *
 * Module pur : aucune dépendance, ni serveur ni client. Il traverse la frontière
 * client avec les vues.
 */

/** La grandeur effectivement mesurée par la montre. */
export type HrvVariant = 'rmssd' | 'sdnn';

/** Les deux colonnes d'une journée de relevé, telles qu'elles sont stockées. */
export type HrvSample = {
  /** rMSSD, en millisecondes. */
  hrvRmssdMs: number | null;
  /** SDNN, en millisecondes. */
  hrvSdnnMs: number | null;
};

/** Une HRV lue, et **ce qu'elle est** — l'un ne va jamais sans l'autre. */
export type HrvMeasure = {
  value: number;
  variant: HrvVariant;
};

const VARIANT_NAMES: Record<HrvVariant, string> = { rmssd: 'rMSSD', sdnn: 'SDNN' };

/** Le nom de la grandeur, tel qu'il s'écrit dans le domaine : `rMSSD`, `SDNN`. */
export function hrvVariantName(variant: HrvVariant): string {
  return VARIANT_NAMES[variant];
}

/**
 * Le libellé d'affichage : « HRV (rMSSD) », « HRV (SDNN) ».
 *
 * `null` — aucune mesure — donne « HRV » tout court : annoncer une variante
 * qu'on n'a pas mesurée dirait quelque chose de faux sur une case vide.
 */
export function hrvLabel(variant: HrvVariant | null): string {
  return variant === null ? 'HRV' : `HRV (${VARIANT_NAMES[variant]})`;
}

/** La HRV d'une journée, `null` si la nuit n'en porte aucune. rMSSD prime. */
export function readHrv(sample: HrvSample): HrvMeasure | null {
  if (sample.hrvRmssdMs !== null) return { value: sample.hrvRmssdMs, variant: 'rmssd' };
  if (sample.hrvSdnnMs !== null) return { value: sample.hrvSdnnMs, variant: 'sdnn' };
  return null;
}

/**
 * La variante que la fenêtre trace : celle du plus grand nombre de nuits
 * mesurées. `null` quand aucune nuit n'en porte.
 *
 * À égalité — et c'est le cas d'un changement de montre en milieu de période —
 * rMSSD l'emporte, pour la même raison que dans {@link readHrv}. Les nuits de
 * l'autre variante ne sont pas converties : elles sortent de la série, qui reste
 * une suite de mesures homogènes.
 */
export function majorityHrvVariant(samples: readonly HrvSample[]): HrvVariant | null {
  let rmssd = 0;
  let sdnn = 0;

  for (const sample of samples) {
    const measure = readHrv(sample);
    if (measure === null) continue;
    if (measure.variant === 'rmssd') rmssd += 1;
    else sdnn += 1;
  }

  if (rmssd === 0 && sdnn === 0) return null;
  return sdnn > rmssd ? 'sdnn' : 'rmssd';
}
