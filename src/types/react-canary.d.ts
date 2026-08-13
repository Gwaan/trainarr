/// <reference types="react/canary" />

// `<ViewTransition>` est exporté par le React embarqué de Next (celui que le
// bundler aliase), mais son typage vit dans `@types/react/canary.d.ts`, qui
// n'est pas actif par défaut. Cette référence l'active pour tout le projet :
// `tsconfig.json` inclut déjà tous les `.ts` de l'arbre, il n'y a donc rien à
// y modifier.
