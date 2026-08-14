/**
 * FC max **soutenue** d'une séance.
 *
 * Le maximum brut d'un flux cardiaque n'est pas une FC max : un capteur optique
 * de poignet produit régulièrement un ou deux échantillons aberrants (cadence
 * confondue avec le pouls, contact perdu puis retrouvé), et ces pointes-là
 * dépassent volontiers de 15 à 30 bpm la fréquence réellement atteinte. Prendre
 * ce maximum pour argent comptant, c'est proposer une FC max fausse — et, si
 * elle est acceptée, refaire tout l'historique (TRIMP, zones, VO₂max) sur une
 * valeur inventée.
 *
 * ## La définition retenue
 *
 * La FC max soutenue est **la plus haute valeur `H` telle que la fréquence soit
 * restée ≥ `H` pendant au moins {@link SUSTAINED_HR_WINDOW_S} secondes
 * consécutives**. Autrement dit : le maximum, sur toutes les fenêtres de 5 s de
 * mesures contiguës, du **minimum** de la fenêtre.
 *
 * Cette formulation est celle qui rejette l'artefact sans raboter la vraie
 * pointe, et elle le fait **quelle que soit la cadence d'échantillonnage** :
 * un point isolé ne peut jamais porter le résultat à lui seul, puisque toute
 * fenêtre qui le contient est ramenée à son voisin le plus bas. Une moyenne
 * glissante, elle, aurait dilué le pic sans l'éliminer (une pointe à 220 au
 * milieu d'un plateau à 180, à 1 Hz, ressort encore à 188).
 *
 * ## Pourquoi cinq secondes
 *
 * - **Assez long** pour qu'un artefact ne puisse pas le remplir : les pointes de
 *   capteur optique tiennent sur un à deux échantillons (1–2 s à 1 Hz), jamais
 *   sur cinq secondes pleines.
 * - **Assez court** pour ne pas manquer une vraie pointe : une fin de course ou
 *   la dernière répétition d'une séance de VMA tiennent le plateau haut pendant
 *   dix à trente secondes — cinq secondes se logent largement dedans, et le prix
 *   payé (la fréquence redescend d'un ou deux battements dans la fenêtre) est
 *   d'un ordre de grandeur inférieur à l'erreur qu'on écarte.
 *
 * Le sens de l'erreur restante est **volontairement conservateur** : ce module
 * sous-estime plutôt qu'il ne surestime. Une FC max proposée trop basse est
 * refusée d'un clic ; une FC max proposée trop haute et acceptée fausse des
 * années de charge d'entraînement.
 *
 * ## Les trous
 *
 * L'axe des temps d'un fichier FIT est irrégulier, et parfois **troué**
 * (auto-pause, tunnel, ceinture perdue). Une « fenêtre de 5 s » qui enjamberait
 * une pause de trois minutes ne décrit rien de soutenu. Le plafond de trou est
 * donc celui du reste du projet — {@link sampleDurationCapS}, `3 × pas médian` —
 * calculé sur les **seuls instants où la FC est mesurée**, exactement comme
 * `deriveVelocity` le calcule sur les seuls instants où la distance l'est. Au
 * delà du plafond, la continuité est rompue : les fenêtres ne traversent pas.
 *
 * Module **pur** : ni base, ni fichier, ni réseau.
 */

import { sampleDurationCapS } from './series';

/**
 * Durée minimale (s) pendant laquelle une fréquence doit tenir pour compter.
 *
 * Cf. l'en-tête du module pour la justification. Exportée pour les tests et pour
 * que l'UI puisse dire « soutenue sur 5 s » sans redéclarer la valeur.
 */
export const SUSTAINED_HR_WINDOW_S = 5;

/** Un échantillon exploitable : un instant mesuré, une fréquence mesurée. */
type Sample = { timeS: number; bpm: number };

/**
 * FC max soutenue du flux, `null` si rien n'est établi.
 *
 * `null` — et jamais un maximum de repli — dans tous les cas où la définition ne
 * s'applique pas : pas de canal cardiaque, aucune mesure exploitable, ou aucune
 * plage de mesures contiguës couvrant {@link SUSTAINED_HR_WINDOW_S}. Une séance
 * de trois secondes n'a pas de FC max soutenue, elle a un maximum instantané —
 * ce n'est pas la même grandeur, et les confondre est précisément l'erreur que
 * ce module existe pour éviter.
 *
 * @param heartrate battements par minute, `null` aux index où le capteur n'a
 * rien dit (canal clairsemé : le cas nominal d'un fichier FIT).
 * @param time secondes depuis le départ, aligné index par index sur `heartrate`.
 */
export function sustainedMaxHrBpm(
  heartrate: readonly (number | null)[],
  time: readonly (number | null)[],
): number | null {
  const samples = usableSamples(heartrate, time);
  if (samples.length === 0) return null;

  // Le plafond de trou est relatif à la série : un canal à 1 Hz et une ceinture
  // en mode économie (une mesure toutes les 30 s) n'ont pas la même notion de
  // « trou ». Il se calcule donc sur les instants réellement mesurés.
  const cap = sampleDurationCapS(samples.map((sample) => sample.timeS));

  let best: number | null = null;

  for (let start = 0; start < samples.length; start += 1) {
    // Minimum courant de la fenêtre [start, end]. Il ne peut que descendre :
    // dès qu'il passe sous le meilleur candidat connu, cette fenêtre-ci et
    // toutes ses extensions sont hors course.
    let windowMin = samples[start].bpm;
    let spanned = false;

    for (let end = start + 1; end < samples.length; end += 1) {
      // Trou : la fenêtre ne le traverse pas — le temps d'une auto-pause n'est
      // pas du temps pendant lequel une fréquence s'est tenue.
      if (samples[end].timeS - samples[end - 1].timeS > cap) break;

      if (samples[end].bpm < windowMin) windowMin = samples[end].bpm;
      if (best !== null && windowMin <= best) break;

      if (samples[end].timeS - samples[start].timeS >= SUSTAINED_HR_WINDOW_S) {
        spanned = true;
        break;
      }
    }

    if (spanned && (best === null || windowMin > best)) best = windowMin;
  }

  return best === null ? null : Math.round(best);
}

/**
 * Les points où l'instant **et** la fréquence sont mesurés, dans l'ordre.
 *
 * Une fréquence nulle ou négative n'est pas une mesure basse, c'est l'absence de
 * mesure écrite comme un nombre ; un instant qui recule est une anomalie de
 * fichier — l'échantillon est écarté plutôt que de produire une fenêtre de durée
 * négative.
 */
function usableSamples(
  heartrate: readonly (number | null)[],
  time: readonly (number | null)[],
): Sample[] {
  const samples: Sample[] = [];
  const count = Math.min(heartrate.length, time.length);

  for (let index = 0; index < count; index += 1) {
    const timeS = time[index];
    const bpm = heartrate[index];
    if (timeS === null || !Number.isFinite(timeS)) continue;
    if (bpm === null || !Number.isFinite(bpm) || bpm <= 0) continue;
    if (samples.length > 0 && timeS < samples[samples.length - 1].timeS) continue;

    samples.push({ timeS, bpm });
  }

  return samples;
}
