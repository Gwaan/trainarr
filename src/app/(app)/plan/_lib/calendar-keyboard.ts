/**
 * Déplacement d'une séance **au clavier** : de quelle case on part, sur quelle
 * case une flèche mène. Géométrie pure, testée, sans aucune dépendance à
 * dnd-kit — c'est le composant qui la branche sur ses capteurs.
 *
 * Une seule fonction pour les deux mises en page, parce qu'elle ne raisonne que
 * sur des rectangles :
 *
 * - **grille de sept colonnes** : « droite » trouve la case voisine de la même
 *   ligne, « bas » celle de la semaine suivante, même jour — exactement ce qu'on
 *   attend d'un calendrier ;
 * - **agenda vertical** : les sept jours sont empilés, aucun n'a de voisin
 *   horizontal. « Droite » ne trouve donc rien géométriquement et retombe sur
 *   l'ordre chronologique, qui est ici l'ordre visuel. « Bas » y trouve
 *   directement le jour suivant.
 *
 * Aucune flèche ne laisse donc l'utilisateur bloqué, et aucune ne fait sauter
 * hors du calendrier.
 */

export type NavigableRect = {
  /** Identifiant de la case — `jour:AAAA-MM-JJ`, dont l'ordre lexicographique est chronologique. */
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type NavigationDirection = "up" | "down" | "left" | "right";

/**
 * Tolérance, en pixels, sous laquelle deux centres sont considérés alignés.
 *
 * Un pixel : les cases d'une même colonne partagent leur `left` au sous-pixel
 * près après mise à l'échelle du navigateur, et sans marge elles se
 * compteraient mutuellement comme « à droite ».
 */
const ALIGNMENT_EPSILON = 1;

/**
 * Poids de l'écart **transversal** dans le choix du voisin.
 *
 * Quatre : chercher à droite privilégie franchement la même ligne. Sans ce
 * poids, une case de la ligne suivante mais très proche horizontalement
 * l'emporterait sur la voisine immédiate — la flèche « droite » ferait alors
 * changer de semaine.
 */
const CROSS_AXIS_WEIGHT = 4;

function centerOf(rect: NavigableRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * La case qui contient `point`, sinon celle dont le centre en est le plus
 * proche. `null` s'il n'y a aucune case.
 *
 * Le repli sur la plus proche n'est pas une politesse : pendant un déplacement,
 * le rectangle de collision peut déborder de sa case (une pastille plus haute
 * que la ligne de l'agenda), et refuser de nommer un point de départ figerait
 * les flèches.
 */
export function enclosingNavigableId(
  point: { x: number; y: number },
  rects: readonly NavigableRect[],
): string | null {
  let nearest: NavigableRect | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const rect of rects) {
    if (
      point.x >= rect.left &&
      point.x <= rect.left + rect.width &&
      point.y >= rect.top &&
      point.y <= rect.top + rect.height
    ) {
      return rect.id;
    }

    const center = centerOf(rect);
    const distance = (center.x - point.x) ** 2 + (center.y - point.y) ** 2;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = rect;
    }
  }

  return nearest?.id ?? null;
}

/** Le voisin géométrique dans la direction demandée, `null` s'il n'y en a pas. */
function nearestInDirection(
  current: NavigableRect,
  rects: readonly NavigableRect[],
  direction: NavigationDirection,
): NavigableRect | null {
  const from = centerOf(current);
  let best: NavigableRect | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const rect of rects) {
    if (rect.id === current.id) continue;

    const to = centerOf(rect);
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    let along: number;
    let across: number;
    switch (direction) {
      case "right":
        if (dx <= ALIGNMENT_EPSILON) continue;
        along = dx;
        across = Math.abs(dy);
        break;
      case "left":
        if (dx >= -ALIGNMENT_EPSILON) continue;
        along = -dx;
        across = Math.abs(dy);
        break;
      case "down":
        if (dy <= ALIGNMENT_EPSILON) continue;
        along = dy;
        across = Math.abs(dx);
        break;
      case "up":
        if (dy >= -ALIGNMENT_EPSILON) continue;
        along = -dy;
        across = Math.abs(dx);
        break;
    }

    const score = across * CROSS_AXIS_WEIGHT + along;
    if (score < bestScore) {
      bestScore = score;
      best = rect;
    }
  }

  return best;
}

/**
 * La case où mène une flèche depuis `currentId` — `null` quand il n'y a nulle
 * part où aller (bord de la grille, dernière ou première case).
 */
export function nextNavigableId(
  currentId: string,
  rects: readonly NavigableRect[],
  direction: NavigationDirection,
): string | null {
  const current = rects.find((rect) => rect.id === currentId);
  if (current === undefined) return null;

  const neighbour = nearestInDirection(current, rects, direction);
  if (neighbour !== null) return neighbour.id;

  // Rien dans cette direction : on suit l'ordre chronologique, qui est celui des
  // identifiants. C'est ce qui fait passer d'une ligne à l'autre au bout d'une
  // semaine, et ce qui donne un sens à « gauche » et « droite » dans l'agenda.
  const ordered = [...rects].sort((left, right) => left.id.localeCompare(right.id));
  const index = ordered.findIndex((rect) => rect.id === currentId);
  const step = direction === "right" || direction === "down" ? 1 : -1;
  return ordered[index + step]?.id ?? null;
}
