/**
 * Le refus opposé à un appel sans session valide.
 *
 * Un seul texte pour toutes les Server Actions et tous les route handlers : ce
 * qui arrive à l'utilisatrice est toujours le même geste (se reconnecter), et
 * un message par endroit finirait par en dire plus ici que là.
 *
 * **Il ne dit rien de la ressource visée** : ni qu'elle existe, ni qu'elle
 * n'existe pas, ni à qui elle appartient. Un identifiant inventé et un
 * identifiant réel reçoivent la même phrase.
 *
 * Module pur, sans dépendance : les tests des routes le lisent sans avoir à
 * charger le DAL ni better-auth.
 */
export const SESSION_REQUIRED_MESSAGE =
  'Ta session a expiré : reconnecte-toi, puis réessaie.';
