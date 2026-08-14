"use client";

import { useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { SettingsSectionsData } from "../_lib/settings-values";

import { AccountPanel } from "./account-panel";
import { IntervalsPanel } from "./intervals-panel";
import { InvitationsPanel } from "./invitations-panel";
import { ProfileForm } from "./profile-form";

/**
 * Les trois sections de réglages, écrites **une seule fois**.
 *
 * C'est le point de la découpe : ce composant est rendu tel quel par la modale
 * ouverte depuis l'avatar de la navigation *et* par la page `/profile`. Les
 * formulaires n'existent donc qu'en un exemplaire, la liste des onglets aussi,
 * et ajouter une section demain se fait ici — pas deux fois.
 *
 * Il n'apporte aucune mise en page à lui : une colonne d'onglets et de
 * panneaux, que chaque hôte pose dans son propre cadre (le corps défilant de la
 * modale, la colonne de la page). C'est ce qui lui permet d'être le même des
 * deux côtés, sans variante à maintenir.
 *
 * Les sections gardent chacune leur `<form action={serverAction}>`, leur
 * `useActionState`, leurs erreurs par champ et leur bandeau de résultat :
 * enregistrer son poids n'a rien à voir avec changer son mot de passe, et rien
 * n'est refermé ni escamoté sur un succès.
 */

const TABS = [
  { id: "profile", label: "Profil" },
  { id: "account", label: "Compte" },
  { id: "imports", label: "Import" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Le profil physiologique en premier : c'est ce qu'on vient régler le plus souvent. */
const DEFAULT_TAB: TabId = "profile";

/** Radix rend une chaîne ; on ne fait confiance qu'à la liste ci-dessus. */
function isTabId(value: string): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

export type SettingsTabsProps = {
  data: SettingsSectionsData;
};

export function SettingsTabs({ data }: SettingsTabsProps) {
  const [current, setCurrent] = useState<TabId>(DEFAULT_TAB);

  return (
    <Tabs
      value={current}
      onValueChange={(value) => {
        if (isTabId(value)) setCurrent(value);
      }}
      className="flex flex-col gap-4 sm:gap-5"
    >
      <TabsList aria-label="Sections des réglages">
        {TABS.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* `mode="edit"` : ce composant n'est monté que lorsqu'un profil existe —
          la création, elle, reste l'écran plein de `/profile`. */}
      <TabsContent value="profile" active={current === "profile"}>
        <ProfileForm mode="edit" values={data.profile} />
      </TabsContent>

      {/* Les invitations sont une affaire de compte, pas de profil physiologique
          — d'où leur place ici, sous « Ton compte », plutôt que dans un quatrième
          onglet qui n'existerait que pour une personne. Pour tout autre compte
          que le premier, la section est **absente** : rien de grisé, rien à
          deviner. */}
      <TabsContent value="account" active={current === "account"}>
        <div className="flex flex-col gap-4 sm:gap-5">
          <AccountPanel account={data.account} />
          {data.invitations.canInvite ? (
            <InvitationsPanel invitations={data.invitations.invitations} />
          ) : null}
        </div>
      </TabsContent>

      <TabsContent value="imports" active={current === "imports"}>
        <IntervalsPanel defaults={data.intervals} />
      </TabsContent>
    </Tabs>
  );
}
