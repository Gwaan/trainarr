"use client";

import { useActionState, useId, useState } from "react";

import { Banner } from "@/components/banner";
import { AUTH_PASSWORD_MIN_LENGTH } from "@/lib/auth/limits";

import {
  AuthCard,
  AuthField,
  AuthHeading,
  AuthSubmit,
} from "../../../_components/auth-form";
import { createInvitedAccountAction } from "../../../_lib/actions";
import { AUTH_FORM_IDLE } from "../../../_lib/form-state";

/**
 * Création d'un compte sur invitation — mêmes champs et mêmes bornes que
 * l'écran d'amorçage, dont il reprend les briques (`text-base` compris : en
 * dessous de 16 px, iOS zoome à la prise de focus).
 *
 * **Le jeton n'est ni affiché ni modifiable** : il traverse le formulaire dans
 * un champ caché, le temps que l'action le rende à la base. C'est le seul
 * endroit de la page où il figure — ni titre, ni message d'erreur, ni lien ne le
 * répètent.
 */
export function InvitedAccountForm({ token }: { token: string }) {
  const [state, formAction, isPending] = useActionState(
    createInvitedAccountAction,
    AUTH_FORM_IDLE,
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const uid = useId();

  return (
    <AuthCard>
      <AuthHeading
        title="Créer ton compte"
        subtitle="Tu as reçu une invitation à rejoindre cette installation. Ce lien ne sert qu'une fois."
      />

      <div
        aria-live="polite"
        className={state.status === "error" ? "mb-4" : "sr-only"}
      >
        {state.status === "error" && state.message ? (
          <Banner tone="negative" title={state.message} />
        ) : null}
      </div>

      <form action={formAction} noValidate className="flex flex-col gap-4">
        <input type="hidden" name="token" value={token} />
        <AuthField
          id={`${uid}-name`}
          name="name"
          label="Nom"
          hint="Celui qui t'accueillera sur le tableau de bord."
          type="text"
          autoComplete="name"
          error={state.fieldErrors?.name}
          value={name}
          onChange={setName}
        />
        <AuthField
          id={`${uid}-email`}
          name="email"
          label="E-mail"
          hint="Il sert d'identifiant de connexion ; aucun message n'y sera envoyé."
          type="email"
          autoComplete="email"
          error={state.fieldErrors?.email}
          value={email}
          onChange={setEmail}
        />
        <AuthField
          id={`${uid}-password`}
          name="password"
          label="Mot de passe"
          hint={`${AUTH_PASSWORD_MIN_LENGTH} caractères minimum. Il n'y a pas de récupération par e-mail : conserve-le.`}
          type="password"
          autoComplete="new-password"
          error={state.fieldErrors?.password}
          value={password}
          onChange={setPassword}
        />
        {/* La confirmation est vérifiée par l'action, pas ici : ce champ aide,
            il ne fait pas autorité. Une faute de frappe sur l'unique saisie
            créerait un compte dont le mot de passe n'est connu de personne. */}
        <AuthField
          id={`${uid}-password-confirm`}
          name="passwordConfirm"
          label="Confirme ton mot de passe"
          type="password"
          autoComplete="new-password"
          error={state.fieldErrors?.passwordConfirm}
          value={passwordConfirm}
          onChange={setPasswordConfirm}
        />
        <AuthSubmit
          pending={isPending}
          label="Créer mon compte"
          pendingLabel="Création…"
        />
      </form>
    </AuthCard>
  );
}
