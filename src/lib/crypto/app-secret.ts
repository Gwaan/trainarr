import 'server-only';

import { resolveAuthConfig } from '@/lib/auth/config';

import {
  deriveSecretKey,
  openSecret,
  sealSecret,
  SecretKeyUnavailableError,
} from './secret-box';

/**
 * Le chiffrement des secrets stockés, branché sur le secret de l'installation.
 *
 * **La clé dérive de `BETTER_AUTH_SECRET`** (HKDF, cf. `secret-box.ts`), et pas
 * d'une seconde variable d'environnement. Deux raisons : une variable
 * obligatoire de plus est une variable de plus à oublier au déploiement, et le
 * secret d'authentification est déjà celui dont dépend l'accès à l'application —
 * lui adjoindre un usage dérivé ne change pas le périmètre de ce qu'un attaquant
 * gagne en le lisant.
 *
 * **Conséquence à connaître, et assumée : changer `BETTER_AUTH_SECRET` rend les
 * valeurs déjà chiffrées indéchiffrables.** Elles ne sont pas perdues au sens
 * fort — elles sont illisibles, définitivement. Le DAL le rapporte comme un
 * état (« clé illisible, à ressaisir ») et jamais comme une panne : ressaisir la
 * clé API suffit à repartir.
 *
 * Le seuil de qualité du secret est celui de l'authentification
 * (`AUTH_SECRET_MIN_LENGTH`) : un secret trop court ne doit pas devenir
 * acceptable ici alors qu'il est refusé là-bas.
 */

/**
 * La clé de chiffrement de cette installation.
 *
 * Dérivée à chaque appel plutôt que mémorisée : HKDF-SHA256 sur 32 octets ne
 * coûte rien à l'échelle d'une requête, et une clé gardée en variable de module
 * survivrait à un changement de configuration sans qu'on s'en aperçoive.
 *
 * @throws {SecretKeyUnavailableError} si le secret est absent ou trop court.
 */
function installationKey(): Buffer {
  const config = resolveAuthConfig();
  if (config.status !== 'ready') {
    throw new SecretKeyUnavailableError(
      'Chiffrement indisponible : BETTER_AUTH_SECRET est absent ou trop court (openssl rand -base64 32).',
    );
  }
  return deriveSecretKey(config.secret);
}

/**
 * Chiffre une valeur pour la stocker en base.
 *
 * @throws {SecretKeyUnavailableError} plutôt que d'écrire quoi que ce soit sans
 * protection réelle.
 */
export function encryptStoredSecret(plaintext: string): string {
  return sealSecret(plaintext, installationKey());
}

/**
 * Déchiffre une valeur lue en base.
 *
 * @throws {SecretKeyUnavailableError} si l'installation n'a pas de secret.
 * @throws {SecretDecryptionError} si l'enveloppe est mal formée ou n'a pas été
 * produite avec le secret courant.
 */
export function decryptStoredSecret(envelope: string): string {
  return openSecret(envelope, installationKey());
}
