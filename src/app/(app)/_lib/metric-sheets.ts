/**
 * Les fiches d'explication des métriques — contenu statique, données pures.
 *
 * **La règle qui gouverne ce fichier** : chaque ligne de `computed` décrit ce
 * que Trainarr calcule *réellement*, relu dans `src/lib/metrics/` et
 * `src/data/training-metrics.ts`. Une fiche qui décrirait une formule que
 * l'appli n'applique pas serait pire qu'une absence de fiche — elle aurait
 * l'air officielle. Constantes, fenêtres et conditions de refus sortent du
 * code, jamais d'un souvenir de la littérature.
 *
 * Si une constante bouge dans `lib/metrics/`, la fiche correspondante bouge
 * avec elle. Les sources, module par module :
 *
 * | Fiche                | Source                                                        |
 * |----------------------|---------------------------------------------------------------|
 * | ctl / atl / tsb      | `lib/metrics/load.ts`, `data/training-metrics.ts`, `_lib/metric-tone.ts` |
 * | trimp                | `lib/metrics/trimp.ts`, `data/training-metrics.ts`            |
 * | vo2max               | `lib/metrics/vo2max.ts`, `lib/metrics/vdot.ts`, `data/training-metrics.ts` |
 * | vdot                 | `lib/metrics/vdot.ts`, `lib/metrics/fitness-test.ts`          |
 * | decoupling / ef      | `lib/metrics/decoupling.ts`, `activities/[id]/_lib/decoupling-model.ts` |
 * | hr-zones             | `lib/metrics/hr-zones.ts`, `lib/metrics/lthr.ts`, `lib/metrics/series.ts` |
 * | pace-distribution    | `lib/metrics/distribution.ts`                                 |
 * | hr-distribution      | `lib/metrics/distribution.ts`, `lib/metrics/hr-zones.ts`      |
 * | best-segments        | `lib/metrics/best-segments.ts`                                |
 * | personal-bests       | `lib/metrics/best-segments.ts`, `data/personal-bests.ts`      |
 * | monotony             | `lib/metrics/monotony.ts`, `_lib/metric-tone.ts`             |
 * | race-prediction      | `lib/metrics/race-prediction.ts`, `lib/metrics/vdot.ts`, `data/race-prediction.ts` |
 * | session-goals        | `lib/metrics/session-execution.ts`, `activities/[id]/_lib/session-execution-model.ts` |
 * | splits               | `lib/metrics/splits.ts`, `lib/metrics/series.ts`              |
 * | stride               | `lib/metrics/stride.ts`, `data/activities.ts`                 |
 * | hrv / resting-hr     | `lib/intervals/wellness-client.ts`, `lib/wellness/hrv.ts`, `lib/metrics/resting-hr.ts`, `data/wellness.ts` |
 *
 * **Deux fiches décrivent des mesures que Trainarr ne produit pas** (`hrv`,
 * `resting-hr`) : elles sont prises par la montre. Leur section « computed » dit
 * donc ce que l'application **fait** de ces valeurs — d'où elle les tient, ce
 * qu'elle en calcule (une médiane, et rien d'autre), ce qu'elle en propose — et
 * jamais comment la montre les mesure, ce qu'aucune ligne de ce dépôt ne sait.
 *
 * Aucun `server-only` ici : le déclencheur ⓘ est un composant client, et ces
 * fiches sont du texte figé — rien à protéger, rien à aller chercher.
 */

export type MetricSheetId =
  | "ctl"
  | "atl"
  | "tsb"
  | "trimp"
  | "vo2max"
  | "vdot"
  | "decoupling"
  | "ef"
  | "hr-zones"
  | "pace-distribution"
  | "hr-distribution"
  | "best-segments"
  | "personal-bests"
  | "monotony"
  | "race-prediction"
  | "session-goals"
  | "splits"
  | "stride"
  | "hrv"
  | "resting-hr";

export type MetricSheet = {
  id: MetricSheetId;
  /** « CTL » — ce qui s'affiche à côté du ⓘ. */
  abbreviation: string;
  /** « Charge chronique » — le nom en toutes lettres. */
  name: string;
  /**
   * L'intitulé du déclencheur, écrit en entier plutôt que composé.
   *
   * Ajout au contrat d'origine : la question porte l'article (« la » CTL, « le »
   * TSB, « les » zones), qu'aucune concaténation de `abbreviation` et de `name`
   * ne produit correctement en français. C'est l'`aria-label` du bouton, la
   * seule chose qu'un lecteur d'écran annonce — elle doit être une phrase.
   */
  question: string;
  /** Ce que c'est, deux phrases. */
  what: string;
  /** Comment lire la valeur — des repères utilisables, pas « bas = mauvais ». */
  interpret: string[];
  /** Comment Trainarr la calcule — la vérité du code, constantes comprises. */
  computed: string[];
  /** La limite honnête. Obligatoire pour toute métrique estimée. */
  caveat?: string;
};

/**
 * Note transversale sur les unités de charge : CTL, ATL et TSB se comptent en
 * unités TRIMP, qui dépendent du profil (sexe, FC de repos, FC max). Le TRIMP
 * étant recalculé depuis le profil à chaque lecture, corriger sa FC max change
 * tout l'historique — c'est vrai des trois fiches, elles le disent chacune.
 */
export const METRIC_SHEETS: Record<MetricSheetId, MetricSheet> = {
  ctl: {
    id: "ctl",
    abbreviation: "CTL",
    name: "Charge chronique",
    question: "Qu'est-ce que la CTL ?",
    what: "La charge que ton corps a encaissée sur les six dernières semaines, lissée jour après jour. C'est ta forme de fond : ce que tu es capable d'absorber, pas ce que tu vaux sur un chrono.",
    interpret: [
      "Elle monte quand tu t'entraînes plus que ta moyenne des six dernières semaines, et elle redescend dès que tu lèves le pied — un jour de repos la fait baisser, c'est le fonctionnement normal du modèle, pas un recul.",
      "Ce qui se lit n'est pas la valeur absolue mais sa pente : c'est ce que dit la variation à sept jours affichée juste à côté. En hausse lente et continue, tu construis ; en hausse brutale, tu montes la marche plus vite que tu ne la digères.",
      "Ne compare jamais ta CTL à celle de quelqu'un d'autre : elle se compte en unités TRIMP, qui dépendent de ton sexe et de tes deux fréquences cardiaques de profil.",
    ],
    computed: [
      "Chaque séance produit un TRIMP ; les TRIMP d'un même jour sont additionnés.",
      "La CTL est une moyenne mobile exponentielle de constante 42 jours : chaque jour, CTL += (TRIMP du jour − CTL) ÷ 42.",
      "La série est dense du premier jour actif à aujourd'hui : un jour sans séance compte pour un TRIMP de 0 et fait donc baisser la CTL.",
      "Elle démarre à 0 au premier jour de ton historique — il n'y a aucune valeur d'amorçage, donc les premières semaines sont mécaniquement sous-estimées.",
      "Une séance sans FC moyenne ne produit aucun TRIMP : elle est ignorée, jamais estimée.",
      "La variation affichée est l'écart avec la CTL d'il y a exactement sept jours. Rien ne s'affiche si ce jour-là n'est pas dans la série.",
    ],
    caveat:
      "La CTL n'est pas une charge physique mesurée : c'est la sortie d'un modèle (Banister, 1975) nourri par le TRIMP, donc par ta fréquence cardiaque. Le TRIMP étant recalculé depuis ton profil à chaque affichage, corriger ta FC max ou ta FC de repos change rétroactivement toute la courbe.",
  },

  atl: {
    id: "atl",
    abbreviation: "ATL",
    name: "Charge aiguë",
    question: "Qu'est-ce que l'ATL ?",
    what: "La fatigue récente : la même charge que la CTL, mais lissée sur une semaine au lieu de six. Elle réagit vite à ce que tu viens de faire.",
    interpret: [
      "Elle grimpe dès la séance dure ou la sortie longue et retombe en quelques jours de repos — c'est cette réactivité qui la rend utile, pas son niveau.",
      "Seule, elle ne dit pas grand-chose : c'est son écart à la CTL qui devient le TSB, et c'est le TSB qu'on lit.",
      "Une ATL durablement au-dessus de la CTL, c'est une accumulation ; en dessous, tu es en train d'affûter ou de te reposer.",
    ],
    computed: [
      "Même série TRIMP quotidienne que la CTL, même densification jour par jour.",
      "Moyenne mobile exponentielle de constante 7 jours : chaque jour, ATL += (TRIMP du jour − ATL) ÷ 7.",
      "Elle démarre elle aussi à 0 au premier jour de l'historique, sans valeur d'amorçage.",
    ],
    caveat:
      "Comme la CTL, elle est en unités TRIMP et dépend entièrement de ton profil cardiaque : ce n'est pas une mesure de fatigue mais l'estimation d'un modèle qui ne connaît que ta FC.",
  },

  tsb: {
    id: "tsb",
    abbreviation: "TSB",
    name: "Fraîcheur",
    question: "Qu'est-ce que le TSB ?",
    what: "L'écart entre ce que tu encaisses depuis six semaines et ce que tu viens d'encaisser cette semaine. C'est l'indicateur de fraîcheur : positif tu es reposée, négatif tu es en dette.",
    interpret: [
      "Négatif, c'est l'état normal d'un bloc de construction : tu absorbes plus que ta moyenne longue. Ce n'est pas un signal d'alarme en soi.",
      "Les bandes que l'appli affiche sous la valeur : au-dessus de +5 « frais, bien récupéré » ; entre −10 et +5 « charge et forme équilibrées » ; entre −30 et −10 « en charge — zone de progression » ; sous −30 « fatigue marquée ».",
      "Un TSB très négatif qui dure plusieurs semaines ne se rattrape pas en une nuit : c'est là qu'il faut alléger, pas insister.",
      "Un TSB haut n'est pas un but : il monte aussi quand tu ne cours plus. Frais et sans fond, ce n'est pas la forme.",
    ],
    computed: [
      "TSB = CTL − ATL, les deux valeurs prises **le même jour**.",
      "C'est un écart assumé avec la Performance Management Chart de TrainingPeaks, qui calcule le TSB du jour à partir des valeurs de la veille : un jour de décalage, choisi ici pour que le chiffre se lise « où j'en suis maintenant ».",
      "Les bandes de lecture (−30, −10, +5) sont celles de la méthode Coggan, appliquées à l'affichage seulement — le chiffre reste celui du calcul.",
    ],
    caveat:
      "Le TSB hérite de tout ce qui fragilise le TRIMP : il ne connaît ni ton sommeil, ni ton stress, ni ta musculation, ni une séance courue sans cardio. Un jour sans séance compte pour zéro et le fait donc monter, même si tu es épuisée.",
  },

  trimp: {
    id: "trimp",
    abbreviation: "TRIMP",
    name: "Charge d'une séance",
    question: "Qu'est-ce que le TRIMP ?",
    what: "Une unité unique qui résume le coût d'une séance en mêlant sa durée et son intensité cardiaque. C'est la brique élémentaire : CTL, ATL et TSB ne sont que des moyennes mobiles de TRIMP quotidiens.",
    interpret: [
      "Doubler la durée double le TRIMP ; monter en intensité le fait croître beaucoup plus vite, la pondération étant exponentielle. Une heure de footing et une demi-heure de seuil peuvent donc peser pareil.",
      "À FC moyenne égale à ta FC de repos, une minute vaut 0 ; à FC max, elle vaut environ 4,4 points chez l'homme et 4,6 chez la femme. C'est l'ordre de grandeur du levier de l'intensité.",
      "Compare-le à tes propres séances du même type, jamais à un barème extérieur : l'échelle dépend de ton profil.",
    ],
    computed: [
      "Formule de Banister : durée en minutes × HRr × a × e^(b × HRr), où HRr = (FC moyenne − FC de repos) ÷ (FC max − FC de repos).",
      "Les coefficients dépendent du sexe déclaré au profil : a = 0,64 et b = 1,92 chez l'homme, a = 0,86 et b = 1,67 chez la femme.",
      "HRr est borné dans [0, 1] : une FC moyenne sous ta FC de repos ou au-dessus de ta FC max est traitée comme une aberration de capteur, jamais comme une charge négative ou majorée.",
      "La durée retenue est le temps en mouvement de la séance, pas le temps écoulé.",
      "Rien n'est calculé — la valeur reste un tiret — s'il manque la FC moyenne de la séance, ta FC de repos, ta FC max ou ton sexe, ou si ta FC max est inférieure ou égale à ta FC de repos.",
    ],
    caveat:
      "Le TRIMP ne connaît que ta fréquence cardiaque. Un fractionné court, où le cœur n'a pas le temps de monter, est sous-évalué ; une sortie par forte chaleur, où il monte sans que l'effort soit plus dur, est surévaluée. Les coefficients sexués viennent d'une régression publiée en 1991 sur la relation lactate / réserve cardiaque : ils ne sont pas ajustés à ta physiologie.",
  },

  vo2max: {
    id: "vo2max",
    abbreviation: "VO₂max",
    name: "Consommation maximale d'oxygène, estimée",
    question: "Qu'est-ce que la VO₂max estimée ?",
    what: "Le volume d'oxygène que ton organisme peut consommer par minute et par kilo, en ml/kg/min. Trainarr ne la mesure pas : il la déduit de ton allure corrigée par ta fréquence cardiaque, séance après séance.",
    interpret: [
      "Suis la tendance, jamais le point. Chaque course produit sa propre estimation, et le vent, la chaleur, le relief ou une ceinture qui décroche la font bouger de plusieurs points d'un jour à l'autre.",
      "Elle monte quand tu cours plus vite à fréquence cardiaque égale — c'est exactement la grandeur que le calcul lit, et c'est un bon résumé du travail aérobie.",
      "Une seule sortie basse ne dit rien. Une courbe de tendance qui baisse plusieurs semaines de suite, si — fatigue accumulée, maladie, ou FC max de profil devenue fausse.",
      "Elle ne remplace pas un chrono : pour caler tes allures d'entraînement, c'est le chrono de référence du plan qui fait foi, pas ce nombre.",
    ],
    computed: [
      "Méthode de Runalyze, relevée dans son code source. Trois temps : le rapport FC moyenne ÷ FC max de profil donne la fraction de vitesse soutenue, exp((rapport − 1,00466) ÷ 0,68725) ; l'allure tenue est extrapolée à 100 % de cette vitesse ; le coût en oxygène de Daniels & Gilbert est appliqué à la vitesse extrapolée, VO2 = −4,60 + 0,182258·v + 0,000104·v² (v en m/min).",
      "La correction porte sur la **vitesse**, pas sur la VO2 — c'est ce qui rend le calcul valable sur un footing et non seulement sur une performance maximale.",
      "Une séance ne compte que si tout est réuni : c'est une course à pied, au moins 1 500 m et 4 min, une FC moyenne enregistrée, une FC max au profil, un rapport FC moyenne / FC max entre 0,5 et 1, et un résultat entre 20 et 90 ml/kg/min. Sinon rien n'est produit — jamais d'approximation.",
      "La valeur affichée en tuile est la moyenne des courses des 30 derniers jours, **pondérée par le temps de déplacement** : une sortie d'une heure pèse cinq fois plus qu'une sortie de douze minutes.",
      "La variation affichée est l'écart avec la même moyenne calculée sur les 30 jours précédents.",
      "Sur la page Progression, le nuage donne une estimation par course et la courbe est cette même moyenne glissante à 30 jours, recalculée jour par jour.",
    ],
    caveat:
      "C'est une estimation d'après ta fréquence cardiaque et ton allure, pas une mesure de laboratoire : aucun masque, aucun échange gazeux. Elle dépend entièrement de la FC max que tu as saisie — une FC max trop haute tire l'estimation vers le bas, et l'inverse. Trainarr n'applique ni le facteur correctif de Runalyze, qui recale l'estimation sur des courses réelles déclarées, ni sa correction de dénivelé : faute de courses de référence, les valeurs peuvent lire un peu haut.",
  },

  vdot: {
    id: "vdot",
    abbreviation: "VDOT",
    name: "Indice de performance de Daniels",
    question: "Qu'est-ce que le VDOT ?",
    what: "La note unique que Jack Daniels tire d'un chrono de course : une VO₂max « effective » qui résume ce que tu vaux aujourd'hui. C'est elle, et rien d'autre, qui fixe toutes les allures de ton plan.",
    interpret: [
      "Ce n'est pas une VO₂max de laboratoire : le VDOT intègre ton rendement de course autant que ta cylindrée. Deux coureuses de même VO₂max n'ont pas le même VDOT.",
      "Un point de VDOT vaut environ 38 secondes sur 5 km (mesuré autour de 27:00). C'est aussi le gain minimal qu'un test doit produire pour recaler ton plan.",
      "Les meilleures ancres sont un 5 km ou un 10 km : la régression est la plus juste sur des efforts de 15 à 50 minutes. Un semi et surtout un marathon dépendent davantage de ton endurance et de ta gestion que de ta VO₂max — mal géré, un marathon te sous-estime.",
    ],
    computed: [
      "Le chrono de référence (distance + temps) donne une vitesse moyenne v en m/min.",
      "Coût en oxygène (Daniels & Gilbert, 1979) : VO2 = −4,60 + 0,182258·v + 0,000104·v².",
      "Fraction de VO₂max soutenable sur t minutes : 0,8 + 0,1894393·e^(−0,012778·t) + 0,2989558·e^(−0,1932605·t). VDOT = VO2 ÷ fraction.",
      "Un chrono est refusé — signalé comme erreur de saisie, jamais approché — si la vitesse moyenne sort de 1,6 à 8 m/s, ou si le VDOT obtenu sort de 20 à 90. En pratique c'est cette dernière borne qui tranche : au-delà d'environ 42:40 sur 5 km, 1 h 29 sur 10 km, 3 h 15 sur semi et 6 h 36 sur marathon.",
      "Les créneaux d'allure en découlent : E de 62 à 70 % du VDOT, M de 75 à 84 %, T de 83 à 88 %, I de 95 à 100 %, et R qui dépend du niveau (centre à 104,6 % pour un VDOT 30, 107,2 % pour un VDOT 50, bande de ±2,5 points). Ces pourcentages ont été calés sur les allures publiées par Daniels — jamais ses régressions, qui restent intactes.",
      "Un test chronométré ne relève ta référence que s'il gagne au moins 1 point de VDOT, au plus une fois tous les 28 jours, et seulement si tu as atteint 95 % de ta FC max pendant la séance. Un test moins bon ne dégrade rien.",
    ],
    caveat:
      "Le modèle suppose un effort **maximal** : la fraction soutenable est déduite de la seule durée, en postulant que tu as donné tout ce que tu pouvais tenir. Un chrono couru en gestion te sous-estime. C'est sans danger ici — rien ne se dégrade jamais à la baisse — mais tes allures resteront calées sur une performance ancienne tant qu'un vrai test ne les aura pas relevées.",
  },

  decoupling: {
    id: "decoupling",
    abbreviation: "Pa:Hr",
    name: "Dérive cardiaque",
    question: "Qu'est-ce que la dérive cardiaque ?",
    what: "L'écart de rendement entre la première et la seconde moitié d'une séance : est-ce que le même effort t'a coûté plus de battements sur la fin ? C'est le marqueur usuel de l'endurance aérobie, aussi appelé découplage Pa:Hr.",
    interpret: [
      "Positif = dérive : la seconde moitié coûte plus cher en battements que la première, soit parce que le cœur est monté à allure tenue, soit parce que l'allure a lâché à cœur tenu.",
      "Les seuils que l'appli affiche à côté de la valeur : jusqu'à 5 % « couplage stable » — c'est la frontière de Joe Friel pour une endurance aérobie établie ; de 5 à 10 % « dérive modérée » ; au-delà de 10 % « forte dérive », qui pointe la chaleur, la déshydratation, ou une intensité trop haute pour la durée visée.",
      "Négatif, il n'y a rien à signaler : l'efficience s'est améliorée en cours de route, ce qui arrive quand le début de séance est le moment le moins efficient.",
      "À lire sur une sortie longue régulière. Sur un fractionné, l'alternance effort/récupération domine tout et le chiffre ne veut rien dire.",
    ],
    computed: [
      "La séance est coupée en deux moitiés de **temps en mouvement** égal — pas de temps écoulé : une auto-pause de dix minutes au feu rouge ne doit pas décaler la frontière.",
      "Chaque moitié reçoit son facteur d'efficience EF = vitesse moyenne (m/s) ÷ FC moyenne (bpm), les deux moyennes pondérées par la durée réellement représentée par chaque échantillon.",
      "Découplage = (EF de la 1ʳᵉ moitié − EF de la 2ᵉ) ÷ EF de la 1ʳᵉ × 100.",
      "Rien n'est calculé sous 20 minutes de temps en mouvement : la dérive cardiaque est un phénomène thermique et de déshydratation, sur dix minutes on ne mesurerait que la montée en régime initiale du cœur.",
      "Rien n'est calculé non plus si une moitié est couverte à moins de 70 % par des points portant **à la fois** vitesse et FC : une ceinture qui décroche sur la fin fabriquerait un découplage entièrement imaginaire.",
      "Les points à l'arrêt (vitesse nulle ou négative) et les FC nulles sont écartés : ce ne sont pas des mesures d'effort.",
    ],
    caveat:
      "Le calcul compare deux moyennes, il ne sait pas ce que tu as fait entre les deux. Une côte placée en seconde moitié, un vent qui tourne ou un changement d'allure volontaire produisent la même dérive qu'une perte d'endurance. Le chiffre pose une question, il ne répond pas.",
  },

  ef: {
    id: "ef",
    abbreviation: "EF",
    name: "Facteur d'efficience",
    question: "Qu'est-ce que l'EF, le facteur d'efficience ?",
    what: "Combien de mètres par seconde tu obtiens pour chaque battement par minute. C'est le rendement brut de ton moteur : plus il est élevé, plus tu vas vite pour le même cœur.",
    interpret: [
      "Il vaut de l'ordre de 0,027 m/s par bpm en course à pied, d'où les trois décimales affichées : au centième, les deux moitiés de séance montreraient le même nombre.",
      "Sa valeur absolue n'a d'intérêt que comparée à toi-même, sur des séances de même nature : le relief et le vent le font varier autant que la forme.",
      "Ici il n'est montré que pour rendre la dérive cardiaque lisible — ce qui compte est l'écart entre les deux moitiés, pas le niveau.",
    ],
    computed: [
      "EF = vitesse moyenne de la moitié (m/s) ÷ FC moyenne de la moitié (bpm).",
      "Les deux moyennes sont pondérées par la durée que chaque échantillon représente réellement, et calculées sur les seuls points portant à la fois une vitesse et une FC mesurées.",
      "Les durées viennent du sous-axe de ces points appariés, pas de l'axe complet : une FC écrite un point sur quatre représente quatre secondes par mesure, et pondérer autrement reviendrait à compter des points.",
    ],
    caveat:
      "L'EF ne corrige ni le dénivelé, ni le vent, ni la surface. Une moitié de séance en descente affiche un excellent rendement qui ne doit rien à ta condition physique.",
  },

  "hr-zones": {
    id: "hr-zones",
    abbreviation: "Z1–Z5",
    name: "Zones cardio",
    question: "Que sont les zones cardio Z1 à Z5 ?",
    what: "Le temps de la séance réparti en cinq tranches d'intensité. C'est la lecture la plus directe de « à quelle intensité ai-je réellement couru ». Les tranches se définissent en pourcentage d'une référence de ton profil : ta FC seuil si tu en as adopté une, ta FC max sinon.",
    interpret: [
      "Z1 récupération, Z2 endurance fondamentale, Z3 endurance active, Z4 seuil, Z5 VMA et anaérobie.",
      "Sur une sortie facile, l'essentiel du temps doit tomber en Z1–Z2. Une sortie « facile » qui passe la moitié du temps en Z3 n'est pas facile — c'est le principal usage de ce panneau.",
      "Sur une séance de qualité, regarde le temps passé en Z4–Z5 plutôt que la durée totale : c'est lui qui pèse.",
      "L'ancrage actif est écrit sous les barres du panneau (« Zones calées sur ta FC seuil / ta FC max »), et la FC seuil en vigueur est rappelée dans tes réglages. Les deux ancrages ne donnent pas les mêmes frontières : ne compare pas une répartition d'avant l'adoption à une répartition d'après sans le savoir.",
      "Le total en tête du panneau est le temps enregistré, pas la durée de la séance : un écart s'explique par des pauses ou par des trous de la ceinture, jamais par une erreur de comptage.",
    ],
    computed: [
      "Chaque mesure de FC est convertie en pourcentage de la référence, puis rangée dans sa tranche — bornes basses incluses, hautes exclues.",
      "Ancrage sur la FC max (par défaut) : Z1 sous 60 %, Z2 de 60 à 70, Z3 de 70 à 80, Z4 de 80 à 90, Z5 à partir de 90. C'est le modèle à cinq zones des montres grand public.",
      "Ancrage sur la FC seuil (dès que tu en as adopté une) : Z1 sous 85 %, Z2 de 85 à 90, Z3 de 90 à 95, Z4 de 95 à 100, Z5 à partir de 100 %. Ce sont les frontières de l'échelle course à pied de Joe Friel, dont les trois sous-zones du haut (5a, 5b, 5c) sont réunies ici en une seule Z5 — aucune borne n'est déplacée.",
      "Tout ce qui est très bas compte en Z1 (arrêts, récupérations) plutôt que d'être jeté : sans quoi la somme des zones ne vaudrait plus la durée enregistrée et le temps disparu serait inexplicable.",
      "Le temps n'est pas un comptage de points : chaque mesure porte la durée qu'elle représente vraiment (règle du point milieu), plafonnée à trois fois le pas médian de la séance et à une seconde au minimum.",
      "Ce plafond fait qu'une auto-pause n'est du temps passé dans aucune zone — le total est donc le temps enregistré, pas le temps écoulé.",
      "Les durées se calculent sur le sous-axe des instants où la ceinture a réellement parlé : une FC écrite un point sur quatre représente quatre secondes par mesure, pas une.",
      "Sans FC max ni FC seuil au profil, aucune zone n'est calculée — rien n'est déduit de ton âge.",
      "Rien n'est stocké : les zones se recalculent à chaque affichage depuis ton profil. Adopter une FC seuil relit donc **tout** ton historique dans le nouveau cadre, et corriger une valeur de profil le relit à nouveau. Aucune ligne n'est réécrite en base.",
    ],
    caveat:
      "Ancrées sur la FC max, les zones supposent que le même pourcentage décrit le même effort chez tout le monde — ce qui est faux : à pourcentage de FC max égal, les réponses métaboliques diffèrent nettement d'un individu à l'autre (Scharhag-Rosenberger et al., 2010). Deux coureurs à 190 de FC max dont les seuils sont à 165 et 178 ne courent pas la même chose à 85 %. C'est pourquoi l'ancrage sur la FC seuil est préférable dès qu'elle est mesurée : le seuil lactique est un repère individuel, et un prédicteur valide de la performance d'endurance (revue Faude, Kindermann & Meyer, Sports Med 2009). Dans les deux cas, les zones ne valent que ce que vaut la référence : une FC max saisie de mémoire ou une FC seuil mesurée sur trois séances par forte chaleur déplacent toutes les frontières.",
  },

  "pace-distribution": {
    id: "pace-distribution",
    abbreviation: "Allure",
    name: "Répartition du temps par tranche d'allure",
    question: "Comment se lit la distribution de l'allure ?",
    what: "Le temps passé dans chaque tranche d'allure de quinze secondes au kilomètre. Là où l'allure moyenne écrase tout en un chiffre, cet histogramme montre la forme réelle de la séance.",
    interpret: [
      "Un pic unique et étroit, c'est une sortie tenue à allure régulière. Deux pics, c'est un fractionné : l'un sur l'allure d'effort, l'autre sur celle de récupération.",
      "Un étalement large sans pic net signale une allure subie — relief, trafic, fatigue — plutôt que choisie.",
      "Les colonnes de bord (avant 3:00/km, après 12:00/km) regroupent tout ce qui sort de l'axe : elles n'ont pas de largeur comparable aux autres.",
    ],
    computed: [
      "Tranches de 15 s/km, axe borné de 3:00/km à 12:00/km ; au-delà des bornes, le temps part dans deux colonnes de bord ouvertes, émises seulement si elles contiennent du temps.",
      "On somme du **temps**, pas des échantillons : chaque point porte la durée qu'il représente, plafonnée à trois fois le pas médian de la série. Une auto-pause n'est donc du temps passé dans aucune tranche.",
      "Les points sous 0,5 m/s (soit 33:20/km) sont écartés purement et simplement : c'est de l'arrêt, pas une allure très lente, et ils ne vont pas non plus dans la colonne de bord haute.",
      "Un point muet est exclu, jamais comblé : les durées se calculent sur le sous-axe des instants réellement mesurés.",
      "Les tranches vides intermédiaires sont affichées à zéro : un creux entre deux tranches occupées est une information.",
    ],
  },

  "hr-distribution": {
    id: "hr-distribution",
    abbreviation: "FC",
    name: "Répartition du temps par tranche de fréquence cardiaque",
    question: "Comment se lit la distribution cardiaque ?",
    what: "Le temps passé dans chaque tranche de cinq battements par minute. C'est la version continue des zones cardio : mêmes données, mais sans regroupement en cinq paliers.",
    interpret: [
      "Le sommet de l'histogramme désigne la FC que tu as réellement tenue, souvent plus parlante que la FC moyenne quand la séance a alterné.",
      "Une traîne étalée vers le bas correspond aux récupérations et aux arrêts ; une traîne vers le haut, aux relances.",
      "Quand ton profil porte une référence cardiaque, chaque tranche est colorée par sa zone : les frontières de couleur sont exactement celles des zones cardio, jamais un découpage à part — ancrage compris, donc adopter une FC seuil déplace aussi les couleurs de cet histogramme.",
    ],
    computed: [
      "Tranches de 5 bpm. Aucune borne imposée, contrairement à l'allure : l'axe est déduit des données, arrondi au multiple de 5 englobant — il n'y a donc pas de colonne de bord.",
      "On somme du temps et non des points, avec le même plafond de durée par échantillon (trois fois le pas médian) : une auto-pause n'apparaît nulle part.",
      "Les valeurs nulles ou négatives sont écartées comme des artefacts : un cœur à 0 bpm n'est pas une mesure.",
      "La couleur des tranches reprend les seuils des zones cardio — 60, 70, 80, 90 % de la FC max, ou 85, 90, 95, 100 % de la FC seuil quand tu en as adopté une. Sans référence au profil, les colonnes restent neutres et la légende ne promet rien.",
    ],
  },

  "best-segments": {
    id: "best-segments",
    abbreviation: "Segments",
    name: "Meilleurs efforts continus",
    question: "Que sont les meilleurs segments ?",
    what: "Pour chaque distance de référence, le temps le plus court mis à la couvrir sur n'importe quelle portion continue de la séance. Ce ne sont pas des tours de montre : le meilleur 1 000 m d'un fractionné peut chevaucher deux répétitions.",
    interpret: [
      "C'est la mesure de ce que tu as vraiment sorti ce jour-là, indépendamment de la façon dont la montre a découpé la séance.",
      "Les distances plus longues que la séance sont absentes du tableau, jamais affichées à zéro : un 10 km n'existe pas dans une sortie de 8 km.",
      "Sur une sortie longue régulière, ces temps ne veulent presque rien dire ; sur une séance de qualité, ils sont le résumé le plus honnête.",
    ],
    computed: [
      "Distances balayées : 400 m, 1 km, 1 mile (1 609,34 m), 5 km, 10 km et le semi-marathon (21 097,5 m). Le marathon n'y est pas — il ne se court pas à l'entraînement.",
      "Le temps affiché est le temps **écoulé** entre les deux bornes, pauses comprises — c'est la convention Strava, et la seule honnête : s'arrêter trente secondes au milieu de son 1 000 m ne donne pas droit à un record. C'est le seul endroit de la page où le temps n'est pas le temps enregistré.",
      "La borne de départ est interpolée entre les deux échantillons qui l'encadrent : sans cela on mesurerait le temps mis pour 1 012 m et non pour 1 000 m.",
      "Seuls les points où la distance est réellement mesurée sont balayés. Reporter la dernière distance connue produirait des records plus rapides que la réalité.",
      "Un cumul de distance qui recule (saut GPS) est écarté, pas ramené au maximum vu : un échantillon aberrant se jette, il ne se rattrape pas.",
    ],
    caveat:
      "Un meilleur effort ne vaut que ce que vaut la trace GPS. En sous-bois, en ville ou sur tapis, une distance sur-lue raccourcit mécaniquement le temps affiché — une erreur de 1 % suffit à changer la lecture.",
  },

  "personal-bests": {
    id: "personal-bests",
    abbreviation: "Records",
    name: "Meilleurs temps de tous les temps",
    question: "Que sont les records personnels ?",
    what: "Pour chaque distance de référence, le temps le plus court que tu aies couvert sur une portion continue d'une séance, toutes sorties confondues. Ce ne sont pas des courses officielles : ce sont tes meilleurs efforts mesurés, à l'entraînement comme en compétition.",
    interpret: [
      "Chaque ligne renvoie à la séance qui porte le record : c'est là qu'on voit dans quel contexte il a été couru — un fractionné, une course, une sortie où tu t'es fait plaisir sur la fin.",
      "Un record sur une distance courte tombe presque toujours dans une séance de qualité ; un record sur semi ne peut venir que d'une sortie longue ou d'une course. Ils ne se comparent donc pas entre eux comme une progression régulière.",
      "Tant que le message « records provisoires » s'affiche, la liste ne couvre qu'une partie de ton historique : un temps peut encore être battu par une séance plus ancienne, pas encore balayée.",
      "Le marathon n'y figure pas : les distances balayées sont celles des meilleurs efforts d'une séance, et un marathon ne se court pas à l'entraînement.",
    ],
    computed: [
      "Distances balayées : 400 m, 1 km, 1 mile (1 609,34 m), 5 km, 10 km et le semi-marathon (21 097,5 m) — les mêmes que les meilleurs segments d'une séance.",
      "Les efforts sont relevés **à l'import** de chaque séance et stockés (`activity_best_segments`) : le record est ensuite le plus petit temps de la table pour chaque distance, jamais un parcours des séries temporelles à l'affichage.",
      "Ex æquo au centième près : le record revient à la séance qui l'a établi la **première**, pas à celle qui l'a égalé ensuite.",
      "Le temps affiché est le temps **écoulé** entre les deux bornes, pauses comprises — s'arrêter trente secondes au milieu de son 1 000 m ne donne pas droit à un record.",
      "La borne de départ est interpolée entre les deux échantillons qui l'encadrent, et seuls les points où la distance est réellement mesurée sont balayés.",
      "Les séances importées avant la mise en place de cette table n'ont pas de segments tant que le rattrapage `pnpm db:backfill:best-segments` n'est pas passé. Leur nombre est affiché sous le tableau : tant qu'il n'est pas nul, les records sont provisoires.",
    ],
    caveat:
      "Un record ne vaut que ce que vaut la trace de la montre. En sous-bois, en ville ou sur tapis, une distance sur-lue raccourcit mécaniquement le temps affiché — une erreur de 1 % suffit à changer la lecture, et ces temps ne sont donc pas comparables à un chrono de course mesuré sur un parcours homologué.",
  },

  monotony: {
    id: "monotony",
    abbreviation: "Monotonie",
    name: "Monotonie et contrainte de Foster",
    question: "Qu'est-ce que la monotonie de l'entraînement ?",
    what: "L'uniformité d'une semaine d'entraînement : la charge moyenne de tes sept derniers jours divisée par sa dispersion. Ce n'est pas un volume — c'est la réponse à « est-ce que j'alterne vraiment dur et facile, ou est-ce que je répète sept fois la même séance moyenne ? ».",
    interpret: [
      "Elle monte quand tous tes jours se ressemblent, et elle baisse dès que la semaine oppose des séances dures à des jours vraiment faciles ou à du repos. Deux semaines de charge totale identique n'ont pas la même monotonie.",
      "Le repère usuel (Foster, 1998) place la limite autour de 2 : au-delà, l'alternance est jugée insuffisante. C'est une moyenne de population, pas un seuil calé sur toi — une valeur à 2,1 pose une question, elle ne constate pas une faute.",
      "La contrainte remet le volume dans l'équation : une semaine monotone mais légère n'est pas une semaine monotone et lourde. Elle se lit contre tes propres semaines, jamais contre un barème — il n'existe aucun seuil publié.",
      "Les deux courbes se lisent en regard de la charge : la CTL dit combien tu charges, la monotonie dit comment tu répartis.",
      "Un trou dans la courbe n'est pas un zéro : c'est une semaine où la monotonie n'a pas de sens (moins de sept jours d'historique, ou sept jours rigoureusement identiques — dont sept jours sans rien).",
    ],
    computed: [
      "Même série TRIMP quotidienne que la CTL et l'ATL, densifiée jour par jour : un jour de repos entre dans la fenêtre **avec une charge de 0**, jamais écarté — l'écarter reviendrait à effacer exactement l'information cherchée.",
      "Fenêtre glissante de 7 jours s'achevant à la date affichée. Monotonie = moyenne des sept charges ÷ leur écart-type.",
      "L'écart-type est celui de la **population** (÷ 7), pas d'un échantillon (÷ 6) : ces sept valeurs ne sont pas un tirage, elles sont la semaine en entier.",
      "Contrainte = charge totale de la semaine × monotonie.",
      "Rien n'est rendu — jamais l'infini, jamais un zéro — sur une fenêtre incomplète (les six premiers jours de l'historique) ni sur un écart-type nul, où le quotient diverge.",
      "La série est calculée sur tout l'historique puis coupée à la période affichée : sans quoi les six premiers jours de la fenêtre seraient vides par construction.",
      "Le seuil de lecture (2) vit dans la couche d'affichage, jamais dans le calcul : le module de calcul ne rend que des nombres.",
    ],
    caveat:
      "La monotonie hérite de tout ce qui fragilise le TRIMP : elle ne connaît que ta fréquence cardiaque. Une séance courue sans cardio compte pour zéro et fait donc *baisser* la monotonie comme le ferait un jour de repos. Et le repère de 2 sort d'un suivi de groupe des années 1990, sur des sports d'endurance variés : il n'a jamais été calé sur toi, sur ton volume ni sur ton nombre de séances hebdomadaires.",
  },

  "race-prediction": {
    id: "race-prediction",
    abbreviation: "Prédictions",
    name: "Chronos prévus sur les distances de route",
    question: "Comment les chronos prévus sont-ils calculés ?",
    what: "Le temps que ton chrono de référence implique sur 5 km, 10 km, semi et marathon, d'après les tables de Daniels & Gilbert. C'est le sens inverse du VDOT : au lieu de demander « quel indice ce chrono vaut-il ? », on demande « quel chrono cet indice implique-t-il ? ».",
    interpret: [
      "Ces temps supposent un effort **maximal**, une préparation spécifique à la distance et des conditions correctes. Ce ne sont pas des objectifs de séance, et encore moins des allures d'entraînement — celles-là sont dans ton plan.",
      "La colonne « fiabilité » n'est pas décorative : `calibré` veut dire que la durée prévue tombe dans la fenêtre de 15 à 50 minutes sur laquelle la régression a été ajustée ; `extrapolé`, que le modèle est prolongé au-delà — l'ordre de grandeur tient, pas la minute ; `spéculatif`, qu'on est à plus du double de cette fenêtre.",
      "Une prédiction marathon est **spéculative à tout niveau**, sans exception : le modèle ne connaît ni l'épuisement du glycogène, ni le mur, ni la thermorégulation, ni la casse musculaire d'une course longue. Elle lit donc structurellement trop vite.",
      "La date affichée sous le tableau compte autant que les chronos : une prédiction fondée sur une performance d'il y a huit mois décrit la forme d'il y a huit mois.",
      "Le 1 500 m et le mile n'apparaissent pas, alors que tes records les portent : dès un niveau modeste, la prédiction y tombe sous la fenêtre de validité du modèle, qui ne décrit pas la part anaérobie de ces distances.",
    ],
    computed: [
      "L'ancre est le **chrono de référence de ton plan actif** (distance + temps), converti en VDOT par les deux régressions de Daniels & Gilbert — les mêmes que la fiche VDOT.",
      "La VO₂max effective de la page n'est **jamais** utilisée comme ancre : elle est corrigée par la fréquence cardiaque et ne suppose pas un effort maximal. Sans chrono de référence, rien n'est prédit — aucune valeur de repli n'est inventée.",
      "Un test chronométré n'est pas une source séparée : quand il bat la référence, c'est la référence elle-même qu'il remplace, une fois la recalibration acceptée.",
      "Le chrono prévu est la racine de VDOT(distance, t) = ton VDOT, résolue par bissection : l'inconnue apparaît des deux côtés de l'équation et il n'existe pas de forme close.",
      "Rien n'est rendu pour une distance dont la racine tomberait sous 4 minutes (plancher du modèle) ou au-delà de 8 heures : la ligne disparaît, elle ne s'affiche jamais approchée.",
      "Le niveau de fiabilité se déduit de la seule durée prévue : dans la fenêtre 15–50 min → calibré ; jusqu'à un facteur 2 hors de cette fenêtre → extrapolé ; au-delà → spéculatif.",
      "Ce tableau ne dépend pas de la période affichée : c'est un état courant, comme la CTL du jour.",
    ],
    caveat:
      "C'est une projection, pas une performance. Le modèle ne connaît que ton chrono de référence : ni ton kilométrage, ni ta plus longue sortie, ni ton expérience de la distance, ni la chaleur du jour J. Il suppose de surcroît que ce chrono a été couru à fond — une référence courue en gestion te sous-estime sur toute la ligne. Et il ne dit rien de ta capacité à *tenir* une distance que tu n'as jamais courue : un marathon prévu à 3 h 20 sur la foi d'un 5 km ne se court pas en 3 h 20 sans les semaines qui vont avec.",
  },

  "session-goals": {
    id: "session-goals",
    abbreviation: "Objectifs",
    name: "Cibles de la séance planifiée",
    question: "Comment les objectifs de séance sont-ils comparés ?",
    what: "La confrontation de ce que la séance du plan demandait à ce que tu as réellement couru : une barre par cible, la bande visée en aplat et ton réalisé en marqueur par-dessus. Rien n'est stocké — tout se recalcule à chaque affichage, depuis ton profil du moment.",
    interpret: [
      "L'aplat est ce qui était demandé, le repère clair est ce que tu as fait. Être hors de la bande n'est pas une faute : plus vite que la bande d'un footing est un écart au même titre que plus lentement, et c'est pour ça qu'aucune barre ne change de couleur selon le résultat.",
      "Sur une séance à blocs, une barre par répétition, et la ligne du haut dit combien sont tombées dans la bande. Sur une séance simple, l'allure et la fréquence cardiaque moyennes de la séance entière — la moyenne d'un fractionné, elle, ne vise rien et n'est donc jamais affichée.",
      "Le volume (distance ou durée) n'a pas de bande : il se lit à son écart avec ce qui était prescrit.",
    ],
    computed: [
      "Les cibles viennent du déroulé de la séance planifiée : la bande d'allure des étapes de course, ou leur cible cardiaque — rang de zone et sous-créneau — résolue en battements sur la référence de ton profil (ta FC seuil si tu en as adopté une, ta FC max sinon).",
      "Un fichier FIT ne dit pas où commence une répétition. Les blocs sont donc retrouvés par la portion la plus rapide de la longueur prescrite, puis la recherche recommence en dehors de cette portion : pour 6 × 800 m, six fenêtres de 800 m qui ne se chevauchent pas, remises dans l'ordre du chrono. C'est la mécanique qui sert déjà à mesurer ta FC seuil.",
      "L'allure d'un bloc est celle du bloc entier — distance prescrite ÷ temps écoulé entre ses deux bornes. Pas de règle de la seconde moitié ici : contrairement à la fréquence cardiaque, une allure n'a pas d'inertie.",
      "« Dans la bande » se juge sur la valeur affichée, arrondie comme elle est écrite (à la seconde par kilomètre, au battement), bornes incluses.",
      "Les blocs, c'est tout ou rien : si les six fenêtres ne se placent pas, ou si le capteur de distance couvre moins de 70 % de l'une d'elles, aucune répétition n'est affichée — et le panneau dit pourquoi. Cinq fenêtres sur six ne sont pas cinq répétitions, c'est une localisation ratée dont on ignore laquelle manque.",
      "Une cible qui n'a pas été prescrite ne produit aucune ligne. Une cible prescrite mais non comparable produit une phrase, jamais une valeur approchée.",
    ],
    caveat:
      "Les blocs sont déduits, pas lus. Sur une séance courue comme prescrite, la portion la plus rapide de la bonne longueur est bien la répétition : toute fenêtre décalée mordrait sur une récupération, donc serait plus lente. Sur une séance courue très différemment de ce qui était prévu — blocs raccourcis, récupérations avalées, séance écourtée — ce ne sont plus que les portions les plus rapides de la trace, et la comparaison perd son sens sans que rien ne puisse toujours le détecter.",
  },

  splits: {
    id: "splits",
    abbreviation: "Km",
    name: "Découpage kilométrique",
    question: "Comment sont calculés les temps au kilomètre ?",
    what: "La séance découpée en kilomètres réels, avec le temps, l'allure, la FC moyenne et le dénivelé de chacun. C'est la lecture la plus immédiate d'une sortie : la dérive, le negative split, la côte du quatrième kilomètre.",
    interpret: [
      "La barre d'allure se lit relativement à la séance — ses bornes sont le kilomètre le plus rapide et le plus lent de la sortie. Elle raconte ta régularité, pas une performance absolue.",
      "Un dernier kilomètre marqué comme partiel n'est pas comparable aux autres : son allure porte sur une distance plus courte.",
      "Le temps d'un kilomètre est le temps enregistré, cohérent avec la tuile « Durée » de la séance — il ne comptera donc jamais une auto-pause.",
    ],
    computed: [
      "Le découpage se fait sur les séries `distance` et `temps`, **jamais** sur les tours du fichier FIT : un tour est ce que l'auto-lap a découpé, pas un kilomètre.",
      "L'instant de franchissement de chaque borne est interpolé entre les deux points qui l'encadrent — on ne fabrique pas une mesure, on lit une grandeur dérivée de deux axes croissants et mesurés.",
      "Le kilomètre 1 part de la **première distance mesurée** : ce qui précède le premier fix GPS (une minute d'attente au départ) n'appartient à aucun kilomètre, sans quoi la FC de repos d'avant le départ entrerait dans la moyenne.",
      "Le temps d'un split est le temps enregistré : l'écart des bornes interpolées, diminué de la part des trous qui dépasse le plafond d'échantillonnage.",
      "La FC moyenne est pondérée par la durée de chaque mesure, sur le sous-axe des seuls instants où la ceinture a parlé, puis arrondie au bpm.",
      "Le dénivelé positif est filtré par une hystérésis de 1 m : un altimètre barométrique oscille de quelques dizaines de centimètres au repos, et une somme naïve fabriquerait des dizaines de mètres de D+ fantôme sur un parcours plat.",
      "Un reliquat final de moins de 100 m n'est pas affiché — et n'est reversé sur aucun autre kilomètre : son allure serait dominée par l'imprécision GPS.",
    ],
  },

  stride: {
    id: "stride",
    abbreviation: "Foulée",
    name: "Longueur de foulée",
    question: "Qu'est-ce que la longueur de foulée ?",
    what: "La distance parcourue par un pas, en mètres. Ce n'est pas une formule empirique mais une définition : deux grandeurs mesurées, un quotient.",
    interpret: [
      "Repère : 3,33 m/s (soit 3:00/km) à 170 pas/min donne environ 1,18 m.",
      "À cadence constante, elle suit ton allure — c'est attendu, pas une information. Ce qui se lit, c'est la façon dont tu accélères : en allongeant la foulée, ou en montant la cadence.",
      "Une foulée qui s'allonge sur la fin d'une séance à allure tenue signale souvent une cadence qui s'effondre — regarde les deux courbes ensemble.",
    ],
    computed: [
      "Longueur = 60 × vitesse (m/s) ÷ cadence (pas/min).",
      "La cadence attendue est en **pas** par minute, les deux jambes (de l'ordre de 160 à 180 en course). Le fichier FIT écrit souvent la cadence par jambe : le parseur la double, mais pour les sports à pied uniquement.",
      "La courbe n'est tracée que pour les sports à pied. À vélo, `cadence` compte des tours de pédalier et le quotient donnerait un développement — une grandeur juste sous un mauvais nom reste une donnée fausse.",
      "Un point dont la vitesse ou la cadence est muette vaut « pas de mesure » : la dernière cadence connue n'est jamais reportée sur une vitesse fraîche.",
      "À l'arrêt, rien n'est calculé — il n'y a ni pas ni foulée, et une cadence nulle ferait diverger le quotient.",
    ],
  },

  hrv: {
    id: "hrv",
    abbreviation: "HRV",
    name: "Variabilité cardiaque (rMSSD ou SDNN)",
    question: "Qu'est-ce que la HRV ?",
    what: "L'irrégularité, en millisecondes, des intervalles entre deux battements pendant ton sommeil. C'est un reflet de l'équilibre de ton système nerveux autonome — grossièrement : à quel point ton organisme est en récupération plutôt qu'en alerte.",
    interpret: [
      "Il n'existe aucune valeur « normale » : la HRV dépend de l'âge, de la génétique et surtout de la méthode de mesure. La seule comparaison qui vaut, c'est toi contre toi-même, sur le même appareil.",
      "Ce qui se lit est la tendance sur plusieurs jours, jamais une nuit. Une valeur basse isolée signale une soirée arrosée, un dîner tardif ou une chambre trop chaude aussi souvent qu'un excès d'entraînement.",
      "Une baisse qui dure plusieurs jours en même temps qu'une FC de repos qui monte est le signal classique d'une charge mal absorbée, d'un début d'infection ou d'un manque de sommeil.",
      "Une HRV haute n'est pas un but à atteindre : elle monte aussi quand tu ne t'entraînes plus du tout.",
    ],
    computed: [
      "Trainarr ne mesure rien : la valeur est celle que ta montre a calculée pendant la nuit, synchronisée vers intervals.icu par HealthFit, puis rapatriée telle quelle une fois par jour.",
      "Il y a deux HRV, et elles ne sont pas la même chose. Le rMSSD est la racine de la moyenne des carrés des écarts entre battements *successifs* : c'est la référence du domaine en récupération, la plus sensible au système parasympathique. Le SDNN est l'écart-type des intervalles sur toute la fenêtre : il mesure la variabilité *totale*, oscillations lentes comprises, et vaut couramment le double d'un rMSSD pris la même nuit.",
      "Selon le modèle, une montre pousse l'une ou l'autre. Trainarr stocke chacune dans son propre champ et affiche **celle qui existe**, toujours étiquetée : « HRV (rMSSD) » ou « HRV (SDNN) ». Quand les deux sont mesurées le même jour, c'est le rMSSD qui s'affiche.",
      "Ces deux nombres ne se comparent ni entre eux, ni d'une montre à l'autre : il n'existe pas de conversion, et l'application n'en tente aucune. C'est aussi pourquoi une courbe ne mélange jamais les deux — la tendance trace la variante majoritaire de la période et le dit dans son titre.",
      "Une nuit sans mesure reste vide : jamais de report de la valeur de la veille, jamais de zéro.",
      "L'application n'en dérive strictement rien : ni charge, ni forme, ni recommandation automatique. Elle l'affiche, la trace sur 30 jours, et la donne à lire au coach.",
    ],
    caveat:
      "La mesure appartient à ta montre, pas à cette application : sa fenêtre (nuit entière ou phase de sommeil profond), son filtrage des artefacts et sa grandeur (rMSSD ou SDNN) sont ceux du constructeur. Changer de modèle rend la série incomparable avec la précédente — et d'autant plus si la variante change, où un même sommeil peut faire doubler le nombre affiché sans que rien n'ait bougé. Une ceinture mal placée produit une valeur plausible et fausse.",
  },

  "resting-hr": {
    id: "resting-hr",
    abbreviation: "FC repos",
    name: "Fréquence cardiaque de repos",
    question: "Qu'est-ce que la FC de repos ?",
    what: "Le rythme le plus bas de ton cœur au repos, relevé par ta montre — en pratique pendant ton sommeil. C'est l'indicateur de récupération le plus ancien et le plus robuste qui soit.",
    interpret: [
      "Elle baisse avec l'entraînement d'endurance, sur des mois : c'est un des rares chiffres qui dit que le travail de fond paie.",
      "Une hausse de 5 à 10 bpm sur plusieurs matins consécutifs est un signal — fatigue accumulée, infection qui démarre, sommeil dégradé, alcool. Un seul matin haut ne dit rien.",
      "Elle sert aussi de valeur de profil : c'est le plancher de la réserve cardiaque, donc elle pèse dans tout ce que l'appli calcule à partir de ta FC.",
    ],
    computed: [
      "La mesure vient de la montre (champ `restingHR` d'intervals.icu), rapatriée une fois par jour. Trainarr ne la calcule pas et ne la corrige pas.",
      "Le seul calcul de l'application est la **médiane des 14 derniers jours mesurés**, à partir de 5 nuits : c'est elle qui est proposée pour ton profil, jamais une nuit isolée.",
      "La proposition n'a lieu que si cette médiane s'écarte d'au moins 5 bpm de la FC de repos de ton profil — dans un sens **ou dans l'autre**, puisqu'une FC de repos baisse quand la forme monte et remonte sinon.",
      "Rien ne s'applique tout seul : tu acceptes ou tu écartes. Une valeur écartée n'est reproposée que si la médiane s'en éloigne d'au moins 2 bpm.",
      "La FC de repos du **profil** (celle que tu as acceptée ou saisie) est ce qui entre dans le TRIMP de Karvonen, donc dans la CTL, l'ATL et le TSB. Le relevé quotidien, lui, n'entre dans aucun calcul.",
    ],
    caveat:
      "Ce que la montre appelle « FC de repos » n'est pas normalisé : selon le constructeur c'est la valeur la plus basse de la nuit, une moyenne du sommeil profond, ou une moyenne des périodes d'inactivité de la journée. Deux appareils ne donnent pas le même nombre, et la série n'est comparable qu'avec elle-même.",
  },
};

/** La fiche d'une métrique. L'identifiant étant typé, elle existe toujours. */
export function metricSheet(id: MetricSheetId): MetricSheet {
  return METRIC_SHEETS[id];
}
