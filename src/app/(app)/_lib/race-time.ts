/**
 * Le **chrono de course** : son masque de saisie et ses deux conversions.
 *
 * Partagé par le formulaire de plan (chrono de référence) et par la déclaration
 * d'une course depuis une séance. Il vit dans le `_lib` du groupe `(app)`, et
 * non dans celui d'une route, parce que deux routes le lisent : c'est le seul
 * endroit d'où les deux peuvent l'importer sans se traverser.
 */

/*
 * Masque de saisie : les deux-points s'écrivent seuls.
 *
 * **Le problème, constaté sur iPhone.** Le champ attend `mm:ss` ou `hh:mm:ss`
 * et porte `inputMode="numeric"` — or le pavé numérique d'iOS ne comporte pas
 * de deux-points. L'athlète ne pouvait physiquement pas saisir le séparateur.
 * Repasser au clavier complet réglerait le symptôme en dégradant tout le reste
 * (un pavé alphabétique pour taper quatre chiffres) : c'est donc au champ de se
 * formater, pas au clavier de changer.
 *
 * **Les chiffres se lisent depuis la droite** : les deux derniers sont les
 * secondes, les deux suivants les minutes, le reste les heures. C'est cette
 * lecture-là qui rend la saisie naturelle — on tape `4230` pour 42 min 30 s
 * sans jamais penser au séparateur, et le champ se réorganise de lui-même à
 * chaque chiffre : `4` → `4`, `42` → `42`, `423` → `4:23`, `4230` → `42:30`,
 * `12345` → `1:23:45`, `102345` → `10:23:45`.
 *
 * **Ce module ne valide rien.** `4270` en ressort en `42:70`, que la Server
 * Action refusera : c'est `planFormSchema` (via `parseRaceTimeSeconds`, minutes
 * et secondes sous 60) qui fait autorité sur ce qui part au coach. Le formatage
 * n'est qu'un confort de saisie, et il ne doit jamais corriger sous les doigts
 * une valeur que l'athlète est en train d'écrire.
 *
 * **Le curseur repart en fin de valeur** après chaque reformatage — c'est un
 * choix, pas un oubli. Le champ fait six caractères et la saisie se fait par la
 * fin ; reconstruire savamment une position au milieu d'un masque qui se
 * réorganise à chaque frappe coûterait plus qu'il ne rapporte. Rien à écrire
 * pour l'obtenir : réaffecter la `value` d'un `<input>` déplace le curseur en
 * fin de texte dès lors que la valeur change (comportement du setter HTML), et
 * c'est exactement ce que fait React en réappliquant la valeur contrôlée.
 */

/** Un chrono ne porte pas plus de six chiffres : `hh:mm:ss`. */
const MAX_DIGITS = 6;

/** Les chiffres d'une saisie — deux-points, espaces et tout le reste retirés. */
function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Groupe des chiffres en chrono, depuis la droite.
 *
 * Les zéros de tête sont conservés (`0423` → `04:23`) : les retirer
 * réécrirait sous les doigts une saisie en cours, et le schéma serveur accepte
 * ces deux écritures.
 */
export function formatRaceTimeDigits(digits: string): string {
  if (digits.length <= 2) return digits;

  const seconds = digits.slice(-2);
  const minutes = digits.slice(-4, -2);
  const hours = digits.slice(0, -4);

  return hours === "" ? `${minutes}:${seconds}` : `${hours}:${minutes}:${seconds}`;
}

/**
 * L'endroit où une suppression a mordu, **si elle n'a retiré que des
 * séparateurs** — `null` sinon.
 *
 * C'est le cas qui casse tous les masques naïfs : le curseur est posé juste
 * après un deux-points, la touche retour efface ce deux-points, le formatage le
 * réinsère aussitôt et la suppression paraît sans effet. Le repérer permet de
 * retirer plutôt le chiffre qui le précède, ce que la touche retour voulait
 * dire. L'index rendu est la position du curseur dans la valeur reçue.
 */
function separatorOnlyDeletionAt(previous: string, next: string): number | null {
  if (next.length >= previous.length) return null;
  if (digitsOf(next) !== digitsOf(previous)) return null;

  let index = 0;
  while (index < next.length && next.charAt(index) === previous.charAt(index)) index += 1;

  return index;
}

/**
 * La valeur à afficher après une frappe, une suppression ou un collage.
 *
 * `previous` est la valeur déjà affichée (toujours déjà formatée), `next` celle
 * que le champ vient de produire. Comparer les deux est ce qui distingue une
 * saisie d'une suppression : rien d'autre ne le dit.
 *
 * Au-delà de six chiffres, la frappe ou le collage est **refusé** — `previous`
 * est rendu tel quel — plutôt que tronqué en une valeur que personne n'a voulue.
 */
export function formatRaceTimeInput(previous: string, next: string): string {
  const deletedAt = separatorOnlyDeletionAt(previous, next);
  const digits = digitsOf(next);

  if (deletedAt !== null) {
    // Le rang, parmi les chiffres, de celui qui précède le séparateur effacé.
    const digitIndex = digitsOf(next.slice(0, deletedAt)).length - 1;
    if (digitIndex < 0) return formatRaceTimeDigits(digits);

    return formatRaceTimeDigits(digits.slice(0, digitIndex) + digits.slice(digitIndex + 1));
  }

  if (digits.length > MAX_DIGITS) return previous;

  return formatRaceTimeDigits(digits);
}

/**
 * `mm:ss` ou `hh:mm:ss` — la forme que le masque produit.
 *
 * Les minutes et les secondes restent sous 60 : « 90:00 » pour un semi est une
 * saisie ambiguë (90 minutes ? 90 secondes ?), mieux vaut la refuser tout de
 * suite que d'en deviner une.
 */
const RACE_TIME_SHAPE = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/;

/** Le chrono saisi, en secondes, ou `null` si ce n'en est pas un. */
export function parseRaceTimeSeconds(input: string): number | null {
  const match = RACE_TIME_SHAPE.exec(input.trim());
  if (match === null) return null;

  const [, hours, minutes, seconds] = match;
  const hoursPart = hours === undefined ? 0 : Number(hours) * 3_600;
  return hoursPart + Number(minutes) * 60 + Number(seconds);
}

/** Le chemin inverse : `2_910` → `48:30`, `6_720` → `1:52:00`. */
export function formatRaceTimeSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = String(total % 60).padStart(2, "0");

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
