import { connection } from "next/server";

import { loadSettingsData } from "../_lib/settings-data";

import { SettingsOnboardingNotice } from "./settings-onboarding-notice";
import { SettingsTabs } from "./settings-tabs";

/**
 * Le contenu de la modale de réglages — un Server Component, comme tout ce qui
 * lit des données.
 *
 * Il est passé au shell client de la modale en `ReactNode`, sous `<Suspense>` :
 * la coquille de navigation reste statique et prérendue, les réglages se
 * streament derrière elle.
 *
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * ce bloc pendant `next build` (image Docker), où la base n'existe pas.
 * Cf. `.claude/rules/nextjs.md`.
 */
export async function SettingsContent() {
  await connection();
  const { mode, ...sections } = await loadSettingsData();

  if (mode === "onboarding") return <SettingsOnboardingNotice />;

  return <SettingsTabs data={sections} />;
}
