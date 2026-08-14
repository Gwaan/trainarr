import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Chiffrement authentifié d'un petit secret applicatif (aujourd'hui : la clé API
 * intervals.icu de l'athlète).
 *
 * Fonctions **pures** — elles reçoivent leur clé, ne lisent ni l'environnement
 * ni la base : c'est `app-secret.ts` qui fait le lien avec le secret de
 * l'installation. Aucune dépendance : `node:crypto` fait tout.
 *
 * **AES-256-GCM**, et pas seulement du chiffrement : le mode GCM produit un
 * marqueur d'authenticité (*tag*) que le déchiffrement vérifie. Un octet modifié
 * en base — corruption, bricolage manuel — est donc *refusé*, là où un mode sans
 * authentification (CBC, CTR) rendrait des octets aléatoires que l'appli
 * enverrait tels quels à intervals.icu.
 *
 * **Rien de secret ne sort d'ici par un message d'erreur** : les erreurs disent
 * ce qui a échoué, jamais la valeur, ni la clé, ni le texte chiffré.
 */

/**
 * Marqueur de version, en tête de l'enveloppe **et** en donnée authentifiée
 * additionnelle (AAD). Le tag GCM couvre donc la version : une enveloppe `v1`
 * réétiquetée `v2` ne se déchiffre pas en silence. Changer de format
 * (algorithme, dérivation) veut dire ajouter `v2` et lire les deux.
 */
const VERSION = 'v1';

const ALGORITHM = 'aes-256-gcm';
/** 96 bits : la taille de nonce recommandée pour GCM (NIST SP 800-38D). */
const IV_BYTES = 12;
/** 128 bits : le tag GCM pleine longueur, jamais tronqué. */
const TAG_BYTES = 16;
/** AES-256. */
const KEY_BYTES = 32;

/**
 * Sel et chaîne d'usage de la dérivation HKDF.
 *
 * Le secret d'authentification n'est **jamais** utilisé tel quel comme clé de
 * chiffrement : HKDF-SHA256 en extrait une clé de 32 octets liée à cet usage-là.
 * Deux conséquences voulues — une clé de longueur correcte quelle que soit la
 * forme du secret, et aucune corrélation exploitable entre la signature des
 * sessions et le chiffrement des secrets stockés.
 */
const HKDF_SALT = 'trainarr/secret-box';
const HKDF_INFO = `trainarr/secret-box/aes-256-gcm/${VERSION}`;

/** Le secret de l'installation manque : rien ne doit être chiffré « quand même ». */
export class SecretKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretKeyUnavailableError';
  }
}

/**
 * Pourquoi une enveloppe n'a pas pu être ouverte.
 *
 * - `malformed` : ce n'est pas une enveloppe (préfixe inconnu, base64 illisible,
 *   trop courte pour porter un IV et un tag) ;
 * - `authentication` : l'enveloppe est bien formée mais le tag ne correspond
 *   pas — clé différente (le secret d'authentification a changé) ou contenu
 *   altéré. C'est le cas « clé illisible, ressaisis-la ».
 */
export type SecretDecryptionFailure = 'malformed' | 'authentication';

export class SecretDecryptionError extends Error {
  constructor(readonly reason: SecretDecryptionFailure) {
    super(
      reason === 'malformed'
        ? "Valeur chiffrée illisible : ce n'est pas une enveloppe reconnue."
        : "Valeur chiffrée illisible : elle n'a pas été produite avec le secret courant (BETTER_AUTH_SECRET a changé), ou elle a été altérée.",
    );
    this.name = 'SecretDecryptionError';
  }
}

/**
 * Dérive la clé de chiffrement d'un secret quelconque (HKDF-SHA256).
 *
 * @throws {SecretKeyUnavailableError} si le secret est vide — chiffrer avec une
 * clé dérivée du vide donnerait une protection nulle, en silence.
 */
export function deriveSecretKey(secret: string): Buffer {
  if (secret.trim() === '') {
    throw new SecretKeyUnavailableError(
      'Chiffrement indisponible : aucun secret duquel dériver une clé.',
    );
  }
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

/**
 * Chiffre `plaintext` et rend une **chaîne unique stockable** :
 * `v1:<base64(iv ‖ tag ‖ chiffré)>`.
 *
 * L'IV est tiré au hasard à chaque appel — chiffrer deux fois la même valeur
 * donne deux enveloppes différentes, et réutiliser un nonce en GCM est
 * précisément ce qui casse le mode.
 */
export function sealSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(VERSION, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const envelope = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);

  return `${VERSION}:${envelope.toString('base64')}`;
}

/**
 * Ouvre une enveloppe produite par {@link sealSecret}.
 *
 * @throws {SecretDecryptionError} enveloppe mal formée, ou tag qui ne
 * correspond pas (clé différente ou contenu altéré). Jamais de valeur de retour
 * douteuse : soit le texte d'origine, soit une erreur typée.
 */
export function openSecret(envelope: string, key: Buffer): string {
  const separator = envelope.indexOf(':');
  if (separator === -1 || envelope.slice(0, separator) !== VERSION) {
    throw new SecretDecryptionError('malformed');
  }

  const bytes = Buffer.from(envelope.slice(separator + 1), 'base64');
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new SecretDecryptionError('malformed');

  const iv = bytes.subarray(0, IV_BYTES);
  const tag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = bytes.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(VERSION, 'utf8'));
  decipher.setAuthTag(tag);

  try {
    // `final()` est l'endroit où GCM vérifie le tag : c'est lui qui lève quand
    // la clé n'est pas la bonne ou que les octets ont bougé.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // L'erreur d'origine (« Unsupported state or unable to authenticate data »)
    // n'apprend rien de plus et n'est pas traduite : on rend le cas typé.
    throw new SecretDecryptionError('authentication');
  }
}
