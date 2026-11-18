// Rempli au déploiement. La clé « publishable » est publique par conception :
// toutes les données passent par des fonctions qui vérifient le jeton secret de chaque joueur.
export const CONFIG = {
  supabaseUrl: 'http://localhost:8787',
  supabaseKey: 'local-dev',
  vapidPublic: '',
};
