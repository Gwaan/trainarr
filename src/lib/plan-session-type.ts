/**
 * Le **type d'une séance du plan**, déduit de son seul `kind`.
 *
 * L'appli écrit ses séances avec un vocabulaire fermé — trois libellés
 * d'endurance et la course (`SESSION_KINDS`), quatre zones de qualité
 * (`QUALITY_ZONE_KINDS`), le test chronométré (`FITNESS_TEST_KIND`) — et c'est
 * ce vocabulaire, et lui seul, que ce module reconnaît. À chaque libellé
 * correspond un des huit jetons `--color-type-*` du design system, validés
 * ensemble (pire ΔE daltonien adjacent 11,2 ; cf. `.claude/rules/design.md`).
 *
 * ## Pourquoi un préfixe, et pas une égalité
 *
 * Un `kind` en base est **suffixé** : « VMA courte · piste », « Seuil ·
 * côtes ». Le suffixe précise la forme de la séance, jamais sa nature — la
 * comparaison porte donc sur la tête du libellé. Les neuf préfixes ci-dessous
 * sont deux à deux non-préfixes l'un de l'autre, l'ordre du tableau n'est donc
 * pas une donnée : aucun libellé ne peut en satisfaire deux.
 *
 * ## Pourquoi `null` plutôt qu'un repli
 *
 * Les plans écrits avant la bascule sur squelette portent des `kind` libres
 * (« Footing », « Endurance », « Côtes ») que ce vocabulaire ne couvre pas. Un
 * repli — l'endurance, par exemple — leur donnerait une couleur *fausse*, et la
 * couleur d'un type est une donnée : mieux vaut le rendu neutre. C'est aussi ce
 * qui protège la lecture du code couleur, qui ne vaut que si chaque teinte dit
 * exactement ce qu'elle prétend.
 *
 * La couleur ne porte du reste jamais l'information seule : le type reste écrit
 * en toutes lettres partout où il est colorié.
 *
 * Module **pur** : ni base, ni réseau, ni `server-only` — il est lu par le
 * calendrier, qui est un composant client.
 */

/** Les huit jetons de couleur de type, dans l'ordre où ils ont été validés. */
export const SESSION_TYPE_TOKENS = [
  'type-recovery',
  'type-easy',
  'type-long',
  'type-specific',
  'type-threshold',
  'type-interval',
  'type-repetition',
  'type-event',
] as const;

export type SessionTypeToken = (typeof SESSION_TYPE_TOKENS)[number];

/**
 * Le nom du type, tel qu'une légende l'écrit.
 *
 * « Course ou test » pour `type-event` : la course et le test chronométré
 * partagent l'indigo « événement » — un violet distinct pour le test avait été
 * essayé et rejeté, indiscernable en vision deutan (ΔE 0,9). Deux libellés
 * distincts les séparent déjà sur la séance elle-même ; une légende, elle, doit
 * nommer la **couleur**, donc la famille.
 */
export const SESSION_TYPE_LABELS = {
  'type-recovery': 'Récupération',
  'type-easy': 'Endurance fondamentale',
  'type-long': 'Sortie longue',
  'type-specific': 'Spécifique allure course',
  'type-threshold': 'Seuil',
  'type-interval': 'VMA',
  'type-repetition': 'Répétitions',
  'type-event': 'Course ou test',
} as const satisfies Record<SessionTypeToken, string>;

export type SessionType = {
  token: SessionTypeToken;
  /** Le nom du type — jamais le `kind` d'origine, qui peut être suffixé. */
  label: string;
};

/**
 * Le vocabulaire reconnu, en texte **normalisé** (minuscules, sans accents).
 *
 * `specifique` plutôt que `specifique allure course` : le libellé complet est
 * long et le suffixe peut le raccourcir en pratique, alors qu'aucun autre type
 * ne commence par ce mot. `test` plutôt que `test 5 km` pour la même raison —
 * la distance du test est un paramètre de la périodisation, pas une nature de
 * séance.
 *
 * `course` en revanche est un préfixe **entier** : « Spécifique allure course »
 * contient le mot, mais ne commence pas par lui. C'est précisément ce que la
 * comparaison par tête garantit et qu'une comparaison par inclusion perdrait.
 */
const SESSION_TYPE_PREFIXES = [
  { prefix: 'recuperation', token: 'type-recovery' },
  { prefix: 'endurance fondamentale', token: 'type-easy' },
  { prefix: 'sortie longue', token: 'type-long' },
  { prefix: 'specifique', token: 'type-specific' },
  { prefix: 'seuil', token: 'type-threshold' },
  { prefix: 'vma', token: 'type-interval' },
  { prefix: 'repetition', token: 'type-repetition' },
  { prefix: 'course', token: 'type-event' },
  { prefix: 'test', token: 'type-event' },
] as const satisfies readonly { prefix: string; token: SessionTypeToken }[];

const COMBINING_MARKS = /[\u0300-\u036f]/gu;

/** Minuscules sans accents : « Récupération », « recuperation » et « RÉCUP… » se lisent pareil. */
function normalizeKind(kind: string): string {
  return kind
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .trim();
}

/**
 * Le type d'une séance, `null` quand son `kind` n'appartient pas au vocabulaire
 * de l'appli — un plan d'avant la bascule sur squelette, par exemple.
 */
export function sessionType(kind: string): SessionType | null {
  const normalized = normalizeKind(kind);
  const match = SESSION_TYPE_PREFIXES.find((entry) => normalized.startsWith(entry.prefix));
  if (match === undefined) return null;
  return { token: match.token, label: SESSION_TYPE_LABELS[match.token] };
}

/**
 * Les types présents dans un lot de séances, sans doublon et dans l'ordre du
 * système — ce qu'une légende a besoin de savoir, et rien de plus.
 *
 * L'ordre est celui de {@link SESSION_TYPE_TOKENS}, donc celui de la validation
 * daltonienne : la légende range les couleurs comme le validateur les a
 * mesurées, du plus lent au plus dur puis l'événement, et non dans l'ordre où
 * un mois les a fait tomber.
 */
export function sessionTypesPresent(kinds: Iterable<string>): SessionType[] {
  const present = new Set<SessionTypeToken>();
  for (const kind of kinds) {
    const type = sessionType(kind);
    if (type !== null) present.add(type.token);
  }
  return SESSION_TYPE_TOKENS.filter((token) => present.has(token)).map((token) => ({
    token,
    label: SESSION_TYPE_LABELS[token],
  }));
}
