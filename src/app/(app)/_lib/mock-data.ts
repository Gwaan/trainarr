/**
 * ⚠️ DONNÉES PROVISOIRES — MAQUETTE UNIQUEMENT.
 *
 * Valeurs figées servant à valider le design system « Night Track ».
 * Elles ne proviennent d'aucune mesure réelle et ne doivent jamais être
 * présentées comme telles ailleurs que dans cette maquette.
 *
 * À supprimer intégralement dès que le DAL (`src/data/`) expose les vraies
 * séries (VO₂max, ATL/CTL/TSB, activités Strava).
 */

import type { AthleteProfile } from "@/components/nav/athlete";
import type { StatCardProps } from "@/components/stat-card";

type MockStat = Omit<StatCardProps, "className">;

export const ATHLETE: AthleteProfile = {
  name: "Gwen",
  subtitle: "Prépa 10 km",
  initials: "G",
};

/** Figée volontairement : le rendu doit rester déterministe au build. */
export const TODAY_LABEL = "Mardi 11 août";

export const KPI_VO2MAX: MockStat = {
  label: "VO₂max estimée",
  value: "52.3",
  delta: { value: "0.4", direction: "up", tone: "positive" },
};

export const KPI_CTL: MockStat = {
  label: "Fitness CTL",
  value: "68",
  delta: { value: "3", direction: "up", tone: "positive" },
};

export const KPI_TSB: MockStat = {
  label: "Forme TSB",
  value: "−8",
  tone: "accent",
  note: "Fatigue — allège jeudi.",
};

export const TRAINING_LOAD = {
  weeks: ["S27", "S28", "S29", "S30", "S31", "S32"],
  /** CTL hebdomadaire, cohérente avec KPI_CTL (dernière valeur = 68, +3). */
  ctl: [54, 58, 56, 62, 65, 68],
} as const;

export const TODAY_SESSION = {
  day: "Mardi",
  kind: "VMA courte · piste",
  block: "6 × 800 m",
  target: "@ 3:45/km",
  details: [
    { label: "Échauffement", value: "20 min @ 5:30/km" },
    { label: "Récupération", value: "90 s en trot" },
    { label: "Retour au calme", value: "10 min souple" },
  ],
  summary: [
    { label: "Volume", value: "12,4 km" },
    { label: "Durée", value: "1 h 05" },
  ],
} as const;

export type MockActivity = {
  id: string;
  name: string;
  day: string;
  distance: string;
  pace: string;
  heartRate: string;
};

export const RECENT_ACTIVITIES: readonly MockActivity[] = [
  {
    id: "act-1",
    name: "Sortie longue au lac",
    day: "Dimanche",
    distance: "18,2 km",
    pace: "5:12/km",
    heartRate: "148 bpm",
  },
  {
    id: "act-2",
    name: "Footing de récupération",
    day: "Samedi",
    distance: "8,4 km",
    pace: "5:48/km",
    heartRate: "132 bpm",
  },
  {
    id: "act-3",
    name: "Seuil 3 × 10 min",
    day: "Mercredi",
    distance: "14,0 km",
    pace: "4:28/km",
    heartRate: "167 bpm",
  },
];
