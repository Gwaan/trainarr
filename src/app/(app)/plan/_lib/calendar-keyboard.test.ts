import { describe, expect, it } from 'vitest';

import {
  enclosingNavigableId,
  nextNavigableId,
  type NavigableRect,
} from './calendar-keyboard';

/**
 * Deux dispositions à couvrir, celles que le calendrier produit réellement :
 *
 * - la **grille** : sept colonnes de 120 px, des lignes de 110 px ;
 * - l'**agenda** : sept lignes empilées de 360 px de large et 48 px de haut.
 */
function grid(weeks: number, from = '2026-08-03'): NavigableRect[] {
  const rects: NavigableRect[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);

  for (let week = 0; week < weeks; week += 1) {
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(start + (week * 7 + day) * 86_400_000).toISOString().slice(0, 10);
      rects.push({
        id: `jour:${date}`,
        left: day * 120,
        top: week * 110,
        width: 120,
        height: 110,
      });
    }
  }

  return rects;
}

function agenda(days: number, from = '2026-08-03'): NavigableRect[] {
  const start = Date.parse(`${from}T00:00:00Z`);

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    return { id: `jour:${date}`, left: 0, top: index * 48, width: 360, height: 48 };
  });
}

describe('enclosingNavigableId', () => {
  it('nomme la case qui contient le point', () => {
    const rects = grid(2);
    expect(enclosingNavigableId({ x: 130, y: 20 }, rects)).toBe('jour:2026-08-04');
    expect(enclosingNavigableId({ x: 10, y: 150 }, rects)).toBe('jour:2026-08-10');
  });

  it('retombe sur la plus proche quand le point déborde', () => {
    // Une pastille plus haute que sa ligne peut sortir de la grille : refuser de
    // nommer un point de départ figerait les flèches.
    expect(enclosingNavigableId({ x: -400, y: -400 }, grid(2))).toBe('jour:2026-08-03');
    expect(enclosingNavigableId({ x: 5_000, y: 5_000 }, grid(2))).toBe('jour:2026-08-16');
  });

  it('rend `null` sans aucune case', () => {
    expect(enclosingNavigableId({ x: 0, y: 0 }, [])).toBeNull();
  });
});

describe('nextNavigableId — grille de sept colonnes', () => {
  const rects = grid(3);

  it('« droite » et « gauche » suivent la ligne', () => {
    expect(nextNavigableId('jour:2026-08-04', rects, 'right')).toBe('jour:2026-08-05');
    expect(nextNavigableId('jour:2026-08-04', rects, 'left')).toBe('jour:2026-08-03');
  });

  it('« bas » et « haut » changent de semaine sans changer de jour', () => {
    expect(nextNavigableId('jour:2026-08-05', rects, 'down')).toBe('jour:2026-08-12');
    expect(nextNavigableId('jour:2026-08-12', rects, 'up')).toBe('jour:2026-08-05');
  });

  it('« droite » depuis le dimanche passe au lundi suivant', () => {
    // Aucun voisin géométrique à droite : l'ordre chronologique prend le relais.
    expect(nextNavigableId('jour:2026-08-09', rects, 'right')).toBe('jour:2026-08-10');
  });

  it('« gauche » depuis le lundi remonte au dimanche précédent', () => {
    expect(nextNavigableId('jour:2026-08-10', rects, 'left')).toBe('jour:2026-08-09');
  });

  it('ne sort pas de la grille', () => {
    expect(nextNavigableId('jour:2026-08-03', rects, 'up')).toBeNull();
    expect(nextNavigableId('jour:2026-08-03', rects, 'left')).toBeNull();
    expect(nextNavigableId('jour:2026-08-23', rects, 'down')).toBeNull();
    expect(nextNavigableId('jour:2026-08-23', rects, 'right')).toBeNull();
  });
});

describe('nextNavigableId — agenda vertical', () => {
  const rects = agenda(14);

  it('« bas » et « haut » passent d’un jour à l’autre', () => {
    expect(nextNavigableId('jour:2026-08-05', rects, 'down')).toBe('jour:2026-08-06');
    expect(nextNavigableId('jour:2026-08-05', rects, 'up')).toBe('jour:2026-08-04');
  });

  it('« droite » et « gauche » gardent un sens malgré l’absence de colonnes', () => {
    expect(nextNavigableId('jour:2026-08-05', rects, 'right')).toBe('jour:2026-08-06');
    expect(nextNavigableId('jour:2026-08-05', rects, 'left')).toBe('jour:2026-08-04');
  });

  it('s’arrête aux extrémités', () => {
    expect(nextNavigableId('jour:2026-08-03', rects, 'up')).toBeNull();
    expect(nextNavigableId('jour:2026-08-16', rects, 'down')).toBeNull();
  });
});

describe('nextNavigableId — cas dégénérés', () => {
  it('rend `null` pour une case inconnue', () => {
    expect(nextNavigableId('jour:2030-01-01', grid(1), 'down')).toBeNull();
  });

  it('rend `null` quand la case est seule', () => {
    expect(nextNavigableId('jour:2026-08-03', grid(1).slice(0, 1), 'right')).toBeNull();
  });
});
